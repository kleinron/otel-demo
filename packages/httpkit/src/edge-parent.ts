import {
  isSpanContextValid,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
  type Context,
  type Link,
  type SpanContext,
} from '@opentelemetry/api';

/**
 * Second parent header. Cloud Run's front end rewrites `traceparent` (it
 * inserts its own span), so the loadgen also sends its step span context here
 * in W3C traceparent format. Cloud Run leaves it alone.
 */
export const EDGE_PARENT_HEADER = 'x-otel-demo-parent';

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$/;

/** Parse a W3C traceparent value. `undefined` for anything malformed. */
export function parseTraceparent(value: string | undefined): SpanContext | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = TRACEPARENT.exec(value.trim().toLowerCase());
  if (!match) {
    return undefined;
  }
  const [, version, traceId, spanId, flags] = match;
  if (version === 'ff' || (version === '00' && value.trim().length !== 55)) {
    return undefined;
  }
  const spanContext: SpanContext = {
    traceId: traceId as string,
    spanId: spanId as string,
    traceFlags: Number.parseInt(flags as string, 16) & 0xff,
    isRemote: true,
  };
  return isSpanContextValid(spanContext) ? spanContext : undefined;
}

export interface EdgeParent {
  /** Parent context for the inbound span (baggage always kept). */
  parent: Context;
  /** Links for the inbound span: the Cloud Run trace context on a fresh root. */
  links: Link[];
  /** Whether the span must start a new trace. */
  root: boolean;
  source: 'header' | 'fresh-root';
}

/**
 * Parent selection at the edge (shop): `x-otel-demo-parent` when present and
 * valid (no identity check); otherwise a fresh root span linked to the
 * incoming Cloud Run trace context. Never throws. The sampled flag is forced
 * on, so an unsampled header is still recorded (sampling stays AlwaysOn).
 */
export function edgeParent(extracted: Context, header: string | undefined): EdgeParent {
  try {
    const baggageOnly = trace.deleteSpan(extracted);
    const fromHeader = parseTraceparent(header);
    if (fromHeader) {
      return {
        parent: trace.setSpanContext(baggageOnly, {
          ...fromHeader,
          traceFlags: fromHeader.traceFlags | TraceFlags.SAMPLED,
        }),
        links: [],
        root: false,
        source: 'header',
      };
    }
    const incoming = trace.getSpanContext(extracted);
    return {
      parent: baggageOnly,
      links:
        incoming && isSpanContextValid(incoming)
          ? [{ context: incoming, attributes: { 'link.source': 'cloud-run-traceparent' } }]
          : [],
      root: true,
      source: 'fresh-root',
    };
  } catch {
    return { parent: ROOT_CONTEXT, links: [], root: true, source: 'fresh-root' };
  }
}
