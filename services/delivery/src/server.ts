import {
  FaultInjectedError,
  routeOperation,
  type FaultController,
  type HttpMetrics,
} from '@otel-demo/telemetry';
import type { Sql } from '@otel-demo/db';
import { inRequest, jsonBody, registerSpanLifecycle, routeParam, spanOf } from '@otel-demo/httpkit';
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
  const repo = options.repo ?? (options.sql ? createDeliveryRepo(options.sql) : undefined);
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
      const fault = await injectFault(options, request, reply, 'handoff');
      if (fault) {
        return fault;
      }
      const body = jsonBody(request);
      const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';
      const city = typeof body.city === 'string' ? body.city.trim() : '';
      if (!orderId || !city) {
        return reply.code(400).send({ error: 'invalid_handoff' });
      }
      const delivery = await repo.accept(orderId, city);
      options.logger?.info({ orderId, status: delivery.status }, 'accepted handoff');
      return reply.code(200).send(delivery);
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
    const fault = await injectFault(options, request, reply, operation);
    if (fault) {
      return fault;
    }
    const orderId = routeParam(request, 'orderId');
    const current = await repo.get(orderId);
    if (!current) {
      return reply.code(404).send({ error: 'not_found', orderId });
    }
    if (current.status === target || statusAtLeast(current.status, target)) {
      return reply.code(200).send(current);
    }
    if (nextStatus(current.status) !== target) {
      return reply
        .code(400)
        .send({ error: 'invalid_transition', orderId, status: current.status, target });
    }
    const updated = await repo.transition(orderId, target);
    options.logger?.info({ orderId, status: target }, 'delivery status changed');
    return reply.code(200).send(updated);
  });
}

function statusAtLeast(current: DeliveryStatus, target: DeliveryStatus): boolean {
  const rank: Record<DeliveryStatus, number> = { accepted: 0, packaging: 1, shipped: 2 };
  return rank[current] > rank[target];
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
