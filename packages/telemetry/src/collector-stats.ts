import type { Logger } from 'pino';
import { inRootSpan } from './trace-helpers.js';

/** Collector self-metrics that must stay at 0, plus the sent count for context. */
export const COLLECTOR_COUNTERS = {
  sentSpans: 'otelcol_exporter_sent_spans',
  sendFailedSpans: 'otelcol_exporter_send_failed_spans',
  enqueueFailedSpans: 'otelcol_exporter_enqueue_failed_spans',
  refusedSpans: 'otelcol_receiver_refused_spans',
  failedSpans: 'otelcol_receiver_failed_spans',
  droppedSpans: 'otelcol_processor_dropped_spans',
} as const;

export type CollectorStats = Record<keyof typeof COLLECTOR_COUNTERS, number>;

/** Sum each counter (any labels, with or without the `_total` suffix) in Prometheus text. */
export function parseCollectorStats(text: string): CollectorStats {
  const stats = Object.fromEntries(
    Object.keys(COLLECTOR_COUNTERS).map((key) => [key, 0]),
  ) as CollectorStats;
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') {
      continue;
    }
    const match = /^([a-zA-Z_:][\w:]*)(?:\{[^}]*\})?\s+([^\s]+)/.exec(line);
    if (!match) {
      continue;
    }
    const name = (match[1] ?? '').replace(/_total$/, '');
    const value = Number(match[2]);
    for (const [key, metric] of Object.entries(COLLECTOR_COUNTERS)) {
      if (name === metric && Number.isFinite(value)) {
        stats[key as keyof CollectorStats] += value;
      }
    }
  }
  return stats;
}

/**
 * Every `intervalMs`, read the collector sidecar's own metrics and write one
 * `collector self-metrics` log line (in its own span) with the export,
 * drop, and failure counts. One line per minute per instance.
 */
export function startCollectorStats(
  logger: Logger,
  url: string,
  intervalMs = 60_000,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): () => void {
  const poll = (): Promise<void> =>
    inRootSpan('collector-stats', 'collector self-metrics read', async (span) => {
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
        if (!response.ok) {
          throw new Error(`collector metrics returned ${response.status}`);
        }
        const stats = parseCollectorStats(await response.text());
        for (const [key, value] of Object.entries(stats)) {
          span.setAttribute(`otelcol.${key}`, value);
        }
        const bad =
          stats.sendFailedSpans +
          stats.enqueueFailedSpans +
          stats.refusedSpans +
          stats.failedSpans +
          stats.droppedSpans;
        (bad > 0 ? logger.warn.bind(logger) : logger.info.bind(logger))(
          { collector: stats },
          'collector self-metrics',
        );
      } catch (error) {
        logger.warn({ err: error }, 'collector self-metrics unavailable');
      }
    }).catch(() => undefined);
  const timer = setInterval(() => void poll(), intervalMs);
  timer.unref?.();
  void poll();
  return () => clearInterval(timer);
}
