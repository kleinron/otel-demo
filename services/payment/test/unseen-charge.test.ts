import { createTestSql } from '../../../packages/db/testutil/sql.ts';
import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { migratePayment } from '../src/schema.js';
import { buildApp, UNSEEN_CHARGE_MESSAGE } from '../src/server.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      done();
    },
  });
  return { lines, logger: pino({ level: 'info' }, stream) };
}

const slowFaults = {
  async pollOnce() {},
  start() {},
  stop() {},
  isActive: () => true,
  async apply() {
    await new Promise((resolve) => setTimeout(resolve, 300));
  },
};

async function post(url: string, orderId: string, timeoutMs: number) {
  return fetch(`${url}/charges`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': orderId },
    body: JSON.stringify({ orderId, amountCents: 100, currency: 'ILS' }),
    signal: AbortSignal.timeout(timeoutMs),
  }).then(
    (r) => r.status,
    () => 'aborted' as const,
  );
}

describe('late authorized charge', () => {
  it('logs one line when the caller gave up before the charge was authorized', async () => {
    const sql = await createTestSql();
    await migratePayment(sql);
    const { lines, logger } = capture();
    const app = buildApp({ sql, logger, faults: slowFaults as never });
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    expect(await post(url, 'order-late', 50)).toBe('aborted');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await post(url, 'order-ok', 5_000)).toBe(200);
    await app.close();
    const late = lines.filter((l) => l.msg === UNSEEN_CHARGE_MESSAGE);
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({
      orderId: 'order-late',
      payment_status: 'authorized',
      outcome: 'abandoned',
    });
  });
});
