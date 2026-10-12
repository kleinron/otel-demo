import {
  context,
  defaultTextMapGetter,
  defaultTextMapSetter,
  type Context,
} from '@opentelemetry/api';
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';

const propagator = new CompositePropagator({
  propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
});

/**
 * W3C `traceparent` / `tracestate` plus W3C `baggage` (for `cart.id`).
 * B3 and Jaeger are not used.
 */
export function createTracePropagator(): CompositePropagator {
  return propagator;
}

export function injectTraceHeaders(
  carrier: Record<string, string> = {},
  ctx: Context = context.active(),
): Record<string, string> {
  propagator.inject(ctx, carrier, defaultTextMapSetter);
  return carrier;
}

export function extractTraceContext(
  carrier: Record<string, string>,
  ctx: Context = context.active(),
): Context {
  return propagator.extract(ctx, carrier, defaultTextMapGetter);
}
