import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from '@opentelemetry/api';

/** Mark a span failed and attach the exception as a span event. */
export function recordFailure(span: Span, error: unknown, message?: string): void {
  const err = error instanceof Error ? error : new Error(String(error));
  span.recordException(err);
  span.setAttribute('error.type', err.name || 'Error');
  span.setStatus({ code: SpanStatusCode.ERROR, message: message ?? err.message });
}

/**
 * Run `fn` in its own root span (no parent, no baggage). Background work such
 * as startup, the fault-switch poll, migrations, and pool errors uses this so
 * every log line it writes carries a trace and span id of an exported span.
 */
export async function inRootSpan<T>(
  tracerName: string,
  name: string,
  fn: (span: Span) => Promise<T> | T,
  attributes: Attributes = {},
): Promise<T> {
  const tracer = trace.getTracer(tracerName);
  return tracer.startActiveSpan(
    name,
    { kind: SpanKind.INTERNAL, attributes, root: true },
    ROOT_CONTEXT,
    async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        recordFailure(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/** Synchronous variant for callbacks that cannot await (e.g. an event listener). */
export function inRootSpanSync(
  tracerName: string,
  name: string,
  fn: (span: Span) => void,
  attributes: Attributes = {},
): void {
  const span = trace
    .getTracer(tracerName)
    .startSpan(name, { attributes, root: true }, ROOT_CONTEXT);
  try {
    context.with(trace.setSpan(ROOT_CONTEXT, span), () => fn(span));
  } finally {
    span.end();
  }
}

/** Child span of the active context. */
export async function inChildSpan<T>(
  tracerName: string,
  name: string,
  fn: (span: Span) => Promise<T> | T,
  attributes: Attributes = {},
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<T> {
  return trace.getTracer(tracerName).startActiveSpan(name, { kind, attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      recordFailure(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}
