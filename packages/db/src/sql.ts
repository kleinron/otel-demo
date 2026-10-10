export type SqlOutcome = 'success' | 'error' | 'timeout';

export interface SqlCall {
  operation: string;
  outcome: SqlOutcome;
  durationMs: number;
}

export interface SqlOptions {
  timeoutMs?: number;
  onCall?: (event: SqlCall) => void;
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
        const started = performance.now();
        try {
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
      },
      transaction(fn) {
        return inner.transaction(async (tx) => fn(wrap(tx)));
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
