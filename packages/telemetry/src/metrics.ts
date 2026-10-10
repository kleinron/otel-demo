import { type Meter } from '@opentelemetry/api';
import { AggregationType, InstrumentType, type ViewOptions } from '@opentelemetry/sdk-metrics';

/**
 * Inclusive upper bounds, in milliseconds, for p50/p95/p99 on HTTP latency.
 * The 10s, 30s, and 60s buckets keep injected database timeouts (often past 5s)
 * out of the overflow bucket. The percentile helper reports the last finite
 * boundary for overflow, so the top boundary has to sit above those timeouts.
 */
export const HTTP_LATENCY_BUCKET_BOUNDARIES_MS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000,
] as const;

/** Operation label used when a request did not match a route template. */
export const UNMATCHED_ROUTE_OPERATION = 'unmatched';

/**
 * `operation` label for an HTTP metric. Pass the matched route template
 * (`/cart/items/:id`), never the raw request URL. Query strings are stripped.
 * A missing template becomes `unmatched` so a 404 path cannot open a new series.
 */
export function routeOperation(routeTemplate: string | undefined): string {
  if (routeTemplate === undefined) {
    return UNMATCHED_ROUTE_OPERATION;
  }
  const path = routeTemplate.split('?')[0]?.trim() ?? '';
  if (path === '' || path.includes('://')) {
    return UNMATCHED_ROUTE_OPERATION;
  }
  return path;
}

export const HTTP_SERVER_DURATION_METRIC = 'http.server.request.duration';
export const HTTP_SERVER_REQUESTS_METRIC = 'http.server.requests';
export const HTTP_SERVER_ERRORS_METRIC = 'http.server.errors';
export const HTTP_SERVER_BUSINESS_OUTCOMES_METRIC = 'http.server.business_outcomes';

/**
 * Status codes that are business results rather than server failures.
 * Out-of-stock is HTTP 409 and must not be counted as a 5xx.
 */
export const DEFAULT_BUSINESS_OUTCOMES: Readonly<Record<number, string>> = {
  409: 'out_of_stock',
};

export type HttpOutcomeKind = 'success' | 'client_error' | 'business' | 'server_error';

export interface HttpClassification {
  kind: HttpOutcomeKind;
  businessOutcome?: string;
}

export interface HttpObservation {
  operation: string;
  method: string;
  statusCode: number;
  durationMs: number;
  service?: string;
}

export interface HttpMetrics {
  record(observation: HttpObservation): void;
}

export interface HttpMetricsOptions {
  service?: string;
  businessOutcomes?: Readonly<Record<number, string>>;
}

export interface HistogramBuckets {
  boundaries: readonly number[];
  counts: readonly number[];
}

export function classifyHttpStatus(
  statusCode: number,
  businessOutcomes: Readonly<Record<number, string>> = DEFAULT_BUSINESS_OUTCOMES,
): HttpClassification {
  if (statusCode >= 500) {
    return { kind: 'server_error' };
  }
  const businessOutcome = businessOutcomes[statusCode];
  if (businessOutcome) {
    return { kind: 'business', businessOutcome };
  }
  if (statusCode >= 400) {
    return { kind: 'client_error' };
  }
  return { kind: 'success' };
}

export function httpServerDurationView(): ViewOptions {
  return {
    instrumentName: HTTP_SERVER_DURATION_METRIC,
    instrumentType: InstrumentType.HISTOGRAM,
    instrumentUnit: 'ms',
    aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      options: {
        boundaries: [...HTTP_LATENCY_BUCKET_BOUNDARIES_MS],
      },
    },
  };
}

export function createHttpMetrics(meter: Meter, options: HttpMetricsOptions = {}): HttpMetrics {
  const businessOutcomes = options.businessOutcomes ?? DEFAULT_BUSINESS_OUTCOMES;
  const duration = meter.createHistogram(HTTP_SERVER_DURATION_METRIC, {
    description: 'HTTP server latency by operation, in milliseconds, for p50/p95/p99.',
    unit: 'ms',
    advice: {
      explicitBucketBoundaries: [...HTTP_LATENCY_BUCKET_BOUNDARIES_MS],
    },
  });
  const requests = meter.createCounter(HTTP_SERVER_REQUESTS_METRIC, {
    description: 'HTTP server requests.',
  });
  const errors = meter.createCounter(HTTP_SERVER_ERRORS_METRIC, {
    description:
      'HTTP server 5xx responses. Business outcomes such as out-of-stock 409 are excluded.',
  });
  const business = meter.createCounter(HTTP_SERVER_BUSINESS_OUTCOMES_METRIC, {
    description: 'Business outcomes that are not server errors, such as out_of_stock.',
  });

  return {
    record(observation: HttpObservation): void {
      const classification = classifyHttpStatus(observation.statusCode, businessOutcomes);
      const latencyAttributes = {
        service: observation.service ?? options.service ?? 'unknown',
        operation: routeOperation(observation.operation),
        'http.request.method': observation.method,
      };
      duration.record(Math.max(0, observation.durationMs), latencyAttributes);
      const counterAttributes = {
        ...latencyAttributes,
        'http.response.status_code': observation.statusCode,
        outcome: classification.kind,
      };
      requests.add(1, counterAttributes);
      if (classification.kind === 'server_error') {
        errors.add(1, counterAttributes);
      }
      if (classification.kind === 'business' && classification.businessOutcome) {
        business.add(1, {
          ...counterAttributes,
          business_outcome: classification.businessOutcome,
        });
      }
    },
  };
}

/**
 * Estimate a percentile from an explicit-bucket histogram.
 * The result is the inclusive upper bound of the bucket that crosses the percentile.
 * The overflow bucket reports the last finite boundary.
 */
export function estimateHistogramPercentile(
  buckets: HistogramBuckets,
  percentile: number,
): number | undefined {
  if (percentile <= 0 || percentile > 100) {
    throw new Error('percentile must be in the range (0, 100]');
  }
  if (buckets.boundaries.length === 0) {
    return undefined;
  }
  const total = buckets.counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) {
    return undefined;
  }
  const target = (percentile / 100) * total;
  let cumulative = 0;
  for (let index = 0; index < buckets.counts.length; index += 1) {
    cumulative += buckets.counts[index] ?? 0;
    if (cumulative >= target) {
      const boundaryIndex = Math.min(index, buckets.boundaries.length - 1);
      return buckets.boundaries[boundaryIndex];
    }
  }
  return buckets.boundaries[buckets.boundaries.length - 1];
}
