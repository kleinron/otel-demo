import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  type Span,
} from '@opentelemetry/api';
import { Pool, type PoolConfig } from 'pg';
import { createSql, type QueryExecutor, type Sql, type SqlOptions, type SqlRows } from './sql.js';

/** Pool and recovery settings. Defaults are tuned so a DB blip clears within seconds. */
export interface PgPoolOptions {
  /** Max time to open a new connection before failing fast (default 3s). */
  connectTimeoutMs?: number;
  /** Close idle clients after this long so stale sockets are not reused (default 10s). */
  idleTimeoutMs?: number;
  /** Total attempts for a query that fails with a transient connection error (default 3). */
  retryAttempts?: number;
  /** First backoff delay; doubles per attempt, with jitter (default 100ms). */
  retryBaseDelayMs?: number;
  /** Called when the pool or a query sees a connection-level error. */
  onConnectionError?: (error: unknown) => void;
  /** Test hook: build the pool. */
  createPool?: (config: PoolConfig) => PoolLike;
}

/** The subset of pg.Pool used here, so tests can simulate an outage. */
export interface PoolLike {
  connect(): Promise<PoolClientLike>;
  on(event: 'error', listener: (error: Error) => void): unknown;
  end(): Promise<void>;
}

export interface PoolClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(destroy?: boolean | Error): void;
}

export type PgSqlOptions = SqlOptions & PgPoolOptions;

export interface PgSql extends Sql {
  /** Cheap readiness check: true only if a `SELECT 1` succeeds within the connect timeout. */
  ping(): Promise<boolean>;
}

export function createPgSql(connectionString: string, options: PgSqlOptions = {}): PgSql {
  const executor = createPgExecutor(connectionString, options.timeoutMs ?? 5_000, options);
  const sql = createSql(executor, { dbName: databaseName(connectionString), ...options });
  return { ...sql, ping: executor.ping };
}

export async function connectPg(
  connectionString: string,
  options: PgSqlOptions & { attempts?: number; delayMs?: number } = {},
): Promise<PgSql> {
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 500;
  // One pool for the life of the process. A failed attempt does not poison it:
  // broken clients are destroyed, and the next attempt opens a fresh connection.
  const sql = createPgSql(connectionString, options);
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await sql.query('SELECT 1 AS ok', [], 'ping');
      return sql;
    } catch (error) {
      last = error;
      if (attempt < attempts) {
        await sleep(delayMs);
      }
    }
  }
  await sql.close().catch(() => undefined);
  const message = last instanceof Error ? last.message : 'unknown error';
  throw new Error(`could not connect to the service database: ${message}`);
}

const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now (starting up)
  '53300', // too_many_connections
]);

/** True for errors that mean "the connection is gone or not up yet", not a bad query. */
export function isTransientConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || error instanceof TransactionAbortedError) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && (TRANSIENT_CODES.has(code) || code.startsWith('08'))) {
    return true;
  }
  const message = error instanceof Error ? error.message : '';
  return /connection terminated|terminating connection|connection (?:refused|reset)|server closed the connection|timeout exceeded when trying to connect|client has encountered a connection error|not queryable|socket hang up|the database system is (?:starting up|shutting down)/i.test(
    message,
  );
}

interface PgExecutor extends QueryExecutor {
  ping(): Promise<boolean>;
}

