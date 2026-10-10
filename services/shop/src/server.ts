import {
  FaultInjectedError,
  routeOperation,
  type FaultController,
  type HttpMetrics,
  type OutboundMetrics,
} from '@otel-demo/telemetry';
import type { Sql } from '@otel-demo/db';
import {
  headerValue,
  inRequest,
  jsonBody,
  markRequestError,
  registerSpanLifecycle,
  routeParam,
  spanOf,
} from '@otel-demo/httpkit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { runCheckout } from './checkout.js';
import {
  createHttpCatalog,
  createHttpDownstream,
  type Catalog,
  type Downstream,
} from './downstream.js';
import { createShopRepo, type ShopRepo } from './repo.js';

export const SERVICE_NAME = 'shop';
export const DEFAULT_PORT = 3001;

export interface BuildAppOptions {
  metrics?: HttpMetrics;
  outbound?: OutboundMetrics;
  logger?: Logger;
  sql?: Sql;
  repo?: ShopRepo;
  downstream?: Downstream;
  catalog?: Catalog;
  faults?: FaultController;
  inventoryUrl?: string;
  paymentUrl?: string;
  deliveryUrl?: string;
  timeoutMs?: number;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const repo = options.repo ?? (options.sql ? createShopRepo(options.sql) : undefined);
  const timeoutMs = options.timeoutMs ?? 2_000;
  const downstream =
    options.downstream ??
    (options.inventoryUrl && options.paymentUrl && options.deliveryUrl
      ? createHttpDownstream({
          inventoryUrl: options.inventoryUrl,
          paymentUrl: options.paymentUrl,
          deliveryUrl: options.deliveryUrl,
          timeoutMs,
          outbound: options.outbound,
        })
      : undefined);
  const catalog =
    options.catalog ??
    (options.inventoryUrl
      ? createHttpCatalog(options.inventoryUrl, timeoutMs, options.outbound)
      : undefined);
  registerSpanLifecycle(app, SERVICE_NAME);
  app.addHook('onResponse', async (request, reply) => {
    options.metrics?.record({
      operation: routeOperation(request.routeOptions.url),
      method: request.method,
      statusCode: reply.statusCode,
      durationMs: reply.elapsedTime,
      service: SERVICE_NAME,
    });
  });
  app.get('/health', async () => ({ status: 'ok' as const, service: SERVICE_NAME }));

  app.post('/carts', async (request, reply) =>
    inRequest(request, async () => {
      if (!repo) {
        return reply.code(503).send({ error: 'database_unconfigured' });
      }
      const customerId = stringField(jsonBody(request), 'customerId');
      if (!customerId) {
        return reply.code(400).send({ error: 'invalid_customer' });
      }
      const customer = await repo.customer(customerId);
      if (!customer) {
        return reply.code(404).send({ error: 'unknown_customer' });
      }
      const cart = await repo.createCart(customerId);
      return reply.code(201).send(cart);
    }),
  );

  app.get('/carts/:cartId', async (request, reply) =>
    inRequest(request, async () => {
      if (!repo) {
        return reply.code(503).send({ error: 'database_unconfigured' });
      }
      const cart = await repo.getCart(routeParam(request, 'cartId'));
      if (!cart) {
        return reply.code(404).send({ error: 'cart_not_found' });
      }
      return reply.code(200).send(cart);
    }),
  );

