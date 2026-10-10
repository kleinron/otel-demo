import { Writable } from 'node:stream';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { createLogger } from '@otel-demo/telemetry';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp as buildDelivery } from '../../delivery/src/server.js';
import { buildApp as buildInventory } from '../../inventory/src/server.js';
import { buildApp as buildPayment } from '../../payment/src/server.js';
import { buildApp as buildShop } from '../src/server.js';

beforeAll(() => {
  const manager = new AsyncLocalStorageContextManager();
  manager.enable();
  context.setGlobalContextManager(manager);
  trace.setGlobalTracerProvider(new BasicTracerProvider());
});

describe('access logs', () => {
  it.each([
    ['shop', buildShop, 'GET', '/orders/ord_raw_123', '/orders/:orderId'],
    [
      'inventory',
      buildInventory,
      'POST',
      '/reservations/ord_raw_123/release',
      '/reservations/:orderId/release',
    ],
    ['payment', buildPayment, 'GET', '/charges/ord_raw_123', '/charges/:orderId'],
    ['delivery', buildDelivery, 'GET', '/deliveries/ord_raw_123', '/deliveries/:orderId'],
  ] as const)(
    '%s logs the route template with a trace id and skips /health',
    async (service, build, method, rawPath, template) => {
      const lines: Record<string, unknown>[] = [];
      const app = build({ logger: capture(service, lines) });

      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      expect(lines.filter((line) => line.msg === 'request')).toHaveLength(0);

      const response = await app.inject({ method, url: rawPath });
      expect(response.statusCode).toBe(503);
      const access = lines.filter((line) => line.msg === 'request');
      expect(access).toHaveLength(1);
      expect(access[0]).toMatchObject({
        service,
        route: template,
        method,
        status: 503,
        level: 'info',
      });
      expect(typeof access[0]?.duration_ms).toBe('number');
      expect(access[0]?.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(access[0]?.span_id).toMatch(/^[0-9a-f]{16}$/);
      expect(access[0]?.xray_trace_id).toMatch(/^1-[0-9a-f]{8}-[0-9a-f]{24}$/);
      expect(access[0]?.orderId).toBe('ord_raw_123');
      expect(access[0]?.route).toBe(template);
      expect(String(access[0]?.route)).not.toContain('ord_raw_123');
      expect(access[0]).not.toHaveProperty('body');
      await app.close();
    },
  );
});

function capture(service: string, lines: Record<string, unknown>[]) {
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim() !== '') {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        }
      }
      callback();
    },
  });
  return createLogger({ service, level: 'debug', destination: stream });
}
