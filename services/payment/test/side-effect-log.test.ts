import { Writable } from 'node:stream';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { createLogger } from '@otel-demo/telemetry';
import { createTestSql } from '../../../packages/db/testutil/sql.ts';
import { beforeAll, describe, expect, it } from 'vitest';
import { migratePayment } from '../src/schema.js';
import { buildApp } from '../src/server.js';

beforeAll(() => {
  const manager = new AsyncLocalStorageContextManager();
  manager.enable();
  context.setGlobalContextManager(manager);
  trace.setGlobalTracerProvider(new BasicTracerProvider());
});

describe('payment side-effect logs', () => {
  it('pairs about-to and result lines for charge, capture, and a decline', async () => {
    const lines: Record<string, unknown>[] = [];
    const sql = await createTestSql();
    await migratePayment(sql);
    const app = buildApp({ sql, logger: capture(lines), latencyMs: 0 });

    const created = await app.inject({
      method: 'POST',
      url: '/charges',
      headers: { 'idempotency-key': 'order-pay' },
      payload: { orderId: 'order-pay', amountCents: 100, currency: 'ILS' },
    });
    expect(created.statusCode).toBe(200);

    const captured = await app.inject({ method: 'POST', url: '/charges/order-pay/capture' });
    expect(captured.statusCode).toBe(200);

    const declined = await app.inject({
      method: 'POST',
      url: '/charges',
      payload: {
        orderId: 'order-declined',
        amountCents: 100,
        currency: 'ILS',
        outcome: 'declined',
      },
    });
    expect(declined.statusCode).toBe(200);
    expect(declined.json()).toMatchObject({ status: 'declined' });

    const missing = await app.inject({ method: 'POST', url: '/charges/missing-order/capture' });
    expect(missing.statusCode).toBe(404);

    expectPaired(lines, 'payment-charge');
    expectPaired(lines, 'payment-capture');
    expectPaired(lines, 'db-write');
    expect(
      lines.filter((line) => line.action === 'payment-charge' && line.outcome === 'success'),
    ).toHaveLength(1);
    expect(
      lines.filter((line) => line.action === 'payment-charge' && line.outcome === 'declined'),
    ).toHaveLength(1);
    expect(
      lines.filter((line) => line.action === 'payment-capture' && line.outcome === 'success'),
    ).toHaveLength(1);
    expect(
      lines.filter((line) => line.action === 'payment-capture' && line.outcome === 'not_found'),
    ).toHaveLength(1);
    for (const line of lines.filter((entry) => String(entry.action).startsWith('payment-'))) {
      expect(line.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(line.span_id).toMatch(/^[0-9a-f]{16}$/);
      expect(
        typeof line.duration_ms === 'number' || line.msg === `about to ${String(line.action)}`,
      ).toBe(true);
    }
    expect(JSON.stringify(lines)).not.toContain('INSERT');
    expect(JSON.stringify(lines)).not.toContain('SELECT');

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
  return createLogger({ service: 'payment', level: 'debug', destination: stream });
}
