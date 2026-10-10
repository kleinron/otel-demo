import { Writable } from 'node:stream';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { createLogger, customerHash } from '@otel-demo/telemetry';
import { createTestSql } from '../../../packages/db/testutil/sql.ts';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp as buildDelivery } from '../../delivery/src/server.js';
import { migrateDelivery } from '../../delivery/src/schema.js';
import { buildApp as buildInventory } from '../../inventory/src/server.js';
import { seedInventory } from '../../inventory/src/seed.js';
import { buildApp as buildPayment } from '../../payment/src/server.js';
import { migratePayment } from '../../payment/src/schema.js';
import { customerAt } from '../src/customers.js';
import { seedShop } from '../src/seed.js';
import { buildApp as buildShop } from '../src/server.js';

const lines: Record<string, unknown>[] = [];
const customer = customerAt(0);
const hash = customerHash(customer.id);

describe('shop side-effect logs', () => {
  let shopUrl = '';
  const apps: FastifyInstance[] = [];
  const closers: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    const manager = new AsyncLocalStorageContextManager();
    manager.enable();
    context.setGlobalContextManager(manager);
    trace.setGlobalTracerProvider(new BasicTracerProvider());

    const shopSql = await createTestSql();
    const inventorySql = await createTestSql();
    const paymentSql = await createTestSql();
    const deliverySql = await createTestSql();
    closers.push(
      () => shopSql.close(),
      () => inventorySql.close(),
      () => paymentSql.close(),
      () => deliverySql.close(),
    );
    await seedShop(shopSql);
    await seedInventory(inventorySql);
    await migratePayment(paymentSql);
    await migrateDelivery(deliverySql);

    const inventory = buildInventory({ sql: inventorySql, logger: serviceLogger('inventory') });
    const payment = buildPayment({
      sql: paymentSql,
      logger: serviceLogger('payment'),
      latencyMs: 0,
    });
    const delivery = buildDelivery({ sql: deliverySql, logger: serviceLogger('delivery') });
    const inventoryUrl = await listen(inventory);
    const paymentUrl = await listen(payment);
    const deliveryUrl = await listen(delivery);
    const shop = buildShop({
      sql: shopSql,
      logger: serviceLogger('shop'),
      inventoryUrl,
      paymentUrl,
      deliveryUrl,
      timeoutMs: 2_000,
    });
    shopUrl = await listen(shop);
    apps.push(shop, inventory, payment, delivery);
  }, 30_000);

  afterAll(async () => {
    for (const app of apps) {
      await app.close();
    }
    for (const close of closers) {
      await close();
    }
  });

  it('pairs every checkout side effect and keeps one trace id', async () => {
    lines.length = 0;
    const cartId = await cartWith('phone-aurora', 1);
    const response = await fetch(`${shopUrl}/carts/${cartId}/checkout`, {
      method: 'POST',
      headers: { 'idempotency-key': 'order-log-ok' },
    });
    expect(response.status).toBe(200);

    for (const action of [
      'checkout',
      'inventory-reserve',
      'payment-charge',
      'payment-capture',
      'delivery-handoff',
      'db-write',
    ]) {
      expectPaired(lines, action);
    }
    expect(outcome('shop', 'checkout', 'success')).toBe(1);
    expect(outcome('shop', 'inventory-reserve', 'success')).toBe(1);
    expect(outcome('inventory', 'inventory-reserve', 'success')).toBe(1);
    expect(outcome('payment', 'payment-charge', 'success')).toBe(1);
    expect(outcome('payment', 'payment-capture', 'success')).toBe(1);
    expect(outcome('delivery', 'delivery-handoff', 'success')).toBe(1);

    const traceIds = lines
      .filter((line) => line.orderId === 'order-log-ok' && typeof line.trace_id === 'string')
      .map((line) => String(line.trace_id));
    expect(traceIds.length).toBeGreaterThan(0);
    expect(new Set(traceIds).size).toBe(1);
    const checkout = lines.find(
      (line) => line.service === 'shop' && line.action === 'checkout' && line.outcome === 'success',
    );
    expect(checkout).toMatchObject({ customer_hash: hash, orderId: 'order-log-ok' });
    expect(typeof checkout?.duration_ms).toBe('number');
    expect(checkout?.trace_id).toBe(traceIds[0]);
    expect(checkout?.span_id).toMatch(/^[0-9a-f]{16}$/);

    const text = JSON.stringify(lines);
    expect(text).not.toContain(customer.id);
    expect(text).not.toContain(customer.phone);
    expect(text).not.toContain(customer.nameEn);
    expect(text).not.toContain('SELECT');
    expect(text).not.toContain('INSERT');
  });

  it('warns when inventory is out of stock and still closes the side effect', async () => {
    lines.length = 0;
    const cartId = await cartWith('powerbank-dead-sea', 2);
    const response = await fetch(`${shopUrl}/carts/${cartId}/checkout`, {
      method: 'POST',
      headers: { 'idempotency-key': 'order-log-stock' },
    });
    expect(response.status).toBe(409);
    expectPaired(lines, 'inventory-reserve');
    expectPaired(lines, 'checkout');
    expect(outcome('shop', 'inventory-reserve', 'out_of_stock')).toBe(1);
    expect(outcome('inventory', 'inventory-reserve', 'out_of_stock')).toBe(1);
    expect(outcome('shop', 'checkout', 'out_of_stock')).toBe(1);
    expect(outcome('shop', 'payment-charge', 'success')).toBe(0);
  });

  async function cartWith(sku: string, qty: number): Promise<string> {
    const created = await fetch(`${shopUrl}/carts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customerId: customer.id }),
    });
    expect(created.status).toBe(201);
    const cartId = ((await created.json()) as { cartId: string }).cartId;
    const added = await fetch(`${shopUrl}/carts/${cartId}/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sku, qty }),
    });
    expect(added.status).toBe(200);
    return cartId;
  }
});

function outcome(service: string, action: string, result: string): number {
  return lines.filter(
    (line) => line.service === service && line.action === action && line.outcome === result,
  ).length;
}

function expectPaired(all: Record<string, unknown>[], action: string): void {
  const about = all.filter((line) => line.msg === `about to ${action}`);
  const closed = all.filter(
    (line) =>
      line.action === action &&
      typeof line.outcome === 'string' &&
      typeof line.duration_ms === 'number',
  );
  expect(about.length, action).toBeGreaterThan(0);
  expect(closed.length, action).toBe(about.length);
}

function serviceLogger(service: string) {
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

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: 'localhost' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP port');
  }
  return `http://localhost:${address.port}`;
}
