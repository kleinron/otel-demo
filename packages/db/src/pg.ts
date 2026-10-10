import { Pool, type PoolClient } from 'pg';
import { createSql, type QueryExecutor, type Sql, type SqlOptions, type SqlRows } from './sql.js';

export function createPgSql(connectionString: string, options: SqlOptions = {}): Sql {
  return createSql(createPgExecutor(connectionString, options.timeoutMs ?? 5_000), options);
}

export async function connectPg(
  connectionString: string,
  options: SqlOptions & { attempts?: number; delayMs?: number } = {},
): Promise<Sql> {
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 500;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const sql = createPgSql(connectionString, options);
    try {
      await sql.query('SELECT 1 AS ok', [], 'ping');
      return sql;
    } catch (error) {
      last = error;
      await sql.close().catch(() => undefined);
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  const message = last instanceof Error ? last.message : 'unknown error';
  throw new Error(`could not connect to the service database: ${message}`);
}

function createPgExecutor(connectionString: string, timeoutMs: number): QueryExecutor {
  const pool = new Pool({
    connectionString,
    max: 5,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
  });
  pool.on('error', () => {
    // Idle client failures surface on the next query.
  });

  function fromClient(client: Pool | PoolClient, close: () => Promise<void>): QueryExecutor {
    return {
      async query<T extends Record<string, unknown>>(
        text: string,
        params: readonly unknown[],
      ): Promise<SqlRows<T>> {
        const result = await client.query(text, params as unknown[]);
        return { rows: result.rows as T[] };
      },
      async transaction<T>(fn: (executor: QueryExecutor) => Promise<T>): Promise<T> {
        if (client !== pool) {
          throw new Error('nested transactions are not supported');
        }
        const checkedOut = await pool.connect();
        const executor = fromClient(checkedOut, async () => undefined);
        try {
          await checkedOut.query('BEGIN');
          const value = await fn(executor);
          await checkedOut.query('COMMIT');
          return value;
        } catch (error) {
          try {
            await checkedOut.query('ROLLBACK');
          } catch {
            // The original error is the one the caller needs.
          }
          throw error;
        } finally {
          checkedOut.release();
        }
      },
      close,
    };
  }

  return fromClient(pool, () => pool.end());
}
