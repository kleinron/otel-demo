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
import { createPaymentRepo, isPaymentStatus, type PaymentRepo } from './repo.js';

export const SERVICE_NAME = 'payment';
export const DEFAULT_PORT = 3003;

export interface BuildAppOptions {
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
  const repo = options.repo ?? (options.sql ? createPaymentRepo(options.sql) : undefined);
  const latencyMs = options.latencyMs ?? 0;
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

  app.post('/charges', async (request, reply) =>
    inRequest(request, async () => {
      if (!repo) {
        return reply.code(503).send({ error: 'database_unconfigured' });
      }
      const fault = await injectFault(options, request, reply, 'charge');
      if (fault) {
        return fault;
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
      const existing = await repo.get(orderId);
      if (existing) {
        options.logger?.info({ orderId, status: existing.status }, 'recorded charge');
        return reply.code(200).send(existing);
      }
      const outcome = body.outcome === undefined ? 'authorized' : body.outcome;
      if (typeof outcome !== 'string' || !isPaymentStatus(outcome) || outcome === 'captured') {
        return reply.code(400).send({ error: 'invalid_outcome' });
      }
      await pause(latencyMs);
      const charge = await repo.create({
        orderId,
        amountCents,
        currency,
        status: outcome,
      });
      options.logger?.info({ orderId, status: charge.status }, 'recorded charge');
      return reply.code(200).send(charge);
    }),
  );

  app.post('/charges/:orderId/capture', async (request, reply) =>
    inRequest(request, async () => {
      if (!repo) {
        return reply.code(503).send({ error: 'database_unconfigured' });
      }
      const fault = await injectFault(options, request, reply, 'capture');
      if (fault) {
        return fault;
      }
      const orderId = routeParam(request, 'orderId');
      const existing = await repo.get(orderId);
      if (!existing) {
        return reply.code(404).send({ error: 'not_found', orderId });
      }
      if (existing.status === 'captured') {
        options.logger?.info({ orderId, status: existing.status }, 'captured charge');
        return reply.code(200).send(existing);
      }
      if (existing.status !== 'authorized') {
        return reply.code(400).send({ error: 'not_capturable', orderId, status: existing.status });
      }
      await pause(latencyMs);
      const captured = await repo.updateStatus(orderId, 'captured');
      options.logger?.info({ orderId, status: 'captured' }, 'captured charge');
      return reply.code(200).send(captured);
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

function pause(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
