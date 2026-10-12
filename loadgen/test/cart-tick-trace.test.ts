import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { createTracePropagator } from '@otel-demo/telemetry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCart } from '../src/cart-tick.js';

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(createTracePropagator());
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
afterAll(() => {
  trace.disable();
  propagation.disable();
  context.disable();
});

describe('loadgen step spans', () => {
  it('emits one root span per shopper step and propagates it with cart.id', async () => {
    const sent: Record<string, string>[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      sent.push(init.headers as Record<string, string>);
      const status = url.endsWith('/carts') ? 201 : 200;
      return new Response(JSON.stringify({ cartId: 'c1' }), { status });
    }) as unknown as typeof globalThis.fetch;
    const logs: Record<string, unknown>[] = [];
    const result = await runCart({
      shopUrl: 'http://shop',
      carts: 1,
      spacingMs: 0,
      skus: ['a'],
      customerCount: 10,
      fetch,
      random: () => 0,
      log: (e) => logs.push(e),
      projectId: 'otel-demo-gcp',
    });
    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual([
      'cart open-cart',
      'cart browse',
      'cart add-to-cart',
      'cart checkout',
      'cart close',
    ]);
    expect(spans.every((s) => s.parentSpanContext === undefined)).toBe(true);
    expect(spans.every((s) => s.attributes['cart.id'] === result.cartId)).toBe(true);
    expect(sent.every((h) => h['x-otel-demo-parent'] === h.traceparent)).toBe(true);
    expect(sent.every((h) => h.traceparent && h.baggage === `cart.id=${result.cartId}`)).toBe(true);
    expect(logs.every((l) => typeof l['logging.googleapis.com/spanId'] === 'string')).toBe(true);
  });

  it('makes a checkout retry its own trace, linked to the failed attempt', async () => {
    exporter.reset();
    let checkouts = 0;
    const fetch = (async (url: string) => {
      if (url.endsWith('/checkout')) {
        checkouts += 1;
        return new Response('{}', { status: checkouts === 1 ? 503 : 201 });
      }
      const status = url.endsWith('/carts') ? 201 : 200;
      return new Response(JSON.stringify({ cartId: 'c1' }), { status });
    }) as unknown as typeof globalThis.fetch;
    await runCart({
      shopUrl: 'http://shop',
      carts: 1,
      spacingMs: 0,
      skus: ['a'],
      customerCount: 10,
      fetch,
      random: () => 0,
      log: () => undefined,
    });
    const spans = exporter.getFinishedSpans();
    const [first, retry] = spans.filter((s) => s.name === 'cart checkout');
    expect(retry?.spanContext().traceId).not.toBe(first?.spanContext().traceId);
    expect(retry?.links[0]?.context.spanId).toBe(first?.spanContext().spanId);
    expect(retry?.attributes['retry.previous_trace_id']).toBe(first?.spanContext().traceId);
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(spans.length);
  });
});
