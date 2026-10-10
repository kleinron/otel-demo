import { createTestSql } from '../../../packages/db/testutil/sql.ts';
import { describe, expect, it } from 'vitest';
import { dropPayment, migratePayment } from '../src/schema.js';
import { buildApp } from '../src/server.js';

describe('payment charges', () => {
  it('is idempotent, captures an authorization, and honors a requested outcome', async () => {
    const sql = await createTestSql();
    await migratePayment(sql);
    const app = buildApp({ sql, latencyMs: 30 });

    const started = Date.now();
    const created = await app.inject({
      method: 'POST',
      url: '/charges',
      headers: { 'idempotency-key': 'order-pay' },
      payload: { orderId: 'order-pay', amountCents: 249900, currency: 'ILS' },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ status: 'authorized', amountCents: 249900 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);

    const replay = await app.inject({
      method: 'POST',
      url: '/charges',
      payload: { orderId: 'order-pay', amountCents: 1, currency: 'ILS', outcome: 'declined' },
    });
    expect(replay.json()).toMatchObject({ status: 'authorized', amountCents: 249900 });

    const captured = await app.inject({ method: 'POST', url: '/charges/order-pay/capture' });
    expect(captured.statusCode).toBe(200);
    expect(captured.json()).toMatchObject({ status: 'captured' });
    const capturedAgain = await app.inject({ method: 'POST', url: '/charges/order-pay/capture' });
    expect(capturedAgain.json()).toMatchObject({ status: 'captured' });

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
    expect(declined.json()).toMatchObject({ status: 'declined' });

    const unknown = await app.inject({
      method: 'POST',
      url: '/charges',
      payload: { orderId: 'order-unknown', amountCents: 100, currency: 'ILS', outcome: 'unknown' },
    });
    expect(unknown.json()).toMatchObject({ status: 'unknown' });

    await app.close();
    await sql.close();
  });

  it('rebuilds the charge table when a partial row is already present', async () => {
    const sql = await createTestSql();
    await migratePayment(sql);
    await sql.query(
      `INSERT INTO charges (order_id, amount_cents, currency, status, created_at, updated_at)
       VALUES ('partial', 1, 'ILS', 'unknown', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z')`,
      [],
      'seed',
    );
    await dropPayment(sql);
    await migratePayment(sql);
    const rows = await sql.query('SELECT order_id FROM charges', [], 'charge.read');
    expect(rows.rows).toEqual([]);
    await sql.close();
  });
});
