import type { Logger } from 'pino';

/** One access line. `route` is the template (`/orders/:orderId`), never the raw path. */
export function logRequest(
  logger: Logger,
  event: { route: string; method: string; status: number; durationMs: number },
): void {
  logger.info(
    {
      route: event.route,
      method: event.method,
      status: event.status,
      duration_ms: Math.max(0, Math.round(event.durationMs)),
    },
    'request',
  );
}
