import Fastify, { type FastifyInstance } from 'fastify';
import { routeOperation, type HttpMetrics } from '@otel-demo/telemetry';

/** Stock for electronics SKUs. Out of stock will be HTTP 409, a business outcome rather than a server error. Its database will be its own. */
export const SERVICE_NAME = 'inventory';
export const DEFAULT_PORT = 3002;

export interface BuildAppOptions {
  metrics?: HttpMetrics;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
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
  return app;
}