function createPgExecutor(
  connectionString: string,
  timeoutMs: number,
  options: PgPoolOptions,
): PgExecutor {
  const connectTimeoutMs = options.connectTimeoutMs ?? 3_000;
  const attempts = Math.max(1, options.retryAttempts ?? 3);
  const baseDelayMs = options.retryBaseDelayMs ?? 100;
  const config: PoolConfig = {
    connectionString,
    max: 5,
    connectionTimeoutMillis: connectTimeoutMs,
    idleTimeoutMillis: options.idleTimeoutMs ?? 10_000,
    keepAlive: true,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
  };
  const pool: PoolLike = options.createPool ? options.createPool(config) : new Pool(config);
  pool.on('error', (error) => {
    // pg already removes the idle client that emitted this; report it so the
    // outage is visible instead of silently swallowed. Idle-client errors have
    // no request context, so they get their own root span.
    const span = tracer().startSpan('db pool idle-client error', { root: true }, ROOT_CONTEXT);
    failSpan(span, error);
    try {
      context.with(trace.setSpan(ROOT_CONTEXT, span), () => options.onConnectionError?.(error));
    } finally {
      span.end();
    }
  });

  /** `pool.connect()` in its own span: a checkout, which may open a new connection. */
  function connect(): Promise<PoolClientLike> {
    return tracer().startActiveSpan(
      'db pool connect',
      { kind: SpanKind.CLIENT, attributes: { 'db.system.name': 'postgresql' } },
      async (span) => {
        try {
          return await pool.connect();
        } catch (error) {
          failSpan(span, error);
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  /** BEGIN / COMMIT / ROLLBACK each get a span like any other statement. */
  function control(client: PoolClientLike, statement: 'BEGIN' | 'COMMIT' | 'ROLLBACK') {
    return tracer().startActiveSpan(
      statement,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'db.system.name': 'postgresql',
          'db.operation.name': statement,
          'db.query.text': statement,
        },
      },
      async (span) => {
        try {
          return await client.query(statement);
        } catch (error) {
          failSpan(span, error);
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  /** Check out a client, run fn, and destroy the client if its connection broke. */
  async function withClient<T>(fn: (client: PoolClientLike) => Promise<T>): Promise<T> {
    const client = await connect();
    try {
      const value = await fn(client);
      client.release();
      return value;
    } catch (error) {
      // Never hand a broken client back to the pool.
      client.release(isTransientConnectionError(error) ? asError(error) : undefined);
      throw error;
    }
  }

  async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        if (!isTransientConnectionError(error)) {
          throw error;
        }
        options.onConnectionError?.(error);
        const span = trace.getActiveSpan();
        if (attempt >= attempts) {
          span?.addEvent('db.retry.exhausted', { 'db.retry.attempt': attempt });
          throw error;
        }
        const delay = baseDelayMs * 2 ** (attempt - 1);
        span?.addEvent('db.retry', {
          'db.retry.attempt': attempt,
          'db.retry.next_attempt': attempt + 1,
          'error.type': error instanceof Error ? error.name : 'Error',
          'exception.message': error instanceof Error ? error.message : String(error),
        });
        await sleep(delay / 2 + Math.random() * (delay / 2));
      }
    }
  }

  function fromClient(client: PoolClientLike): QueryExecutor {
    return {
      async query<T extends Record<string, unknown>>(text: string, params: readonly unknown[]) {
        const result = await client.query(text, params as unknown[]);
        return { rows: result.rows as T[] };
      },
      async transaction() {
        throw new Error('nested transactions are not supported');
      },
      async close() {},
    };
  }

  return {
    query<T extends Record<string, unknown>>(
      text: string,
      params: readonly unknown[],
    ): Promise<SqlRows<T>> {
      // Writes in this repo carry an idempotency key (orderId / unique keys), so
      // a retry after a dropped connection is safe.
      return withRetry(() =>
        withClient(async (client) => {
          const result = await client.query(text, params as unknown[]);
          return { rows: result.rows as T[] };
        }),
      );
    },
    transaction<T>(fn: (executor: QueryExecutor) => Promise<T>): Promise<T> {
      // Only the connect + BEGIN step is retried; once user work starts, an
      // error propagates so a half-done transaction is never replayed blindly.
      return withRetry(async () => {
        const client = await connect();
        try {
          await control(client, 'BEGIN');
        } catch (error) {
          client.release(asError(error));
          throw error;
        }
        try {
          const value = await fn(fromClient(client));
          await control(client, 'COMMIT');
          client.release();
          return value;
        } catch (error) {
          let broken = isTransientConnectionError(error);
          if (!broken) {
            try {
              await control(client, 'ROLLBACK');
            } catch {
              broken = true;
            }
          }
          client.release(broken ? asError(error) : undefined);
          throw markNonRetryable(error);
        }
      });
    },
    ping() {
      return tracer().startActiveSpan(
        'SELECT ping',
        {
          kind: SpanKind.CLIENT,
          attributes: {
            'db.system.name': 'postgresql',
            'db.operation.name': 'SELECT',
            'db.query.summary': 'ping',
            'db.query.text': 'SELECT 1',
          },
        },
        async (span) => {
          try {
            await withClient((client) => client.query('SELECT 1'));
            return true;
          } catch (error) {
            failSpan(span, error);
            options.onConnectionError?.(error);
            return false;
          } finally {
            span.end();
          }
        },
      );
    },
    close: () => pool.end(),
  };
}

/** Thrown when the connection drops mid-transaction; never retried automatically. */
export class TransactionAbortedError extends Error {
  constructor(override readonly cause: unknown) {
    super('transaction aborted: the database connection was lost');
    this.name = 'TransactionAbortedError';
  }
}

/** A failure inside transaction work must not trigger a replay of the whole transaction. */
function markNonRetryable(error: unknown): unknown {
  return isTransientConnectionError(error) ? new TransactionAbortedError(error) : error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const tracer = () => trace.getTracer('@otel-demo/db');

function failSpan(span: Span, error: unknown): void {
  const err = asError(error);
  span.recordException(err);
  span.setAttribute('error.type', err.name || 'Error');
  span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
}

/** Database name from the URL path, never the credentials. */
function databaseName(connectionString: string): string | undefined {
  try {
    const name = new URL(connectionString).pathname.replace(/^\//, '');
    return name === '' ? undefined : decodeURIComponent(name);
  } catch {
    return undefined;
  }
}
