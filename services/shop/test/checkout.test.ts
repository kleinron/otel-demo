import { OutboundTimeoutError } from '@otel-demo/httpkit';
import { createTestSql } from '../../../packages/db/testutil/sql.ts';
import { describe, expect, it } from 'vitest';
import { customerAt } from '../src/customers.js';
import type { Downstream } from '../src/downstream.js';
import { migrateShop } from '../src/schema.js';
import { buildApp } from '../src/server.js';

describe('shop checkout', () => {
  it('moves cart to handed_to_delivery and retries a timed-out handoff without reserving twice', async () => {
    const sql = await shopSql();
    const calls: string[] = [];
    let handoffs = 0;
    const downstream: Downstream = {
      async reserve(orderId) {
        calls.push(`reserve:${orderId}`);
        return { ok: true };
      },
      async charge() {
        calls.push('charge');
        return { status: 'authorized' };
      },
      async capture() {
        calls.push('capture');
        return { status: 'captured' };
      },
      async handoff() {
        handoffs += 1;
        calls.push('handoff');
        if (handoffs === 1) {
          throw new OutboundTimeoutError('delivery');
        }
        return { status: 'accepted' };
      },
    };
    const app = buildApp({ sql, downstream });
    const cartId = await cartWithItem(app);

    const timedOut = await app.inject({
      method: 'POST',
      url: `/carts/${cartId}/checkout`,
      headers: { 'idempotency-key': 'order-retry' },
    });
    expect(timedOut.statusCode).toBe(504);
    expect(timedOut.json()).toMatchObject({ status: 'delivery_pending', orderId: 'order-retry' });

    const completed = await app.inject({
      method: 'POST',
      url: `/carts/${cartId}/checkout`,
      headers: { 'idempotency-key': 'order-retry' },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({
      status: 'handed_to_delivery',
      orderId: 'order-retry',
      city: customerAt(0).city,
    });
    expect(calls.filter((call) => call.startsWith('reserve:'))).toEqual(['reserve:order-retry']);
    expect(calls.filter((call) => call === 'handoff')).toHaveLength(2);

    const replay = await app.inject({
      method: 'POST',
      url: `/carts/${cartId}/checkout`,
      headers: { 'idempotency-key': 'order-retry' },
    });
    expect(replay.statusCode).toBe(200);
    expect(calls.filter((call) => call.startsWith('reserve:'))).toHaveLength(1);

    const status = await app.inject({ method: 'GET', url: '/orders/order-retry' });
    expect(status.json()).toMatchObject({ status: 'handed_to_delivery' });

    await app.close();
    await sql.close();
  });

  it('returns 409 when inventory is out of stock and does not charge', async () => {
    const sql = await shopSql();
    const calls: string[] = [];
    const downstream: Downstream = {
      async reserve() {
        calls.push('reserve');
        return { ok: false, reason: 'out_of_stock', sku: 'powerbank-dead-sea' };
      },
      async charge() {
        calls.push('charge');
        return { status: 'authorized' };
      },
      async capture() {
        return { status: 'captured' };
      },
      async handoff() {
        return { status: 'accepted' };
      },
    };
    const app = buildApp({ sql, downstream });
    const cartId = await cartWithItem(app, 'powerbank-dead-sea');
    const response = await app.inject({
      method: 'POST',
      url: `/carts/${cartId}/checkout`,
      headers: { 'idempotency-key': 'order-stock' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'out_of_stock', status: 'out_of_stock' });
    expect(calls).toEqual(['reserve']);
    await app.close();
    await sql.close();
  });

  it('adds and removes a cart item', async () => {
    const sql = await shopSql();
    const app = buildApp({ sql });
    const created = await app.inject({
      method: 'POST',
      url: '/carts',
      payload: { customerId: customerAt(0).id },
    });
    expect(created.statusCode).toBe(201);
    const cartId = created.json<{ cartId: string }>().cartId;
    const added = await app.inject({
      method: 'POST',
      url: `/carts/${cartId}/items`,
      payload: { sku: 'phone-aurora', qty: 1, unitPriceCents: 249900 },
    });
    expect(added.json()).toMatchObject({
      items: [{ sku: 'phone-aurora', qty: 1, unitPriceCents: 249900 }],
    });
    const removed = await app.inject({
      method: 'DELETE',
      url: `/carts/${cartId}/items/phone-aurora`,
    });
    expect(removed.json()).toMatchObject({ items: [] });
    await app.close();
    await sql.close();
  });
});

async function shopSql() {
  const sql = await createTestSql();
  await migrateShop(sql);
  const customer = customerAt(0);
  await sql.query(
    'INSERT INTO customers (id, name_en, name_he, city, phone) VALUES ($1, $2, $3, $4, $5)',
    [customer.id, customer.nameEn, customer.nameHe, customer.city, customer.phone],
    'seed',
  );
  return sql;
}

async function cartWithItem(
  app: ReturnType<typeof buildApp>,
  sku = 'phone-aurora',
): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/carts',
    payload: { customerId: customerAt(0).id },
  });
  const cartId = created.json<{ cartId: string }>().cartId;
  const added = await app.inject({
    method: 'POST',
    url: `/carts/${cartId}/items`,
    payload: { sku, qty: 1, unitPriceCents: 100 },
  });
  expect(added.statusCode).toBe(200);
  return cartId;
}
