import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricData,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { describe, expect, it } from 'vitest';
import {
  classifyHttpStatus,
  createHttpMetrics,
  estimateHistogramPercentile,
  HTTP_LATENCY_BUCKET_BOUNDARIES_MS,
  HTTP_SERVER_BUSINESS_OUTCOMES_METRIC,
  HTTP_SERVER_DURATION_METRIC,
  HTTP_SERVER_ERRORS_METRIC,
  HTTP_SERVER_REQUESTS_METRIC,
  httpServerDurationView,
} from '../src/index.js';

describe('HTTP status classification', () => {
  it('treats out-of-stock 409 as a business outcome and 5xx as a server error', () => {
    expect(classifyHttpStatus(200)).toEqual({ kind: 'success' });
    expect(classifyHttpStatus(404)).toEqual({ kind: 'client_error' });
    expect(classifyHttpStatus(409)).toEqual({ kind: 'business', businessOutcome: 'out_of_stock' });
    expect(classifyHttpStatus(500)).toEqual({ kind: 'server_error' });
    expect(classifyHttpStatus(503)).toEqual({ kind: 'server_error' });
  });

  it('does not let a 5xx be reclassified as a business outcome', () => {
    expect(classifyHttpStatus(500, { 500: 'out_of_stock' })).toEqual({ kind: 'server_error' });
  });
});

describe('histogram percentiles', () => {
  it('reads p50, p95, and p99 from explicit buckets', () => {
    const buckets = {
      boundaries: [10, 100, 1000],
      counts: [20, 4, 1, 0],
    };

    expect(estimateHistogramPercentile(buckets, 50)).toBe(10);
    expect(estimateHistogramPercentile(buckets, 95)).toBe(100);
    expect(estimateHistogramPercentile(buckets, 99)).toBe(1000);
    expect(estimateHistogramPercentile({ boundaries: [10], counts: [0, 0] }, 50)).toBeUndefined();
  });
});

describe('HTTP metrics', () => {
  it('records latency per operation and does not count 409 as a server error', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 60_000,
    });
    const provider = new MeterProvider({
      readers: [reader],
      views: [httpServerDurationView()],
    });
    const metrics = createHttpMetrics(provider.getMeter('inventory'), { service: 'inventory' });

    for (let index = 0; index < 20; index += 1) {
      metrics.record({
        operation: 'reserve',
        method: 'POST',
        statusCode: 200,
        durationMs: 10,
        service: 'inventory',
      });
    }
    for (let index = 0; index < 4; index += 1) {
      metrics.record({
        operation: 'reserve',
        method: 'POST',
        statusCode: 409,
        durationMs: 100,
        service: 'inventory',
      });
    }
    metrics.record({
      operation: 'reserve',
      method: 'POST',
      statusCode: 500,
      durationMs: 1000,
      service: 'inventory',
    });
    metrics.record({
      operation: 'GET /health',
      method: 'GET',
      statusCode: 200,
      durationMs: 5,
      service: 'inventory',
    });

    await provider.forceFlush();
    const collected = flatten(exporter.getMetrics());

    const duration = histogram(collected, HTTP_SERVER_DURATION_METRIC);
    const reserve = duration.dataPoints.find((point) => point.attributes.operation === 'reserve');
    const health = duration.dataPoints.find(
      (point) => point.attributes.operation === 'GET /health',
    );

    expect(reserve?.value.buckets.boundaries).toEqual([...HTTP_LATENCY_BUCKET_BOUNDARIES_MS]);
    expect(reserve?.value.count).toBe(25);
    expect(health?.value.count).toBe(1);
    expect(
      estimateHistogramPercentile(reserve?.value.buckets ?? { boundaries: [], counts: [] }, 50),
    ).toBe(10);
    expect(
      estimateHistogramPercentile(reserve?.value.buckets ?? { boundaries: [], counts: [] }, 95),
    ).toBe(100);
    expect(
      estimateHistogramPercentile(reserve?.value.buckets ?? { boundaries: [], counts: [] }, 99),
    ).toBe(1000);

    expect(counterTotal(collected, HTTP_SERVER_REQUESTS_METRIC)).toBe(26);
    expect(counterTotal(collected, HTTP_SERVER_ERRORS_METRIC)).toBe(1);
    expect(
      counterTotal(
        collected,
        HTTP_SERVER_ERRORS_METRIC,
        (attributes) => attributes['http.response.status_code'] === 409,
      ),
    ).toBe(0);
    expect(
      counterTotal(
        collected,
        HTTP_SERVER_BUSINESS_OUTCOMES_METRIC,
        (attributes) => attributes.business_outcome === 'out_of_stock',
      ),
    ).toBe(4);

    await provider.shutdown();
  });
});

function flatten(resourceMetrics: ResourceMetrics[]): MetricData[] {
  return resourceMetrics.flatMap((resource) =>
    resource.scopeMetrics.flatMap((scope) => scope.metrics),
  );
}

function histogram(metrics: MetricData[], name: string) {
  const metric = metrics.find((candidate) => candidate.descriptor.name === name);
  if (!metric || metric.dataPointType !== DataPointType.HISTOGRAM) {
    throw new Error(`missing histogram ${name}`);
  }
  return metric;
}

function counterTotal(
  metrics: MetricData[],
  name: string,
  predicate?: (attributes: Record<string, unknown>) => boolean,
): number {
  const metric = metrics.find((candidate) => candidate.descriptor.name === name);
  if (!metric || metric.dataPointType !== DataPointType.SUM) {
    return 0;
  }
  return metric.dataPoints.reduce((total, point) => {
    const attributes = point.attributes as Record<string, unknown>;
    if (predicate && !predicate(attributes)) {
      return total;
    }
    return total + point.value;
  }, 0);
}
