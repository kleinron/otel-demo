import type { Sql } from './sql.js';

export interface Readiness {
  /** True once the schema migration has run and a DB ping succeeds right now. */
  ready(): Promise<boolean>;
  /** Resolves when the migration has succeeded (for tests and scripts). */
  migrated: Promise<void>;
  stop(): void;
}

/**
 * Run the schema migration in the background, retrying with capped backoff, so
 * the HTTP server can start (and pass its process-level startup/liveness probe)
 * while the database is still down. Readiness reports not-ready until the
 * migration succeeds and the database answers a ping.
 */
export function migrateInBackground(
  sql: Sql & { ping?: () => Promise<boolean> },
  migrate: (sql: Sql) => Promise<void>,
  options: { onError?: (error: unknown, attempt: number) => void; maxDelayMs?: number } = {},
): Readiness {
  let done = false;
  let stopped = false;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const migrated = (async () => {
    for (let attempt = 1; !stopped; attempt += 1) {
      try {
        await migrate(sql);
        done = true;
        return;
      } catch (error) {
        options.onError?.(error, attempt);
        const delay = Math.min(maxDelayMs, 250 * 2 ** Math.min(attempt - 1, 5));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  })();
  return {
    async ready() {
      if (!done) {
        return false;
      }
      return sql.ping ? sql.ping() : true;
    },
    migrated,
    stop() {
      stopped = true;
    },
  };
}
