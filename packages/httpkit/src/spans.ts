import {
  context,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
} from '@opentelemetry/api';
import {
  bindRequestLogContext,
  CUSTOMER_HASH_HEADER,
  extractTraceContext,
  logRequest,
  routeOperation,
} from '@otel-demo/telemetry';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';

const spans = new WeakMap<FastifyRequest, Span>();
const contexts = new WeakMap<FastifyRequest, Context>();

export function registerSpanLifecycle(app: FastifyInstance, service: string): void {
  const tracer = trace.getTracer(service);

  app.addHook('onRequest', async (request) => {
    const carrier = headerCarrier(request);
    const parent = extractTraceContext(carrier);
    const route = routeOperation(request.routeOptions.url);
    const span = tracer.startSpan(
      `${request.method} ${route}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          'otel-demo.service': service,
          'http.route': route,
          'http.request.method': request.method,
        },
      },
      parent,
    );
    spans.set(request, span);
    contexts.set(request, trace.setSpan(parent, span));
  });

  app.addHook('onResponse', async (request, reply) => {
    const span = spans.get(request);
    if (!span) {
      return;
    }
    const route = routeOperation(request.routeOptions.url);
    span.updateName(`${request.method} ${route}`);
    span.setAttribute('http.route', route);
    span.setAttribute('http.response.status_code', reply.statusCode);
    if (reply.statusCode >= 500) {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();
    spans.delete(request);
    contexts.delete(request);
  });
}

export function spanOf(request: FastifyRequest): Span | undefined {
  return spans.get(request);
}

export function markRequestError(request: FastifyRequest, message: string): void {
  const span = spans.get(request);
  if (!span) {
    return;
  }
  span.setStatus({ code: SpanStatusCode.ERROR, message });
  span.setAttribute('error.type', message);
}

/**
 * Access line for every matched request except `/health`. Registered before
 * the span-ending hook so the line still sees `trace_id` and `span_id`.
 */
export function registerAccessLog(app: FastifyInstance, logger?: Logger): void {
  if (!logger) {
    return;
  }
  app.addHook('onResponse', async (request, reply) => {
    const route = routeOperation(request.routeOptions.url);
    const path = request.url.split('?')[0] ?? '';
    if (route === '/health' || path === '/health') {
      return;
    }
    const ctx = contexts.get(request);
    const write = () => {
      logRequest(logger, {
        route,
        method: request.method,
        status: reply.statusCode,
        durationMs: reply.elapsedTime,
      });
    };
    if (ctx) {
      context.with(ctx, write);
      return;
    }
    write();
  });
}

/** Run the handler inside the request span so logs and outbound calls stay on the same trace. */
export async function inRequest<T>(request: FastifyRequest, fn: () => Promise<T>): Promise<T> {
  const orderId = orderIdFrom(request);
  const hash = headerValue(request, CUSTOMER_HASH_HEADER);
  const ctx = bindRequestLogContext(contexts.get(request) ?? context.active(), orderId, hash);
  contexts.set(request, ctx);
  return context.with(ctx, async () => {
    const span = spans.get(request);
    if (orderId && span) {
      span.setAttribute('orderId', orderId);
    }
    return fn();
  });
}

export function orderIdFrom(request: FastifyRequest): string | undefined {
  const header = headerValue(request, 'idempotency-key');
  if (header) {
    return header;
  }
  const body = jsonBody(request);
  if (typeof body.orderId === 'string' && body.orderId.trim() !== '') {
    return body.orderId.trim();
  }
  const params = request.params;
  if (params && typeof params === 'object' && 'orderId' in params) {
    const orderId = (params as { orderId?: unknown }).orderId;
    if (typeof orderId === 'string' && orderId.trim() !== '') {
      return orderId.trim();
    }
  }
  return undefined;
}

export function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }
  return undefined;
}

export function jsonBody(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    return {};
  }
  return request.body as Record<string, unknown>;
}

export function routeParam(request: FastifyRequest, name: string): string {
  const params = request.params;
  if (!params || typeof params !== 'object' || !(name in params)) {
    return '';
  }
  const value = (params as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : '';
}

function headerCarrier(request: FastifyRequest): Record<string, string> {
  const carrier: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') {
      carrier[key.toLowerCase()] = value;
    }
  }
  return carrier;
}
