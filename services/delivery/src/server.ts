import Fastify, { type FastifyInstance } from 'fastify';
import { type HttpMetrics } from '@otel-demo/telemetry';

/** Delivery handoff for orders in handed_to_delivery. Its database will be its own. */
export const SERVICE_NAME = 'delivery';
export const DEFAULT_PORT = 3004;

export interface BuildAppOptions {
  metrics?: HttpMetrics;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  app.addHook('onResponse', async (request, reply) => {
    options.metrics?.record({
      operation: `${request.method} ${request.routeOptions.url ?? 'unmatched'}`,
      method: request.method,
      statusCode: reply.statusCode,
      durationMs: reply.elapsedTime,
      service: SERVICE_NAME,
    });
  });
  app.get('/health', async () => ({ status: 'ok' as const, service: SERVICE_NAME }));
  return app;
}
