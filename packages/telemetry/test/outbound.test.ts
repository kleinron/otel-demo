import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { describe, expect, it } from 'vitest';
import { createOutboundMetrics, OUTBOUND_CALLS_METRIC, outboundOperation } from '../src/index.js';

describe('outbound metrics', () => {
  it('counts calls by target and outcome and refuses raw URLs', async () => {
    expect(outboundOperation('reserve')).toBe('reserve');
    expect(outboundOperation('http://inventory/reservations/order-1')).toBe('unmatched');

    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const provider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
    });
    const metrics = createOutboundMetrics(provider.getMeter('shop'), { service: 'shop' });
    metrics.record({ target: 'inventory', operation: 'reserve', outcome: 'success' });
    metrics.record({ target: 'database', operation: 'order.write', outcome: 'timeout' });
    metrics.record({ target: 'payment', operation: 'charge', outcome: 'error' });
    await provider.forceFlush();

    const metric = exporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics))
      .find((candidate) => candidate.descriptor.name === OUTBOUND_CALLS_METRIC);
    expect(metric?.dataPointType).toBe(DataPointType.SUM);
    if (!metric || metric.dataPointType !== DataPointType.SUM) {
      throw new Error('missing outbound counter');
    }
    const points = metric.dataPoints.map((point) => ({
      target: point.attributes.target,
      outcome: point.attributes.outcome,
      value: point.value,
    }));
    expect(points).toEqual(
      expect.arrayContaining([
        { target: 'inventory', outcome: 'success', value: 1 },
        { target: 'database', outcome: 'timeout', value: 1 },
        { target: 'payment', outcome: 'error', value: 1 },
      ]),
    );
    await provider.shutdown();
  });
});
