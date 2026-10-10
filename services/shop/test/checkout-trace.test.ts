import { Writable } from 'node:stream';
import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  createFaultController,
  createLogger,
  FAULT_ID_ATTRIBUTE,
  FAULT_INJECTED_ATTRIBUTE,
  FAULT_TYPE_ATTRIBUTE,
  type OutboundMetrics,
} from '@otel-demo/telemetry';
import { createTestSql } from '../../../packages/db/testutil/sql.ts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { buildApp as buildDelivery } from '../../delivery/src/server.js';
import { migrateDelivery } from '../../delivery/src/schema.js';
import { buildApp as buildInventory } from '../../inventory/src/server.js';
import { seedInventory } from '../../inventory/src/seed.js';
import { buildApp as buildPayment } from '../../payment/src/server.js';
import { migratePayment } from '../../payment/src/schema.js';
import { customerAt } from '../src/customers.js';
import { seedShop } from '../src/seed.js';
import { buildApp as buildShop } from '../src/server.js';

const HOPS = ['inventory', 'payment', 'delivery'] as const;
type Hop = (typeof HOPS)[number];

describe('connected checkout trace', () => {
  const exporter = new InMemorySpanExporter();
  const logs: Record<string, unknown>[] = [];
  const outbound: { target: string; outcome: string }[] = [];
  const outboundMetrics: OutboundMetrics = {
    record(event) {
      outbound.push({ target: event.target, outcome: event.outcome });
    },
  };
  let faultsEnabled = false;
  let shopUrl = '';
  let ports: Record<Hop, number> = { inventory: 0, payment: 0, delivery: 0 };
  const apps: FastifyInstance[] = [];
  const closers: Array<() => Promise<void>> = [];
  let restoreFetch: (() => void) | undefined;
  let refreshFaults: () => Promise<void> = async () => undefined;

  beforeAll(async () => {
    currentExporter = exporter;
    currentLogs = logs;
    const manager = new AsyncLocalStorageContextManager();
    manager.enable();
    context.setGlobalContextManager(manager);
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);

    const shopSql = await createTestSql({ onCall: recordDatabase });
    const inventorySql = await createTestSql({ onCall: recordDatabase });
    const paymentSql = await createTestSql({ onCall: recordDatabase });
    const deliverySql = await createTestSql({ onCall: recordDatabase });
    closers.push(
      () => shopSql.close(),
      () => inventorySql.close(),
      () => paymentSql.close(),
      () => deliverySql.close(),
    );
    await seedShop(shopSql);
    await seedInventory(inventorySql);
    await migratePayment(paymentSql);
    await migrateDelivery(deliverySql);

    const controller = createFaultController({
      schedule: {
        faults: [
          {
            id: 'inventory-reserve-error',
            type: 'error',
            service: 'inventory',
            operation: 'reserve',
          },
        ],
        windowStartMs: Date.now() - 60_000,
        windowEndMs: Date.now() + 10 * 60_000,
      },
      reader: {
        async read() {
          return faultsEnabled;
        },
      },
    });
    await controller.pollOnce();
    refreshFaults = () => controller.pollOnce();

    const inventory = buildInventory({
      sql: inventorySql,
      logger: serviceLogger('inventory'),
      faults: controller,
      outbound: outboundMetrics,
    });
    const payment = buildPayment({
      sql: paymentSql,
      logger: serviceLogger('payment'),
      faults: controller,
      latencyMs: 0,
    });
    const delivery = buildDelivery({
      sql: deliverySql,
      logger: serviceLogger('delivery'),
      faults: controller,
    });
    const inventoryUrl = await listen(inventory);
    const paymentUrl = await listen(payment);
    const deliveryUrl = await listen(delivery);
    ports = {
      inventory: portOf(inventoryUrl),
      payment: portOf(paymentUrl),
      delivery: portOf(deliveryUrl),
    };
    const shop = buildShop({
      sql: shopSql,
      logger: serviceLogger('shop'),
      faults: controller,
      outbound: outboundMetrics,
      inventoryUrl,
      paymentUrl,
      deliveryUrl,
      timeoutMs: 2_000,
    });
    shopUrl = await listen(shop);
    apps.push(shop, inventory, payment, delivery);
  }, 30_000);

  afterEach(async () => {
    restoreFetch?.();
    restoreFetch = undefined;
    exporter.reset();
    logs.length = 0;
    outbound.length = 0;
    faultsEnabled = false;
    await refreshFaults();
  });

  afterAll(async () => {
    for (const app of apps) {
      await app.close();
    }
    for (const close of closers) {
      await close();
    }
  });

  it('records one trace across shop, inventory, payment, and delivery', async () => {
    const { cartId, orderId } = await checkoutCart('phone-aurora', 1, 'order-connected');
    const response = await postCheckout(cartId, orderId);
    expect(response.status).toBe(200);
    await settle();

    const root = checkoutSpan();
    expect(root, spanSummary()).toBeDefined();
    const traceId = root?.spanContext().traceId ?? '';
    expectConnected(exporter.getFinishedSpans(), traceId);
    expect(parentLinked(exporter.getFinishedSpans(), traceId, 'inventory')).toBe(true);
    expect(parentLinked(exporter.getFinishedSpans(), traceId, 'payment')).toBe(true);
    expect(parentLinked(exporter.getFinishedSpans(), traceId, 'delivery')).toBe(true);

    for (const service of ['shop', 'inventory', 'payment', 'delivery']) {
      const ids = traceIdsFor(service, orderId);
      expect(ids.length, `${service} logs`).toBeGreaterThan(0);
      expect(new Set(ids), `${service} logs`).toEqual(new Set([traceId]));
    }
    expect(outbound.map((event) => event.target)).toEqual(
      expect.arrayContaining(['inventory', 'payment', 'delivery', 'database']),
    );
  });

  it('marks an out-of-stock checkout as an error trace', async () => {
    const { cartId, orderId } = await checkoutCart('powerbank-dead-sea', 2, 'order-stockout');
    const response = await postCheckout(cartId, orderId);
    expect(response.status).toBe(409);
    await settle();
    const root = checkoutSpan();
    expect(root?.status.code).toBe(SpanStatusCode.ERROR);
    const traceId = root?.spanContext().traceId ?? '';
    const spans = exporter
      .getFinishedSpans()
      .filter((span) => span.spanContext().traceId === traceId);
    expect(spans.some((span) => span.attributes['error.type'] === 'out_of_stock')).toBe(true);
    expect(spans.some((span) => span.attributes[FAULT_INJECTED_ATTRIBUTE] === true)).toBe(false);
  });

  it('records fault attributes and error status when a fault fails checkout', async () => {
    faultsEnabled = true;
    await refreshFaults();
    const { cartId, orderId } = await checkoutCart('phone-aurora', 1, 'order-fault');
    const response = await postCheckout(cartId, orderId);
    expect(response.status).toBe(502);
    await settle();
    const root = checkoutSpan();
    expect(root?.status.code).toBe(SpanStatusCode.ERROR);
    const traceId = root?.spanContext().traceId ?? '';
    const faulted = exporter
      .getFinishedSpans()
      .filter((span) => span.attributes[FAULT_INJECTED_ATTRIBUTE] === true);
    expect(faulted.length).toBeGreaterThan(0);
    expect(faulted.every((span) => span.spanContext().traceId === traceId)).toBe(true);
    expect(faulted.some((span) => span.status.code === SpanStatusCode.ERROR)).toBe(true);
    expect(
      faulted.some((span) =>
        arrayAttr(span, FAULT_ID_ATTRIBUTE).includes('inventory-reserve-error'),
      ),
    ).toBe(true);
    expect(faulted.some((span) => arrayAttr(span, FAULT_TYPE_ATTRIBUTE).includes('error'))).toBe(
      true,
    );
    expect(new Set(traceIdsFor('shop', orderId))).toEqual(new Set([traceId]));
    expect(new Set(traceIdsFor('inventory', orderId))).toEqual(new Set([traceId]));
  });

  it.each(HOPS)('is no longer one trace when traceparent is dropped on shop -> %s', async (hop) => {
    const { cartId, orderId } = await checkoutCart('phone-aurora', 1, `order-drop-${hop}`);
    restoreFetch = stripTraceparent(ports[hop]);
    const response = await postCheckout(cartId, orderId);
    expect(response.status, await response.clone().text()).toBe(200);
    await settle();

    const root = checkoutSpan();
    const traceId = root?.spanContext().traceId ?? '';
    const spans = exporter.getFinishedSpans();
    expect(connectedServices(spans, traceId).has('shop')).toBe(true);
    expect(connectedServices(spans, traceId).has(hop)).toBe(false);
    expect(() => expectConnected(spans, traceId)).toThrow();

    const downstream = spans.filter(
      (span) => span.kind === SpanKind.SERVER && span.attributes['otel-demo.service'] === hop,
    );
    expect(downstream.length).toBeGreaterThan(0);
    expect(downstream.every((span) => span.spanContext().traceId !== traceId)).toBe(true);
    const downstreamLogs = traceIdsFor(hop, orderId);
    expect(downstreamLogs.length).toBeGreaterThan(0);
    expect(downstreamLogs.every((id) => id !== traceId)).toBe(true);
    expect(traceIdsFor('shop', orderId)).toEqual([traceId]);
  });

  async function checkoutCart(sku: string, qty: number, orderId: string) {
    const created = await fetch(`${shopUrl}/carts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customerId: customerAt(0).id }),
    });
    expect(created.status).toBe(201);
    const cartId = ((await created.json()) as { cartId: string }).cartId;
    const added = await fetch(`${shopUrl}/carts/${cartId}/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sku, qty }),
    });
    expect(added.status, await added.clone().text()).toBe(200);
    exporter.reset();
    logs.length = 0;
    outbound.length = 0;
    return { cartId, orderId };
  }

  function postCheckout(cartId: string, orderId: string) {
    return fetch(`${shopUrl}/carts/${cartId}/checkout`, {
      method: 'POST',
      headers: { 'idempotency-key': orderId },
    });
  }

  function serviceLogger(service: string) {
    return createLogger({ service, destination: logStream() });
  }

  function logStream() {
    return new Writable({
      write(chunk, _encoding, callback) {
        const text = chunk.toString();
        for (const line of text.split('\n')) {
          if (line.trim() === '') {
            continue;
          }
          logs.push(JSON.parse(line) as Record<string, unknown>);
        }
        callback();
      },
    });
  }

  function recordDatabase(event: { outcome: string }) {
    outbound.push({ target: 'database', outcome: event.outcome });
  }
});

