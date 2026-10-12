import {
  customerHash,
  FaultInjectedError,
  routeOperation,
  withCustomerHash,
  withLoggedWrites,
  withSideEffectLog,
  type FaultController,
  type HttpMetrics,
  type OutboundMetrics,
} from '@otel-demo/telemetry';
import type { Sql } from '@otel-demo/db';
import { OutboundHttpError, isOutboundTimeout } from '@otel-demo/httpkit';
import {
  headerValue,
  inRequest,
  jsonBody,
  markRequestError,
  registerAccessLog,
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
  /** Readiness check; `/ready` answers 503 while it reports the database down. */
  ready?: () => Promise<boolean>;
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
  const sql = options.sql ? withLoggedWrites(options.sql, options.logger) : undefined;
  const repo = options.repo ?? (sql ? createShopRepo(sql) : undefined);
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
          logger: options.logger,
        })
      : undefined);
  const catalog =
    options.catalog ??
    (options.inventoryUrl
      ? createHttpCatalog(options.inventoryUrl, timeoutMs, options.outbound, options.logger)
      : undefined);
  registerAccessLog(app, options.logger);
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
  app.get('/ready', async (_request, reply) => {
    const ok = options.ready ? await options.ready() : true;
    return reply
      .code(ok ? 200 : 503)
      .send({ status: ok ? 'ready' : 'database_unavailable', service: SERVICE_NAME });
  });

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
      const cart = await withCustomerHash(customerHash(customerId), () =>
        repo.createCart(customerId),
      );
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
      const body = jsonBody(request);
      const sku = stringField(body, 'sku');
      const qty = body.qty;
      if (!sku || typeof qty !== 'number' || !Number.isInteger(qty) || qty <= 0) {
        return reply.code(400).send({ error: 'invalid_item' });
      }
      try {
        const cart = await withSideEffectLog(
          options.logger,
          { action: 'add-to-cart' },
          async () => {
            await runFault(options, request, 'add-to-cart');
            let unitPriceCents =
              typeof body.unitPriceCents === 'number' ? body.unitPriceCents : undefined;
            if (catalog) {
              const priced = await catalog.getSku(sku);
              if (!priced) {
                throw new ExpectedItemError('unknown_sku', sku);
              }
              unitPriceCents = priced.priceCents;
            }
            if (
              unitPriceCents === undefined ||
              !Number.isInteger(unitPriceCents) ||
              unitPriceCents < 0
            ) {
              throw new ExpectedItemError('invalid_price');
            }
            const added = await repo.addItem(routeParam(request, 'cartId'), {
              sku,
              qty,
              unitPriceCents,
            });
            if (!added) {
              throw new ExpectedItemError('cart_not_found');
            }
            return added;
          },
          {
            expected: (error) => (error instanceof ExpectedItemError ? error.code : undefined),
          },
        );
        return reply.code(200).send(cart);
      } catch (error) {
        const fault = faultReply(error, reply);
        if (fault) {
          return fault;
        }
        if (error instanceof ExpectedItemError) {
          if (error.code === 'unknown_sku') {
            return reply.code(400).send({ error: 'unknown_sku', sku: error.sku });
          }
          if (error.code === 'invalid_price') {
            return reply.code(400).send({ error: 'invalid_price' });
          }
          return reply.code(404).send({ error: 'cart_not_found' });
        }
        if (error instanceof OutboundHttpError || isOutboundTimeout(error)) {
          markRequestError(request, 'downstream');
          return reply.code(502).send({ error: 'downstream' });
        }
        throw error;
      }
    }),
  );

  app.delete('/carts/:cartId/items/:sku', async (request, reply) =>
    inRequest(request, async () => {
      if (!repo) {
        return reply.code(503).send({ error: 'database_unconfigured' });
      }
      try {
        const cart = await withSideEffectLog(
          options.logger,
          { action: 'remove-from-cart' },
          async () => {
            await runFault(options, request, 'remove-from-cart');
            const removed = await repo.removeItem(
              routeParam(request, 'cartId'),
              routeParam(request, 'sku'),
            );
            if (!removed) {
              throw new ExpectedItemError('cart_not_found');
            }
            return removed;
          },
          {
            expected: (error) => (error instanceof ExpectedItemError ? error.code : undefined),
          },
        );
        return reply.code(200).send(cart);
      } catch (error) {
        const fault = faultReply(error, reply);
        if (fault) {
          return fault;
        }
        if (error instanceof ExpectedItemError) {
          return reply.code(404).send({ error: 'cart_not_found' });
        }
        throw error;
      }
    }),
  );

  app.post('/carts/:cartId/checkout', async (request, reply) =>
    inRequest(request, async () => {
      if (!repo || !downstream) {
        return reply.code(503).send({ error: 'checkout_unconfigured' });
      }
      const idempotencyKey = headerValue(request, 'idempotency-key');
      if (!idempotencyKey) {
        return reply.code(400).send({ error: 'missing_idempotency_key' });
      }
      try {
        const result = await runCheckout(
          repo,
          downstream,
          routeParam(request, 'cartId'),
          idempotencyKey,
          (message) => markRequestError(request, message),
          {
            logger: options.logger,
            before: () => runFault(options, request, 'checkout'),
          },
        );
        return reply.code(result.statusCode).send(result.body);
      } catch (error) {
        const fault = faultReply(error, reply);
        if (fault) {
          return fault;
        }
        throw error;
      }
    }),
  );

  app.get('/orders/:orderId', async (request, reply) =>
    inRequest(request, async () => {
      if (!repo) {
        return reply.code(503).send({ error: 'database_unconfigured' });
      }
      const orderId = routeParam(request, 'orderId');
      try {
        const order = await withSideEffectLog(
          options.logger,
          { action: 'order-status', orderId },
          async () => {
            await runFault(options, request, 'order-status');
            const found = await repo.findOrder(orderId);
            if (!found) {
              throw new ExpectedItemError('not_found');
            }
            return found;
          },
          {
            expected: (error) => (error instanceof ExpectedItemError ? 'not_found' : undefined),
          },
        );
        return reply.code(200).send(order);
      } catch (error) {
        const fault = faultReply(error, reply);
        if (fault) {
          return fault;
        }
        if (error instanceof ExpectedItemError) {
          return reply.code(404).send({ error: 'not_found' });
        }
        throw error;
      }
    }),
  );

  return app;
}

async function runFault(
  options: BuildAppOptions,
  request: FastifyRequest,
  operation: string,
): Promise<void> {
  const span = spanOf(request);
  if (!span || !options.faults) {
    return;
  }
  await options.faults.apply({ service: SERVICE_NAME, operation }, span);
}

function faultReply(error: unknown, reply: FastifyReply): FastifyReply | undefined {
  if (!(error instanceof FaultInjectedError)) {
    return undefined;
  }
  const status = error.faultType === 'timeout' ? 504 : 500;
  return reply.code(status).send({
    error: 'fault',
    faultId: error.faultId,
    faultType: error.faultType,
  });
}

class ExpectedItemError extends Error {
  readonly code: string;
  readonly sku?: string;

  constructor(code: string, sku?: string) {
    super(code);
    this.name = 'ExpectedItemError';
    this.code = code;
    this.sku = sku;
  }
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
