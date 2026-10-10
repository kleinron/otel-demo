import { type Meter } from '@opentelemetry/api';

/** Counter for calls this service makes to another service or to its own database. */
export const OUTBOUND_CALLS_METRIC = 'outbound.calls';

export const OUTBOUND_OUTCOMES = ['success', 'error', 'timeout'] as const;

export type OutboundOutcome = (typeof OUTBOUND_OUTCOMES)[number];

export interface OutboundObservation {
  /** `inventory`, `payment`, `delivery`, `shop`, or `database`. */
  target: string;
  outcome: OutboundOutcome;
  /** Logical operation such as `reserve` or `cart.write`. Not a raw URL. */
  operation: string;
  service?: string;
}

export interface OutboundMetrics {
  record(observation: OutboundObservation): void;
}

export interface OutboundMetricsOptions {
  service?: string;
}

/**
 * `operation` label for an outbound call. A URL or query string is collapsed
 * so a path parameter cannot open a new series.
 */
export function outboundOperation(operation: string): string {
  const trimmed = operation.trim();
  if (
    trimmed === '' ||
    trimmed.includes('://') ||
    trimmed.includes('?') ||
    trimmed.includes(' ') ||
    trimmed.includes('/')
  ) {
    return 'unmatched';
  }
  return trimmed;
}

export function createOutboundMetrics(
  meter: Meter,
  options: OutboundMetricsOptions = {},
): OutboundMetrics {
  const calls = meter.createCounter(OUTBOUND_CALLS_METRIC, {
    description:
      'Outbound calls to other services and to the service database, by target and outcome.',
  });
  return {
    record(observation: OutboundObservation): void {
      calls.add(1, {
        service: observation.service ?? options.service ?? 'unknown',
        target: observation.target,
        outcome: observation.outcome,
        operation: outboundOperation(observation.operation),
      });
    },
  };
}
