import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgSql, type PoolClientLike, type PoolLike } from '../src/pg.js';

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
afterAll(() => {
  trace.disable();
  context.disable();
});
beforeEach(() => exporter.reset());

function pool(failures: number): PoolLike {
  let left = failures;
  const client: PoolClientLike = {
    async query() {
      return { rows: [] };
    },
    release() {},
  };
  return {
    async connect() {
      if (left > 0) {
        left -= 1;
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      }
      return client;
    },
    on() {},
    async end() {},
  };
}

describe('database spans', () => {
  it('records one query span with a connect child and never the parameter values', async () => {
    const sql = createPgSql('postgres://u:pw@localhost/shop', { createPool: () => pool(0) });
    await sql.query('SELECT * FROM carts WHERE id = $1', ['secret-value-123'], 'get-cart');
    const spans = exporter.getFinishedSpans();
    const query = spans.find((s) => s.name === 'SELECT get-cart');
    const connect = spans.find((s) => s.name === 'db pool connect');
    expect(query?.attributes['db.query.text']).toBe('SELECT * FROM carts WHERE id = $1');
    expect(query?.attributes['db.namespace']).toBe('shop');
    expect(connect?.parentSpanContext?.spanId).toBe(query?.spanContext().spanId);
    expect(JSON.stringify(spans.map((s) => s.attributes))).not.toContain('secret-value-123');
    expect(JSON.stringify(spans.map((s) => s.attributes))).not.toContain('pw');
  });

  it('adds a retry event per retried attempt and records the final exception', async () => {
    const sql = createPgSql('postgres://localhost/shop', {
      createPool: () => pool(5),
      retryAttempts: 2,
      retryBaseDelayMs: 1,
    });
    await expect(sql.query('SELECT 1', [], 'ping')).rejects.toThrow();
    const query = exporter.getFinishedSpans().find((s) => s.name === 'SELECT ping');
    expect(query?.events.filter((e) => e.name === 'db.retry')).toHaveLength(1);
    expect(query?.events.some((e) => e.name === 'exception')).toBe(true);
    expect(query?.status.code).toBe(2);
    const connects = exporter.getFinishedSpans().filter((s) => s.name === 'db pool connect');
    expect(connects).toHaveLength(2);
  });

  it('masks inline literals in the recorded query text', async () => {
    const sql = createPgSql('postgres://localhost/shop', { createPool: () => pool(0) });
    await sql.query("UPDATE t SET a = 'x@y.com', b = 42 WHERE c = $1", [1], 'upd');
    const span = exporter.getFinishedSpans().find((s) => s.name === 'UPDATE upd');
    expect(span?.attributes['db.query.text']).toBe("UPDATE t SET a = '?', b = ? WHERE c = $1");
  });
});
