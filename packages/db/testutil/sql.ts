import { PGlite } from '@electric-sql/pglite';
import {
  createSql,
  type QueryExecutor,
  type Sql,
  type SqlOptions,
  type SqlRows,
} from '../src/sql.js';

/** In-process Postgres for tests. The same SQL runs against docker-compose Postgres via DATABASE_URL. */
export async function createTestSql(options: SqlOptions = {}): Promise<Sql> {
  const db = new PGlite();
  await db.waitReady;
  return createSql(pgliteExecutor(db), options);
}

function pgliteExecutor(db: PGlite): QueryExecutor {
  return executorFor(db, () => db.close());
}

function executorFor(
  db: Pick<PGlite, 'query'>,
  close: () => Promise<void>,
  nested = false,
): QueryExecutor {
  return {
    async query<T extends Record<string, unknown>>(
      text: string,
      params: readonly unknown[],
    ): Promise<SqlRows<T>> {
      const result = await db.query<T>(text, [...params]);
      return { rows: result.rows };
    },
    async transaction(fn) {
      if (nested || !isPglite(db)) {
        throw new Error('nested transactions are not supported');
      }
      return db.transaction(async (tx) => fn(executorFor(tx, async () => undefined, true)));
    },
    close,
  };
}

function isPglite(db: Pick<PGlite, 'query'>): db is PGlite {
  return 'transaction' in db && typeof db.transaction === 'function';
}
