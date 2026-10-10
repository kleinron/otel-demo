import { createTestSql } from '../../../packages/db/testutil/sql.ts';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';
import { migrateDelivery } from '../src/schema.js';

describe('delivery handoff', () => {
  it('accepts a handoff once and walks packaging then shipping', async () => {
    const sql = await createTestSql();
    await migrateDelivery(sql);
    const app = buildApp({ sql });

    const accepted = await app.inject({
      method: 'POST',
      url: '/handoffs',
      headers: { 'idempotency-key': 'order-ship' },
      payload: { orderId: 'order-ship', city: 'Haifa' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ status: 'accepted', city: 'Haifa' });

    const replay = await app.inject({
      method: 'POST',
      url: '/handoffs',
      payload: { orderId: 'order-ship', city: 'Eilat' },
    });
    expect(replay.json()).toMatchObject({ status: 'accepted', city: 'Haifa' });

    const skip = await app.inject({ method: 'POST', url: '/deliveries/order-ship/ship' });
    expect(skip.statusCode).toBe(400);

    const packaging = await app.inject({
      method: 'POST',
      url: '/deliveries/order-ship/packaging',
    });
    expect(packaging.json()).toMatchObject({ status: 'packaging' });
    const shipped = await app.inject({ method: 'POST', url: '/deliveries/order-ship/ship' });
    expect(shipped.json()).toMatchObject({ status: 'shipped' });
    const shippedAgain = await app.inject({ method: 'POST', url: '/deliveries/order-ship/ship' });
    expect(shippedAgain.json()).toMatchObject({ status: 'shipped' });

    await app.close();
    await sql.close();
  });
});
