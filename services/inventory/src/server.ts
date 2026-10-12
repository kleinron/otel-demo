import {
  FaultInjectedError,
  routeOperation,
  withLoggedWrites,
  withSideEffectLog,
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
  registerAccessLog,
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
  /** Readiness check; `/ready` answers 503 while it reports the database down. */
  ready?: () => Promise<boolean>;
  metrics?: HttpMetrics;
  outbound?: OutboundMetrics;
  logger?: Logger;
  sql?: Sql;
  repo?: InventoryRepo;
  faults?: FaultController;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const sql = options.sql ? withLoggedWrites(options.sql, options.logger) : undefined;
  const repo = options.repo ?? (sql ? createInventoryRepo(sql) : undefined);
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

  app.post('/reservations', async (request, reply) =>
    inRequest(request, async () => {
      if (!repo) {
        return reply.code(503).send({ error: 'database_unconfigured' });
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
        const allocations = await withSideEffectLog(
          options.logger,
          { action: 'inventory-reserve', orderId },
          async () => {
            await runFault(options, request, 'reserve');
            return repo.reserve(orderId, items);
          },
          {
            expected: (error) => {
              if (error instanceof OutOfStockError) {
                return 'out_of_stock';
              }
              if (error instanceof UnknownSkuError) {
                return 'unknown_sku';
              }
              return undefined;
            },
          },
        );
        return reply.code(200).send({ orderId, status: 'reserved', allocations });
      } catch (error) {
        const fault = faultReply(error, reply);
        if (fault) {
          return fault;
        }
        if (error instanceof OutOfStockError) {
          markRequestError(request, 'out_of_stock');
          const span = spanOf(request);
          span?.setAttribute('business.outcome', 'out_of_stock');
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
      const orderId = routeParam(request, 'orderId');
      try {
        const result = await withSideEffectLog(
          options.logger,
          { action: 'inventory-release', orderId },
          async () => {
            await runFault(options, request, 'release');
            return repo.release(orderId);
          },
          {
            verdict: (value) =>
              value === 'missing' ? { level: 'warn', outcome: 'not_found' } : 'success',
          },
        );
        if (result === 'missing') {
          return reply.code(404).send({ error: 'not_found', orderId });
        }
        return reply.code(200).send({ orderId, status: 'released' });
      } catch (error) {
        const fault = faultReply(error, reply);
        if (fault) {
          return fault;
        }
        throw error;
      }
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
