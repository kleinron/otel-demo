import { describe, expect, it } from 'vitest';
import { createSql, DbTimeoutError, type QueryExecutor, type SqlRows } from '../src/sql.js';

describe('beforeQuery', () => {
  it('records a timeout and does not call the driver', async () => {
    let queries = 0;
    const outcomes: string[] = [];
    const sql = createSql(
      executor(() => {
        queries += 1;
      }),
      {
        timeoutMs: 5_000,
        beforeQuery() {
          return Promise.reject(new Error('database timeout during stock.read'));
        },
        onCall(event) {
          outcomes.push(event.outcome);
        },
      },
    );
    await expect(sql.query('SELECT 1', [], 'stock.read')).rejects.toBeInstanceOf(DbTimeoutError);
    expect(queries).toBe(0);
    expect(outcomes).toEqual(['timeout']);
  });
});

function executor(onQuery: () => void): QueryExecutor {
  return {
    async query<T extends Record<string, unknown>>(): Promise<SqlRows<T>> {
      onQuery();
      return { rows: [] as T[] };
    },
    async transaction(fn) {
      return fn(this);
    },
    async close() {},
  };
}
