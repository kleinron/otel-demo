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
import {
  createInventoryRepo,
  OutOfStockError,
  UnknownSkuError,
  type InventoryRepo,
} from './repo.js';

export const SERVICE_NAME = 'inventory';
export const DEFAULT_PORT = 3002;

export interface BuildAppOptions {
  metrics?: HttpMetrics;
  outbound?: OutboundMetrics;
  logger?: Logger;
  sql?: Sql;
  repo?: InventoryRepo;
  faults?: FaultController;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const repo = options.repo ?? (options.sql ? createInventoryRepo(options.sql) : undefined);
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

  app.post('/reservations', async (request, reply) =>
    inRequest(request, async () => {
      if (!repo) {
        return reply.code(503).send({ error: 'database_unconfigured' });
      }
      const fault = await injectFault(options, request, reply, 'reserve');
      if (fault) {
        return fault;
      }
      const body = jsonBody(request);
      const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';
      const idempotencyKey = headerValue(request, 'idempotency-key');
      if (!orderId || (idempotencyKey && idempotencyKey !== orderId)) {
        return reply.code(400).send({ error: 'invalid_order' });
      }
      const items = readItems(body.items);
      if (!items) {
        return reply.code(400).send({ error: 'invalid_items' });
      }
      try {
        const allocations = await repo.reserve(orderId, items);
        options.logger?.info({ orderId, allocations: allocations.length }, 'reserved stock');
        return reply.code(200).send({ orderId, status: 'reserved', allocations });
      } catch (error) {
        if (error instanceof OutOfStockError) {
          markRequestError(request, 'out_of_stock');
          const span = spanOf(request);
          span?.setAttribute('business.outcome', 'out_of_stock');
          options.logger?.info({ orderId, sku: error.sku }, 'out of stock');
          return reply.code(409).send({ error: 'out_of_stock', sku: error.sku, orderId });
        }
        if (error instanceof UnknownSkuError) {
          return reply.code(400).send({ error: 'unknown_sku', sku: error.sku });
        }
        throw error;
      }
    }),
  );

  app.post('/reservations/:orderId/release', async (request, reply) =>
    inRequest(request, async () => {
      if (!repo) {
        return reply.code(503).send({ error: 'database_unconfigured' });
      }
      const fault = await injectFault(options, request, reply, 'release');
      if (fault) {
        return fault;
      }
      const orderId = routeParam(request, 'orderId');
      const result = await repo.release(orderId);
      if (result === 'missing') {
        return reply.code(404).send({ error: 'not_found', orderId });
      }
      options.logger?.info({ orderId }, 'released stock');
      return reply.code(200).send({ orderId, status: 'released' });
    }),
  );

  app.get('/skus/:sku', async (request, reply) =>
    inRequest(request, async () => {
      if (!repo) {
        return reply.code(503).send({ error: 'database_unconfigured' });
      }
      const sku = await repo.getSku(routeParam(request, 'sku'));
      if (!sku) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(sku);
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

function readItems(value: unknown): { sku: string; qty: number }[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const items: { sku: string; qty: number }[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      return undefined;
    }
    const record = entry as { sku?: unknown; qty?: unknown };
    if (typeof record.sku !== 'string' || record.sku.trim() === '') {
      return undefined;
    }
    if (typeof record.qty !== 'number' || !Number.isInteger(record.qty) || record.qty <= 0) {
      return undefined;
    }
    items.push({ sku: record.sku.trim(), qty: record.qty });
  }
  return items;
}
