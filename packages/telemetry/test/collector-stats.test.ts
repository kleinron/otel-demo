import { describe, expect, it } from 'vitest';
import { parseCollectorStats } from '../src/collector-stats.js';

describe('parseCollectorStats', () => {
  it('sums counters across labels and accepts the _total suffix', () => {
    const text = [
      '# HELP otelcol_exporter_sent_spans_total x',
      'otelcol_exporter_sent_spans_total{exporter="googlecloud"} 120',
      'otelcol_exporter_sent_spans{exporter="debug"} 3',
      'otelcol_exporter_send_failed_spans_total{exporter="googlecloud"} 0',
      'otelcol_receiver_refused_spans_total{receiver="otlp",transport="http"} 2',
    ].join('\n');
    const stats = parseCollectorStats(text);
    expect(stats.sentSpans).toBe(123);
    expect(stats.sendFailedSpans).toBe(0);
    expect(stats.refusedSpans).toBe(2);
    expect(stats.droppedSpans).toBe(0);
  });
});
