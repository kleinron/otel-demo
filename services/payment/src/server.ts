import {
  ExpectedSideEffectFailure,
  FaultInjectedError,
  routeOperation,
  withLoggedWrites,
  withSideEffectLog,
  type FaultController,
  type HttpMetrics,
} from '@otel-demo/telemetry';
import type { Sql } from '@otel-demo/db';
import {
  inRequest,
  jsonBody,
  orderIdFrom,
  registerAccessLog,
  registerSpanLifecycle,
  routeParam,
  spanOf,
} from '@otel-demo/httpkit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { createPaymentRepo, isPaymentStatus, type PaymentRepo } from './repo.js';

export const SERVICE_NAME = 'payment';
export const DEFAULT_PORT = 3003;

export interface BuildAppOptions {
  /** Readiness check; `/ready` answers 503 while it reports the database down. */
  ready?: () => Promise<boolean>;
  metrics?: HttpMetrics;
  logger?: Logger;
  sql?: Sql;
  repo?: PaymentRepo;
  faults?: FaultController;
  /** Artificial latency applied when a charge or capture is first recorded. */
  latencyMs?: number;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const sql = options.sql ? withLoggedWrites(options.sql, options.logger) : undefined;
  const repo = options.repo ?? (sql ? createPaymentRepo(sql) : undefined);
  const latencyMs = options.latencyMs ?? 0;
  registerAccessLog(app, options.logger);
  registerSpanLifecycle(app, SERVICE_NAME);
  // Every payment span carries the idempotency key (the order id) it acts on.
  app.addHook('preHandler', async (request) => {
    const key = orderIdFrom(request);
    if (key) {
      spanOf(request)?.setAttribute('payment.idempotency_key', key);
    }
  });
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

  app.post('/charges', async (request, reply) =>
    inRequest(request, async () => {
      if (!repo) {
        return reply.code(503).send({ error: 'database_unconfigured' });
      }
      const body = jsonBody(request);
      const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';
      const amountCents = body.amountCents;
      const currency = typeof body.currency === 'string' ? body.currency.trim() : '';
      if (
        !orderId ||
        typeof amountCents !== 'number' ||
        !Number.isInteger(amountCents) ||
        amountCents < 0
      ) {
        return reply.code(400).send({ error: 'invalid_charge' });
      }
      if (!currency) {
        return reply.code(400).send({ error: 'invalid_charge' });
      }
      try {
        const charge = await withSideEffectLog(
          options.logger,
          { action: 'payment-charge', orderId },
          async () => {
            await runFault(options, request, 'charge');
            const existing = await repo.get(orderId);
            if (existing) {
              if (existing.status === 'declined') {
                throw new ExpectedSideEffectFailure('declined', existing);
              }
              return existing;
            }
            const outcome = body.outcome === undefined ? 'authorized' : body.outcome;
            if (
              typeof outcome !== 'string' ||
              !isPaymentStatus(outcome) ||
              outcome === 'captured'
            ) {
              throw new ExpectedSideEffectFailure('invalid_outcome');
            }
            await pause(latencyMs);
            const created = await repo.create({
              orderId,
              amountCents,
              currency,
              status: outcome,
            });
            if (created.status === 'declined') {
              throw new ExpectedSideEffectFailure('declined', created);
            }
            return created;
          },
        );
        return reply.code(200).send(charge);
      } catch (error) {
        const fault = faultReply(error, reply);
        if (fault) {
          return fault;
        }
        if (error instanceof ExpectedSideEffectFailure && error.outcome === 'declined') {
          return reply.code(200).send(error.result);
        }
        if (error instanceof ExpectedSideEffectFailure && error.outcome === 'invalid_outcome') {
          return reply.code(400).send({ error: 'invalid_outcome' });
        }
        throw error;
      }
    }),
  );

  app.post('/charges/:orderId/capture', async (request, reply) =>
    inRequest(request, async () => {
      if (!repo) {
        return reply.code(503).send({ error: 'database_unconfigured' });
      }
      const orderId = routeParam(request, 'orderId');
      try {
        const captured = await withSideEffectLog(
          options.logger,
          { action: 'payment-capture', orderId },
          async () => {
            await runFault(options, request, 'capture');
            const existing = await repo.get(orderId);
            if (!existing) {
              throw new ExpectedSideEffectFailure('not_found');
            }
            if (existing.status === 'captured') {
              return existing;
            }
            if (existing.status !== 'authorized') {
              throw new ExpectedSideEffectFailure('not_capturable', existing);
            }
            await pause(latencyMs);
            const updated = await repo.updateStatus(orderId, 'captured');
            if (!updated) {
              throw new ExpectedSideEffectFailure('not_found');
            }
            return updated;
          },
        );
        return reply.code(200).send(captured);
      } catch (error) {
        const fault = faultReply(error, reply);
        if (fault) {
          return fault;
        }
        if (error instanceof ExpectedSideEffectFailure && error.outcome === 'not_found') {
          return reply.code(404).send({ error: 'not_found', orderId });
        }
        if (error instanceof ExpectedSideEffectFailure && error.outcome === 'not_capturable') {
          const status =
            error.result && typeof error.result === 'object' && 'status' in error.result
              ? (error.result as { status?: unknown }).status
              : undefined;
          return reply.code(400).send({ error: 'not_capturable', orderId, status });
        }
        throw error;
      }
    }),
  );

  app.get('/charges/:orderId', async (request, reply) =>
    inRequest(request, async () => {
      if (!repo) {
        return reply.code(503).send({ error: 'database_unconfigured' });
      }
      const charge = await repo.get(routeParam(request, 'orderId'));
      if (!charge) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(charge);
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

function pause(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
