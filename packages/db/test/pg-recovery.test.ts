import { describe, expect, it } from 'vitest';
import {
  createPgSql,
  isTransientConnectionError,
  TransactionAbortedError,
  type PoolClientLike,
  type PoolLike,
} from '../src/pg.js';

/** A fake pg pool whose database can be stopped and started. */
function fakeDatabase() {
  const state = {
    up: true,
    connects: 0,
    destroyed: 0,
    idle: [] as FakeClient[],
    errorListeners: [] as ((error: Error) => void)[],
  };
  class FakeClient implements PoolClientLike {
    broken = false;
    async query(text: string) {
      if (!state.up || this.broken) {
        this.broken = true;
        throw Object.assign(new Error('Connection terminated unexpectedly'), {});
      }
      return { rows: text.includes('SELECT 1') ? [{ ok: 1 }] : [] };
    }
    release(destroy?: boolean | Error) {
      if (destroy) {
        state.destroyed += 1;
        return;
      }
      state.idle.push(this);
    }
  }
  const pool: PoolLike = {
    async connect() {
      const reused = state.idle.pop();
      if (reused) {
        return reused;
      }
      if (!state.up) {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
          code: 'ECONNREFUSED',
        });
      }
      state.connects += 1;
      return new FakeClient();
    },
    on(_event, listener) {
      state.errorListeners.push(listener);
    },
    async end() {},
  };
  return { state, pool };
}

describe('pg pool recovery', () => {
  it('drops broken clients and recovers on the first query after the database returns', async () => {
    const { state, pool } = fakeDatabase();
    const errors: unknown[] = [];
    const sql = createPgSql('postgres://fake', {
      createPool: () => pool,
      retryAttempts: 3,
      retryBaseDelayMs: 1,
      onConnectionError: (error) => errors.push(error),
    });

    // Warm the pool so an idle client exists, like a long-running service.
    await sql.query('SELECT 1', [], 'ping');
    expect(await sql.ping()).toBe(true);
    expect(state.idle).toHaveLength(1);

    // Database stops: the idle client's socket is dead.
    state.up = false;
    await expect(sql.query('SELECT 1', [], 'delivery.read')).rejects.toSatisfy(
      isTransientConnectionError,
    );
    expect(await sql.ping()).toBe(false);
    expect(state.destroyed).toBeGreaterThanOrEqual(1);
    expect(state.idle).toHaveLength(0); // the dead client was not returned to the pool
    expect(errors.length).toBeGreaterThan(0);

    // Database comes back: the very next query succeeds on a fresh connection.
    state.up = true;
    const before = state.connects;
    await expect(sql.query('SELECT 1', [], 'delivery.read')).resolves.toEqual({
      rows: [{ ok: 1 }],
    });
    expect(state.connects).toBe(before + 1);
    expect(await sql.ping()).toBe(true);
  });

  it('retries a transient failure with backoff and succeeds when the database returns mid-retry', async () => {
    const { state, pool } = fakeDatabase();
    let calls = 0;
    const realConnect = pool.connect.bind(pool);
    pool.connect = async () => {
      calls += 1;
      if (calls === 2) {
        state.up = true; // database comes back during the retry window
      }
      return realConnect();
    };
    state.up = false;
    const sql = createPgSql('postgres://fake', {
      createPool: () => pool,
      retryAttempts: 3,
      retryBaseDelayMs: 1,
    });
    await expect(sql.query('SELECT 1', [], 'delivery.read')).resolves.toEqual({
      rows: [{ ok: 1 }],
    });
    expect(calls).toBe(2);
  });

  it('does not retry non-transient errors or replay a transaction that lost its connection', async () => {
    const { state, pool } = fakeDatabase();
    const sql = createPgSql('postgres://fake', { createPool: () => pool, retryBaseDelayMs: 1 });
    let runs = 0;
    await expect(
      sql.transaction(async (tx) => {
        runs += 1;
        state.up = false;
        await tx.query('INSERT', [], 'delivery.write');
      }),
    ).rejects.toBeInstanceOf(TransactionAbortedError);
    expect(runs).toBe(1);
    expect(isTransientConnectionError(Object.assign(new Error('dup'), { code: '23505' }))).toBe(
      false,
    );
  });
});
