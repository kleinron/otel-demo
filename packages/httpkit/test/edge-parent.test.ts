import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { CartSpanProcessor, createTracePropagator } from '@otel-demo/telemetry';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseTraceparent } from '../src/edge-parent.js';
import { registerSpanLifecycle } from '../src/spans.js';

const exporter = new InMemorySpanExporter();
const CART = '0162f9ee-c52b-458b-8686-9ca884a222b2';
const LG_TRACE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LG_SPAN = 'bbbbbbbbbbbbbbbb';
const CR_TRACE = 'cccccccccccccccccccccccccccccccc';
const CR_SPAN = 'dddddddddddddddd';

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(createTracePropagator());
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({
      sampler: new AlwaysOnSampler(),
      spanProcessors: [new CartSpanProcessor(), new SimpleSpanProcessor(exporter)],
    }),
  );
});
afterAll(() => {
  trace.disable();
  propagation.disable();
  context.disable();
});
beforeEach(() => exporter.reset());

async function call(headers: Record<string, string>) {
  const app = Fastify();
  registerSpanLifecycle(app, 'shop', { edge: true });
  app.get('/carts/:cartId', async () => ({ ok: true }));
  const response = await app.inject({ method: 'GET', url: '/carts/x', headers });
  await app.close();
  const span = exporter.getFinishedSpans().find((s) => s.name === 'GET /carts/:cartId');
  return { response, span };
}

const cloudRun = { traceparent: `00-${CR_TRACE}-${CR_SPAN}-01`, baggage: `cart.id=${CART}` };

describe('edge parent header', () => {
  it('parents on a valid x-otel-demo-parent and keeps cart.id', async () => {
    const { response, span } = await call({
      ...cloudRun,
      'x-otel-demo-parent': `00-${LG_TRACE}-${LG_SPAN}-01`,
    });
    expect(response.statusCode).toBe(200);
    expect(span?.spanContext().traceId).toBe(LG_TRACE);
    expect(span?.parentSpanContext?.spanId).toBe(LG_SPAN);
    expect(span?.links).toHaveLength(0);
    expect(span?.attributes['cart.id']).toBe(CART);
  });

  it('starts a fresh root linked to the Cloud Run context on a malformed header', async () => {
    const { response, span } = await call({ ...cloudRun, 'x-otel-demo-parent': 'garbage-00' });
    expect(response.statusCode).toBe(200);
    expect(span?.parentSpanContext).toBeUndefined();
    expect(span?.spanContext().traceId).not.toBe(CR_TRACE);
    expect(span?.links[0]?.context.spanId).toBe(CR_SPAN);
    expect(span?.attributes['cart.id']).toBe(CART);
  });

  it('starts a fresh root linked to the Cloud Run context when the header is missing', async () => {
    const { response, span } = await call(cloudRun);
    expect(response.statusCode).toBe(200);
    expect(span?.parentSpanContext).toBeUndefined();
    expect(span?.links[0]?.context.traceId).toBe(CR_TRACE);
  });

  it('records the span even when the header says unsampled', async () => {
    const { span } = await call({
      ...cloudRun,
      'x-otel-demo-parent': `00-${LG_TRACE}-${LG_SPAN}-00`,
    });
    expect(span).toBeDefined();
    expect(span?.spanContext().traceFlags & 1).toBe(1);
    expect(span?.parentSpanContext?.spanId).toBe(LG_SPAN);
  });

  it('rejects all-zero and wrong-length traceparents', () => {
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${LG_SPAN}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${LG_TRACE}-${LG_SPAN}-01-extra`)).toBeUndefined();
    expect(parseTraceparent(undefined)).toBeUndefined();
  });
});
