import { createTestSql } from '../../../packages/db/testutil/sql.ts';
import { describe, expect, it } from 'vitest';
import { seedInventory } from '../src/seed.js';
import { buildApp } from '../src/server.js';

describe('inventory reservations', () => {
  it('reserves from a warehouse, is idempotent, releases, and returns 409 when stock is gone', async () => {
    const calls: string[] = [];
    const sql = await createTestSql({
      onCall(event) {
        calls.push(`${event.operation}:${event.outcome}`);
      },
    });
    await seedInventory(sql);
    const app = buildApp({ sql });

    const first = await app.inject({
      method: 'POST',
      url: '/reservations',
      headers: { 'idempotency-key': 'order-1' },
      payload: { orderId: 'order-1', items: [{ sku: 'phone-aurora', qty: 1 }] },
    });
    expect(first.statusCode).toBe(200);
    const reserved = first.json<{ allocations: { warehouseId: string; qty: number }[] }>();
    expect(reserved.allocations).toEqual([
      { sku: 'phone-aurora', warehouseId: 'wh-haifa', qty: 1 },
    ]);

    const replay = await app.inject({
      method: 'POST',
      url: '/reservations',
      headers: { 'idempotency-key': 'order-1' },
      payload: { orderId: 'order-1', items: [{ sku: 'phone-aurora', qty: 1 }] },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());

    const sku = await app.inject({ method: 'GET', url: '/skus/phone-aurora' });
    expect(sku.statusCode).toBe(200);
    expect(sku.json()).toMatchObject({ priceCents: 249900, available: 119 });

    const released = await app.inject({
      method: 'POST',
      url: '/reservations/order-1/release',
    });
    expect(released.statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: '/reservations/order-1/release' });
    expect(again.statusCode).toBe(200);

    const stockout = await app.inject({
      method: 'POST',
      url: '/reservations',
      headers: { 'idempotency-key': 'order-2' },
      payload: { orderId: 'order-2', items: [{ sku: 'powerbank-dead-sea', qty: 2 }] },
    });
    expect(stockout.statusCode).toBe(409);
    expect(stockout.json()).toMatchObject({ error: 'out_of_stock', sku: 'powerbank-dead-sea' });
    expect(calls.some((call) => call.startsWith('stock.reserve:'))).toBe(true);

    await app.close();
    await sql.close();
  });
});
