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
  registerAccessLog,
  registerSpanLifecycle,
  routeParam,
  spanOf,
} from '@otel-demo/httpkit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { createDeliveryRepo, nextStatus, type DeliveryRepo, type DeliveryStatus } from './repo.js';

export const SERVICE_NAME = 'delivery';
export const DEFAULT_PORT = 3004;

export interface BuildAppOptions {
  metrics?: HttpMetrics;
  logger?: Logger;
  sql?: Sql;
  repo?: DeliveryRepo;
  faults?: FaultController;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const sql = options.sql ? withLoggedWrites(options.sql, options.logger) : undefined;
  const repo = options.repo ?? (sql ? createDeliveryRepo(sql) : undefined);
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

  app.post('/handoffs', async (request, reply) =>
    inRequest(request, async () => {
      if (!repo) {
        return reply.code(503).send({ error: 'database_unconfigured' });
      }
      const body = jsonBody(request);
      const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';
      const city = typeof body.city === 'string' ? body.city.trim() : '';
      if (!orderId || !city) {
        return reply.code(400).send({ error: 'invalid_handoff' });
      }
      try {
        const delivery = await withSideEffectLog(
          options.logger,
          { action: 'delivery-handoff', orderId },
          async () => {
            await runFault(options, request, 'handoff');
            return repo.accept(orderId, city);
          },
        );
        return reply.code(200).send(delivery);
      } catch (error) {
        const fault = faultReply(error, reply);
        if (fault) {
          return fault;
        }
        throw error;
      }
    }),
  );

  app.post('/deliveries/:orderId/packaging', async (request, reply) =>
    transition(options, repo, request, reply, 'packaging'),
  );

  app.post('/deliveries/:orderId/ship', async (request, reply) =>
    transition(options, repo, request, reply, 'shipped'),
  );

  app.get('/deliveries/:orderId', async (request, reply) =>
    inRequest(request, async () => {
      if (!repo) {
        return reply.code(503).send({ error: 'database_unconfigured' });
      }
      const delivery = await repo.get(routeParam(request, 'orderId'));
      if (!delivery) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(delivery);
    }),
  );

  return app;
}

async function transition(
  options: BuildAppOptions,
  repo: DeliveryRepo | undefined,
  request: FastifyRequest,
  reply: FastifyReply,
  target: DeliveryStatus,
): Promise<FastifyReply> {
  return inRequest(request, async () => {
    if (!repo) {
      return reply.code(503).send({ error: 'database_unconfigured' });
    }
    const operation = target === 'packaging' ? 'packaging' : 'ship';
    const action = target === 'packaging' ? 'delivery-packaging' : 'delivery-ship';
    const orderId = routeParam(request, 'orderId');
    try {
      const updated = await withSideEffectLog(options.logger, { action, orderId }, async () => {
        await runFault(options, request, operation);
        const current = await repo.get(orderId);
        if (!current) {
          throw new ExpectedSideEffectFailure('not_found');
        }
        if (current.status === target || statusAtLeast(current.status, target)) {
          return current;
        }
        if (nextStatus(current.status) !== target) {
          throw new ExpectedSideEffectFailure('invalid_transition', current);
        }
        return repo.transition(orderId, target);
      });
      return reply.code(200).send(updated);
    } catch (error) {
      const fault = faultReply(error, reply);
      if (fault) {
        return fault;
      }
      if (error instanceof ExpectedSideEffectFailure && error.outcome === 'not_found') {
        return reply.code(404).send({ error: 'not_found', orderId });
      }
      if (error instanceof ExpectedSideEffectFailure && error.outcome === 'invalid_transition') {
        const status =
          error.result && typeof error.result === 'object' && 'status' in error.result
            ? (error.result as { status?: unknown }).status
            : undefined;
        return reply.code(400).send({ error: 'invalid_transition', orderId, status, target });
      }
      throw error;
    }
  });
}

function statusAtLeast(current: DeliveryStatus, target: DeliveryStatus): boolean {
  const rank: Record<DeliveryStatus, number> = { accepted: 0, packaging: 1, shipped: 2 };
  return rank[current] > rank[target];
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