function expectConnected(spans: ReadableSpan[], traceId: string): void {
  expect(connectedServices(spans, traceId)).toEqual(
    new Set(['shop', 'inventory', 'payment', 'delivery']),
  );
}

function connectedServices(spans: ReadableSpan[], traceId: string): Set<string> {
  return new Set(
    spans
      .filter((span) => span.spanContext().traceId === traceId && span.kind === SpanKind.SERVER)
      .map((span) => String(span.attributes['otel-demo.service'])),
  );
}

function parentLinked(spans: ReadableSpan[], traceId: string, service: string): boolean {
  const parents = new Set(
    spans
      .filter(
        (span) =>
          span.spanContext().traceId === traceId && span.attributes['otel-demo.service'] === 'shop',
      )
      .map((span) => span.spanContext().spanId),
  );
  return spans.some((span) => {
    const parent = span.parentSpanContext?.spanId;
    return (
      span.kind === SpanKind.SERVER &&
      span.attributes['otel-demo.service'] === service &&
      span.spanContext().traceId === traceId &&
      parent !== undefined &&
      parents.has(parent)
    );
  });
}

function checkoutSpan(): ReadableSpan | undefined {
  return exporterSpans().find(
    (span) =>
      span.kind === SpanKind.SERVER &&
      span.attributes['otel-demo.service'] === 'shop' &&
      span.attributes['http.route'] === '/carts/:cartId/checkout',
  );
}

