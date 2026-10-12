import { SpanKind, SpanStatusCode, trace, type Span } from '@opentelemetry/api';

const tracer = () => trace.getTracer('@otel-demo/db');

/** Parameterized SQL with any inline literals masked; parameter values are never recorded. */
export function sanitizeSql(text: string): string {
  return text
    .replace(/'(?:[^']|'')*'/g, "'?'")
    .replace(/\b\d+(?:\.\d+)?\b/g, (m, offset: number, all: string) =>
      all[offset - 1] === '$' ? m : '?',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

function sqlVerb(text: string): string {
  return (/^\s*(\w+)/.exec(text)?.[1] ?? 'QUERY').toUpperCase();
}

function failSpan(span: Span, error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error));
  span.recordException(err);
  span.setAttribute('error.type', err.name || 'Error');
  span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
}

export type SqlOutcome = 'success' | 'error' | 'timeout';

export interface SqlCall {
  operation: string;
  outcome: SqlOutcome;
  durationMs: number;
}

export interface SqlOptions {
  timeoutMs?: number;
  onCall?: (event: SqlCall) => void;
  /**
   * Runs before the driver call and outside the statement timeout, so an
   * injected timeout can last longer than the driver's own limit.
   */
  beforeQuery?: (operation: string) => Promise<void>;
  /** `db.namespace` on query spans. */
  dbName?: string;
}

export interface SqlRows<T> {
  rows: T[];
}

export interface Sql {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
    operation?: string,
  ): Promise<SqlRows<T>>;
  transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** A driver-level executor. Metrics and the statement timeout live in {@link createSql}. */
export interface QueryExecutor {
  query<T extends Record<string, unknown>>(
    text: string,
    params: readonly unknown[],
  ): Promise<SqlRows<T>>;
  transaction<T>(fn: (executor: QueryExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class DbTimeoutError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(`database timeout during ${operation}`);
    this.name = 'DbTimeoutError';
    this.operation = operation;
  }
}

export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (code === '23505') {
    return true;
  }
  const message = error instanceof Error ? error.message : '';
  return /duplicate key|unique constraint/i.test(message);
}

export function isDbTimeout(error: unknown): boolean {
  return error instanceof DbTimeoutError;
}

export function asInt(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  throw new Error('expected an integer column');
}

const DEFAULT_TIMEOUT_MS = 5_000;

export function createSql(executor: QueryExecutor, options: SqlOptions = {}): Sql {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function wrap(inner: QueryExecutor): Sql {
    return {
      async query<T extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        params: readonly unknown[] = [],
        operation = 'query',
      ): Promise<SqlRows<T>> {
        const verb = sqlVerb(text);
        return tracer().startActiveSpan(
          `${verb} ${operation}`,
          {
            kind: SpanKind.CLIENT,
            attributes: {
              'db.system.name': 'postgresql',
              'db.operation.name': verb,
              'db.query.summary': operation,
              'db.query.text': sanitizeSql(text),
              ...(options.dbName ? { 'db.namespace': options.dbName } : {}),
            },
          },
          async (span) => {
            try {
              return await runQuery();
            } catch (error) {
              failSpan(span, error);
              throw error;
            } finally {
              span.end();
            }
          },
        );

        async function runQuery(): Promise<SqlRows<T>> {
          const started = performance.now();
          try {
            if (options.beforeQuery) {
              await options.beforeQuery(operation);
            }
            const result = await withTimeout(inner.query<T>(text, params), timeoutMs, operation);
            options.onCall?.({
              operation,
              outcome: 'success',
              durationMs: performance.now() - started,
            });
            return result;
          } catch (error) {
            const timedOut = error instanceof DbTimeoutError || isTimeoutMessage(error);
            options.onCall?.({
              operation,
              outcome: timedOut ? 'timeout' : 'error',
              durationMs: performance.now() - started,
            });
            if (timedOut && !(error instanceof DbTimeoutError)) {
              throw new DbTimeoutError(operation);
            }
            throw error;
          }
        }
      },
      transaction(fn) {
        return tracer().startActiveSpan(
          'db transaction',
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              'db.system.name': 'postgresql',
              ...(options.dbName ? { 'db.namespace': options.dbName } : {}),
            },
          },
          async (span) => {
            try {
              return await inner.transaction(async (tx) => fn(wrap(tx)));
            } catch (error) {
              failSpan(span, error);
              throw error;
            } finally {
              span.end();
            }
          },
        );
      },
      close() {
        return inner.close();
      },
    };
  }

  return wrap(executor);
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return work;
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DbTimeoutError(operation)), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isTimeoutMessage(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /timeout/i.test(error.message);
}
