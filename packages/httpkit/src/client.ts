import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { injectTraceHeaders, type OutboundMetrics } from '@otel-demo/telemetry';

export class OutboundTimeoutError extends Error {
  readonly target: string;

  constructor(target: string) {
    super(`outbound timeout calling ${target}`);
    this.name = 'OutboundTimeoutError';
    this.target = target;
  }
}

export class OutboundHttpError extends Error {
  readonly target: string;
  readonly status: number;

  constructor(target: string, status: number) {
    super(`outbound call to ${target} returned ${status}`);
    this.name = 'OutboundHttpError';
    this.target = target;
    this.status = status;
  }
}

export function isOutboundTimeout(error: unknown): boolean {
  return error instanceof OutboundTimeoutError;
}

export interface TracedRequest {
  service: string;
  target: string;
  operation: string;
  url: string;
  method: 'GET' | 'POST' | 'DELETE';
  timeoutMs: number;
  body?: unknown;
  headers?: Record<string, string>;
  metrics?: OutboundMetrics;
}

export interface TracedResponse {
  status: number;
  body: unknown;
}

/**
 * Client span plus a W3C `traceparent` header. Uses global fetch so a test can
 * strip `traceparent` on one hop and observe a disconnected trace.
 */
export async function tracedRequest(input: TracedRequest): Promise<TracedResponse> {
  const tracer = trace.getTracer(input.service);
  const span = tracer.startSpan(`HTTP ${input.method} ${input.target}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      'otel-demo.service': input.service,
      'peer.service': input.target,
      'http.request.method': input.method,
      'outbound.operation': input.operation,
    },
  });
  try {
    return await context.with(trace.setSpan(context.active(), span), async () => {
      const headers = injectTraceHeaders({
        accept: 'application/json',
        ...input.headers,
      });
      const hasBody = input.body !== undefined;
      if (hasBody) {
        headers['content-type'] = 'application/json';
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), input.timeoutMs);
      try {
        const response = await globalThis.fetch(input.url, {
          method: input.method,
          headers,
          body: hasBody ? JSON.stringify(input.body) : undefined,
          signal: controller.signal,
        });
        const body = await readBody(response);
        span.setAttribute('http.response.status_code', response.status);
        const outcome = response.status >= 500 ? 'error' : 'success';
        if (response.status >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        input.metrics?.record({
          target: input.target,
          operation: input.operation,
          outcome,
          service: input.service,
        });
        return { status: response.status, body };
      } catch (error) {
        const timedOut = isAbort(error);
        input.metrics?.record({
          target: input.target,
          operation: input.operation,
          outcome: timedOut ? 'timeout' : 'error',
          service: input.service,
        });
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: timedOut ? 'timeout' : 'error',
        });
        if (timedOut) {
          throw new OutboundTimeoutError(input.target);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    });
  } finally {
    span.end();
  }
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === '') {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function isAbort(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}
