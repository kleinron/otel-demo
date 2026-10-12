import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { CompositePropagator } from '@opentelemetry/core';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { createTracePropagator, extractTraceContext, injectTraceHeaders } from '../src/index.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';

describe('W3C traceparent propagation', () => {
  it('uses the W3C trace-context and baggage propagators', () => {
    expect(createTracePropagator()).toBeInstanceOf(CompositePropagator);
    expect(createTracePropagator().fields()).toEqual(['traceparent', 'tracestate', 'baggage']);
  });

  it('extracts and injects a traceparent header', () => {
    const extracted = extractTraceContext(
      { traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` },
      ROOT_CONTEXT,
    );
    const parent = trace.getSpan(extracted)?.spanContext();

    expect(parent?.traceId).toBe(TRACE_ID);
    expect(parent?.spanId).toBe(SPAN_ID);

    const carrier = injectTraceHeaders({}, extracted);
    expect(carrier.traceparent).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
  });

  it('injects the active span as a traceparent header', () => {
    const provider = new BasicTracerProvider({
      idGenerator: {
        generateTraceId: () => TRACE_ID,
        generateSpanId: () => SPAN_ID,
      },
    });
    const span = provider.getTracer('test').startSpan('checkout');
    const carrier = injectTraceHeaders({}, trace.setSpan(ROOT_CONTEXT, span));

    expect(carrier.traceparent).toMatch(new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`));
    span.end();
  });
});