  app.post('/carts/:cartId/items', async (request, reply) =>
    inRequest(request, async () => {
      if (!repo) {
        return reply.code(503).send({ error: 'database_unconfigured' });
      }
      const fault = await injectFault(options, request, reply, 'add-to-cart');
      if (fault) {
        return fault;
      }
      const body = jsonBody(request);
      const sku = stringField(body, 'sku');
      const qty = body.qty;
      if (!sku || typeof qty !== 'number' || !Number.isInteger(qty) || qty <= 0) {
        return reply.code(400).send({ error: 'invalid_item' });
      }
      let unitPriceCents =
        typeof body.unitPriceCents === 'number' ? body.unitPriceCents : undefined;
      if (catalog) {
        try {
          const priced = await catalog.getSku(sku);
          if (!priced) {
            return reply.code(400).send({ error: 'unknown_sku', sku });
          }
          unitPriceCents = priced.priceCents;
        } catch {
          markRequestError(request, 'downstream');
          return reply.code(502).send({ error: 'downstream' });
        }
      }
      if (unitPriceCents === undefined || !Number.isInteger(unitPriceCents) || unitPriceCents < 0) {
        return reply.code(400).send({ error: 'invalid_price' });
      }
      const cart = await repo.addItem(routeParam(request, 'cartId'), { sku, qty, unitPriceCents });
      if (!cart) {
        return reply.code(404).send({ error: 'cart_not_found' });
      }
      options.logger?.info({ sku, qty }, 'added cart item');
      return reply.code(200).send(cart);
    }),
  );

  app.delete('/carts/:cartId/items/:sku', async (request, reply) =>
    inRequest(request, async () => {
      if (!repo) {
        return reply.code(503).send({ error: 'database_unconfigured' });
      }
      const fault = await injectFault(options, request, reply, 'remove-from-cart');
      if (fault) {
        return fault;
      }
      const cart = await repo.removeItem(routeParam(request, 'cartId'), routeParam(request, 'sku'));
      if (!cart) {
        return reply.code(404).send({ error: 'cart_not_found' });
      }
      options.logger?.info({ sku: routeParam(request, 'sku') }, 'removed cart item');
      return reply.code(200).send(cart);
    }),
  );

  app.post('/carts/:cartId/checkout', async (request, reply) =>
    inRequest(request, async () => {
      if (!repo || !downstream) {
        return reply.code(503).send({ error: 'checkout_unconfigured' });
      }
      const fault = await injectFault(options, request, reply, 'checkout');
      if (fault) {
        return fault;
      }
      const idempotencyKey = headerValue(request, 'idempotency-key');
      if (!idempotencyKey) {
        return reply.code(400).send({ error: 'missing_idempotency_key' });
      }
      const result = await runCheckout(
        repo,
        downstream,
        routeParam(request, 'cartId'),
        idempotencyKey,
        (message) => markRequestError(request, message),
      );
      if (result.statusCode === 200) {
        options.logger?.info({ orderId: idempotencyKey }, 'checkout completed');
      } else {
        options.logger?.error(
          { orderId: idempotencyKey, error: result.body.error },
          'checkout failed',
        );
      }
      return reply.code(result.statusCode).send(result.body);
    }),
  );

  app.get('/orders/:orderId', async (request, reply) =>
    inRequest(request, async () => {
      if (!repo) {
        return reply.code(503).send({ error: 'database_unconfigured' });
      }
      const fault = await injectFault(options, request, reply, 'order-status');
      if (fault) {
        return fault;
      }
      const order = await repo.findOrder(routeParam(request, 'orderId'));
      if (!order) {
        return reply.code(404).send({ error: 'not_found' });
      }
      options.logger?.info({ orderId: order.orderId, status: order.status }, 'order status');
      return reply.code(200).send(order);
    }),
  );

  return app;
}

async function injectFault(
  options: BuildAppOptions,
  request: FastifyRequest,
  reply: FastifyReply,
  operation: string,
): Promise<FastifyReply | undefined> {
  const span = spanOf(request);
  if (!span || !options.faults) {
    return undefined;
  }
  try {
    await options.faults.apply({ service: SERVICE_NAME, operation }, span);
    return undefined;
  } catch (error) {
    if (!(error instanceof FaultInjectedError)) {
      throw error;
    }
    options.logger?.error({ faultId: error.faultId, faultType: error.faultType }, 'fault injected');
    const status = error.faultType === 'timeout' ? 504 : 500;
    return reply.code(status).send({
      error: 'fault',
      faultId: error.faultId,
      faultType: error.faultType,
    });
  }
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
