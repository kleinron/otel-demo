import { Writable } from 'node:stream';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { createLogger, customerHash } from '@otel-demo/telemetry';
import { createTestSql } from '../../../packages/db/testutil/sql.ts';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedInventory } from '../src/seed.js';
import { buildApp } from '../src/server.js';

const HASH = customerHash('cust-0000');

beforeAll(() => {
  const manager = new AsyncLocalStorageContextManager();
  manager.enable();
  context.setGlobalContextManager(manager);
  trace.setGlobalTracerProvider(new BasicTracerProvider());
});

describe('inventory side-effect logs', () => {
  it('pairs about-to and result lines for reserve, release, and out of stock', async () => {
    const lines: Record<string, unknown>[] = [];
    const sql = await createTestSql();
    await seedInventory(sql);
    const app = buildApp({ sql, logger: capture(lines) });

    const reserved = await app.inject({
      method: 'POST',
      url: '/reservations',
      headers: { 'idempotency-key': 'order-1', 'x-customer-hash': HASH },
      payload: { orderId: 'order-1', items: [{ sku: 'phone-aurora', qty: 1 }] },
    });
    expect(reserved.statusCode).toBe(200);

    const released = await app.inject({ method: 'POST', url: '/reservations/order-1/release' });
    expect(released.statusCode).toBe(200);

    const missing = await app.inject({
      method: 'POST',
      url: '/reservations/order-missing/release',
    });
    expect(missing.statusCode).toBe(404);

    const stockout = await app.inject({
      method: 'POST',
      url: '/reservations',
      headers: { 'idempotency-key': 'order-2', 'x-customer-hash': HASH },
      payload: { orderId: 'order-2', items: [{ sku: 'powerbank-dead-sea', qty: 2 }] },
    });
    expect(stockout.statusCode).toBe(409);

    expectPaired(lines, 'inventory-reserve');
    expectPaired(lines, 'inventory-release');
    expectPaired(lines, 'db-write');
    expect(
      lines.filter((line) => line.action === 'inventory-reserve' && line.outcome === 'success'),
    ).toHaveLength(1);
    expect(
      lines.filter(
        (line) => line.action === 'inventory-reserve' && line.outcome === 'out_of_stock',
      ),
    ).toHaveLength(1);
    expect(
      lines.filter((line) => line.action === 'inventory-release' && line.outcome === 'not_found'),
    ).toHaveLength(1);
    for (const line of lines.filter((entry) => entry.action === 'inventory-reserve')) {
      expect(line.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(line.span_id).toMatch(/^[0-9a-f]{16}$/);
      expect(line.customer_hash).toBe(HASH);
      expect(line.orderId).toMatch(/^order-/);
    }
    const text = JSON.stringify(lines);
    expect(text).not.toContain('SELECT');
    expect(text).not.toContain('UPDATE');
    expect(text).not.toContain('cust-0000');
    expect(text).not.toContain('/health');

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
  return createLogger({ service: 'inventory', level: 'debug', destination: stream });
}
