import {
  context,
  defaultTextMapGetter,
  defaultTextMapSetter,
  type Context,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

const propagator = new W3CTraceContextPropagator();

/** W3C `traceparent` / `tracestate` propagator. B3 and Jaeger are not used. */
export function createTracePropagator(): W3CTraceContextPropagator {
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
