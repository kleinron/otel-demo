import { createTestSql } from '../../../packages/db/testutil/sql.ts';
import type { Sql } from '@otel-demo/db';
import { describe, expect, it } from 'vitest';
import { createPaymentRepo } from '../src/repo.js';
import { migratePayment } from '../src/schema.js';
import { buildApp } from '../src/server.js';

describe('payment retry idempotency', () => {
  it('a charge retried after the connection drops post-commit does not double-charge', async () => {
    const base = await createTestSql();
    await migratePayment(base);
    // The first INSERT commits, then the connection "drops" before the reply,
    // which is exactly when the pool retry or the shop's retry would fire.
    let dropped = false;
    const flaky: Sql = {
      ...base,
      async query(text, params, operation) {
        const result = await base.query(text, params, operation);
        if (!dropped && /INSERT INTO charges/.test(text)) {
          dropped = true;
          throw Object.assign(new Error('Connection terminated unexpectedly'), {});
        }
        return result as never;
      },
    };
    const app = buildApp({ sql: flaky });
    const charge = () =>
      app.inject({
        method: 'POST',
        url: '/charges',
        headers: { 'idempotency-key': 'order-retry' },
        payload: { orderId: 'order-retry', amountCents: 1000, currency: 'ILS' },
      });
    const first = await charge();
    expect(first.statusCode).toBeGreaterThanOrEqual(500);
    const retried = await charge();
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ orderId: 'order-retry', amountCents: 1000 });

    const rows = await base.query<{ n: number | string }>(
      "SELECT count(*) AS n FROM charges WHERE order_id = 'order-retry'",
    );
    expect(Number(rows.rows[0]?.n)).toBe(1);

    // Racing duplicate inserts with the same key also collapse to one charge.
    const repo = createPaymentRepo(base);
    const [a, b] = await Promise.all([
      repo.create({ orderId: 'order-race', amountCents: 5, currency: 'ILS', status: 'authorized' }),
      repo.create({ orderId: 'order-race', amountCents: 5, currency: 'ILS', status: 'authorized' }),
    ]);
    expect(a.createdAt).toBe(b.createdAt);
    await app.close();
  });
});
