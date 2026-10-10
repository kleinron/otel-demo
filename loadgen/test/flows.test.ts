import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { arrivalsInSlot, buildPlan, parseLoadSchedule } from '@otel-demo/telemetry';
import { runArrival, type FlowState } from '../src/flows.js';
import { createLoggingClient, type ShopClient, type ShopRequest } from '../src/http.js';
import { createRunner } from '../src/runner.js';

const plan = buildPlan(
  parseLoadSchedule(
    JSON.parse(readFileSync(fileURLToPath(new URL('../schedule.json', import.meta.url)), 'utf8')),
  ),
);

describe('shop flows', () => {
  it('schedules every arrival in a slot without waiting for a slow response', () => {
    const slot = Date.parse('2026-10-12T10:00:00.000Z');
    const expected = arrivalsInSlot(plan, plan.schedule.seed, slot);
    expect(expected.length).toBeGreaterThan(1);
    let scheduled = 0;
    const runner = createRunner({
      plan,
      seed: plan.schedule.seed,
      joinMs: slot,
      client: {
        async request() {
          return new Promise(() => undefined);
        },
      },
      log() {},
      scheduleAt(_delay, fn) {
        scheduled += 1;
        fn();
      },
    });
    runner.tick(slot);
    expect(scheduled).toBe(expected.length);
  });

  it('logs each request as structured JSON and checks out the scarce sku on purpose', async () => {
    const logs: Record<string, unknown>[] = [];
    const sent: ShopRequest[] = [];
    const inner: ShopClient = {
      async request(input) {
        sent.push(input);
        if (input.operation === 'create-cart') {
          return { status: 201, body: { cartId: 'cart-1' } };
        }
        if (input.operation === 'checkout') {
          return { status: 409, body: { error: 'out_of_stock', orderId: 'lg-1' } };
        }
        return { status: 200, body: { cartId: 'cart-1' } };
      },
    };
    const client = createLoggingClient(
      inner,
      (event) => logs.push(event),
      () => Date.parse('2026-10-12T12:10:00.000Z'),
    );
    const state: FlowState = { carts: new Map(), orders: [] };
    const arrival = {
      stream: 'checkout' as const,
      slotStartMs: Date.parse('2026-10-12T12:10:00.000Z'),
      index: 0,
      atMs: Date.parse('2026-10-12T12:10:00.000Z'),
    };
    let scarce = false;
    for (let index = 0; index < 40 && !scarce; index += 1) {
      sent.length = 0;
      logs.length = 0;
      await runArrival({ ...arrival, index }, { plan, seed: plan.schedule.seed, client, state });
      scarce = sent.some(
        (request) =>
          request.operation === 'add-to-cart' &&
          (request.body as { sku?: string } | undefined)?.sku === plan.schedule.outOfStock.sku,
      );
    }
    expect(scarce).toBe(true);
    expect(sent.map((request) => request.operation)).toContain('checkout');
    expect(sent.map((request) => request.operation)).toContain('order-status');
    expect(sent.some((request) => request.operation === 'add-to-cart')).toBe(true);
    for (const line of logs) {
      expect(line).toMatchObject({
        msg: 'request',
        timestamp: '2026-10-12T12:10:00.000Z',
      });
      expect(typeof line.flowId).toBe('string');
      expect(typeof line.operation).toBe('string');
      expect(typeof line.status).toBe('number');
      expect(typeof line.latencyMs).toBe('number');
    }
  });

  it('browses, adds, and removes using seeded customer ids', async () => {
    const sent: ShopRequest[] = [];
    const client: ShopClient = {
      async request(input) {
        sent.push(input);
        return {
          status: input.operation === 'create-cart' ? 201 : 200,
          body: { cartId: 'cart-9' },
        };
      },
    };
    const state: FlowState = { carts: new Map(), orders: [] };
    const slot = Date.parse('2026-10-12T11:00:00.000Z');
    await runArrival(
      { stream: 'browse', slotStartMs: slot, index: 1, atMs: slot },
      { plan, seed: plan.schedule.seed, client, state },
    );
    await runArrival(
      { stream: 'cart', slotStartMs: slot, index: 2, atMs: slot },
      { plan, seed: plan.schedule.seed, client, state },
    );
    expect(sent.some((request) => request.operation === 'browse')).toBe(true);
    expect(
      sent.some(
        (request) =>
          request.operation === 'add-to-cart' || request.operation === 'remove-from-cart',
      ),
    ).toBe(true);
    const created = sent.find((request) => request.operation === 'create-cart');
    expect((created?.body as { customerId?: string } | undefined)?.customerId).toMatch(
      /^cust-\d{4}$/,
    );
  });
});