function exporterSpans(): ReadableSpan[] {
  return currentExporter?.getFinishedSpans() ?? [];
}

let currentExporter: InMemorySpanExporter | undefined;

function spanSummary(): string {
  return exporterSpans()
    .map(
      (span) =>
        `${span.name} kind=${span.kind} service=${String(span.attributes['otel-demo.service'])} route=${String(span.attributes['http.route'])} trace=${span.spanContext().traceId}`,
    )
    .join('\n');
}

function traceIdsFor(service: string, orderId: string): string[] {
  return currentLogs
    .filter(
      (line) =>
        line.service === service && line.orderId === orderId && typeof line.trace_id === 'string',
    )
    .map((line) => String(line.trace_id));
}

function arrayAttr(span: ReadableSpan, key: string): string[] {
  const value = span.attributes[key];
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry));
  }
  return typeof value === 'string' ? [value] : [];
}

let currentLogs: Record<string, unknown>[] = [];

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: 'localhost' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP port');
  }
  return `http://localhost:${address.port}`;
}

function portOf(url: string): number {
  return Number(new URL(url).port);
}

function stripTraceparent(port: number): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (!url.includes(`:${port}/`)) {
      return original(input, init);
    }
    const headers = new Headers(init?.headers);
    headers.delete('traceparent');
    headers.delete('tracestate');
    return original(input, { ...init, headers });
  };
  return () => {
    globalThis.fetch = original;
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
