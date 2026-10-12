import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger } from 'pino';
import { outboundOperation } from './outbound.js';
import {
  classifyFailure,
  errorFields,
  ExpectedSideEffectFailure,
  insideSideEffect,
  withSideEffectLog,
} from './side-effect.js';
import { now } from './time.js';

interface SqlLike {
  query(text: string, params?: readonly unknown[], operation?: string): Promise<unknown>;
  transaction<T>(fn: (sql: SqlLike) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const writeScope = new AsyncLocalStorage<true>();

/**
 * Wrap database writes with {@link withSideEffectLog} (`action=db-write`).
 * A transaction is one write. Statements inside it are not logged again.
 * Reads stay quiet unless they fail, which logs one error line with the
 * operation name and no SQL text.
 */
export function withLoggedWrites<T extends SqlLike>(sql: T, logger?: Logger): T {
  if (!logger) {
    return sql;
  }
  return wrap(sql, logger) as T;
}

function wrap(inner: SqlLike, logger: Logger): SqlLike {
  return {
    async query(text, params = [], operation = 'query') {
      if (isWriteOperation(operation) && !writeScope.getStore()) {
        return withSideEffectLog(
          logger,
          { action: 'db-write', operation },
          () => writeScope.run(true, () => inner.query(text, params, operation)),
          { expected: businessOutcome },
        );
      }
      const started = now();
      try {
        return await inner.query(text, params, operation);
      } catch (error) {
        if (!writeScope.getStore() && !insideSideEffect()) {
          const failure = classifyFailure(error);
          logger.error(
            {
              action: 'db-read',
              operation: outboundOperation(operation),
              outcome: failure.outcome,
              duration_ms: Math.max(0, Math.round(now() - started)),
              ...errorFields(error),
            },
            'db-read failed',
          );
        }
        throw error;
      }
    },
    transaction(fn) {
      if (writeScope.getStore()) {
        return inner.transaction((tx) => fn(wrap(tx, logger)));
      }
      return withSideEffectLog(
        logger,
        { action: 'db-write', operation: 'transaction' },
        () => writeScope.run(true, () => inner.transaction((tx) => fn(wrap(tx, logger)))),
        { expected: businessOutcome },
      );
    },
    close() {
      return inner.close();
    },
  };
}

function businessOutcome(error: unknown): string | undefined {
  if (error instanceof ExpectedSideEffectFailure) {
    return error.outcome;
  }
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const name = (error as { name?: unknown }).name;
  if (name === 'OutOfStockError') {
    return 'out_of_stock';
  }
  if (name === 'UnknownSkuError') {
    return 'unknown_sku';
  }
  return undefined;
}

function isWriteOperation(operation: string): boolean {
  return (
    operation.endsWith('.write') || operation.endsWith('.reserve') || operation.endsWith('.release')
  );
}
