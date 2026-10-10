import { Writable } from 'node:stream';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { createLogger } from '@otel-demo/telemetry';
import { createTestSql } from '../../../packages/db/testutil/sql.ts';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDeliveryRepo } from '../src/repo.js';
import { migrateDelivery } from '../src/schema.js';
import { buildApp } from '../src/server.js';

beforeAll(() => {
  const manager = new AsyncLocalStorageContextManager();
  manager.enable();
  context.setGlobalContextManager(manager);
  trace.setGlobalTracerProvider(new BasicTracerProvider());
});

describe('delivery side-effect logs', () => {
  it('pairs about-to and result lines for handoff and an invalid ship', async () => {
    const lines: Record<string, unknown>[] = [];
    const sql = await createTestSql();
    await migrateDelivery(sql);
    const app = buildApp({ sql, logger: capture(lines) });

    const accepted = await app.inject({
      method: 'POST',
      url: '/handoffs',
      headers: { 'idempotency-key': 'order-ship' },
      payload: { orderId: 'order-ship', city: 'Haifa' },
    });
    expect(accepted.statusCode).toBe(200);

    const skip = await app.inject({ method: 'POST', url: '/deliveries/order-ship/ship' });
    expect(skip.statusCode).toBe(400);

    expectPaired(lines, 'delivery-handoff');
    expectPaired(lines, 'delivery-ship');
    expectPaired(lines, 'db-write');
    expect(
      lines.filter((line) => line.action === 'delivery-handoff' && line.outcome === 'success'),
    ).toHaveLength(1);
    expect(
      lines.filter(
        (line) => line.action === 'delivery-ship' && line.outcome === 'invalid_transition',
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain('INSERT');
    expect(JSON.stringify(lines)).not.toContain('Haifa');
    for (const line of lines.filter((entry) => entry.action === 'delivery-handoff')) {
      expect(line.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(line.span_id).toMatch(/^[0-9a-f]{16}$/);
      expect(line.orderId).toBe('order-ship');
    }

    await app.close();
    await sql.close();
  });

  it('logs an error result when handoff fails unexpectedly', async () => {
    const lines: Record<string, unknown>[] = [];
    const sql = await createTestSql();
    await migrateDelivery(sql);
    const inner = createDeliveryRepo(sql);
    const app = buildApp({
      logger: capture(lines),
      repo: {
        ...inner,
        async accept() {
          throw new Error('database timeout during delivery.write');
        },
      },
    });

    const failed = await app.inject({
      method: 'POST',
      url: '/handoffs',
      payload: { orderId: 'order-down', city: 'Haifa' },
    });
    expect(failed.statusCode).toBe(500);
    const effect = lines.filter((line) => line.action === 'delivery-handoff');
    expect(effect.map((line) => line.msg)).toEqual([
      'about to delivery-handoff',
      'delivery-handoff failed',
    ]);
    expect(effect[1]).toMatchObject({ outcome: 'timeout', level: 'error' });
    expect(typeof effect[1]?.duration_ms).toBe('number');
    expect(JSON.stringify(effect)).not.toContain('delivery.write');

    await app.close();
    await sql.close();
  });
});

function expectPaired(lines: Record<string, unknown>[], action: string): void {
  const about = lines.filter((line) => line.msg === `about to ${action}`);
  const closed = lines.filter(
    (line) =>
      line.action === action &&
      typeof line.outcome === 'string' &&
      typeof line.duration_ms === 'number',
  );
  expect(about.length, action).toBeGreaterThan(0);
  expect(closed.length, action).toBe(about.length);
}

function capture(lines: Record<string, unknown>[]) {
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
  return createLogger({ service: 'delivery', level: 'debug', destination: stream });
}
