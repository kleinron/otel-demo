import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyLocalCartRate,
  arrivalsInSlot,
  buildPlan,
  parseLoadSchedule,
} from '@otel-demo/telemetry';
import { runArrival, type FlowState } from '../src/flows.js';
import type { ShopClient, ShopRequest } from '../src/http.js';
import { createRunner } from '../src/runner.js';

const fileSchedule = parseLoadSchedule(
  JSON.parse(readFileSync(fileURLToPath(new URL('../schedule.json', import.meta.url)), 'utf8')),
);

describe('local runner', () => {
  it('still schedules the hour of carts when ticks are several seconds apart', () => {
    const start = Date.parse('2026-10-15T04:25:00.000Z');
    const plan = buildPlan(
      applyLocalCartRate(fileSchedule, { LOADGEN_CARTS_PER_MINUTE: '1' }, start),
    );
    let scheduled = 0;
    const runner = createRunner({
      plan,
      seed: plan.schedule.seed,
      joinMs: start,
      client: {
        async request() {
          return { status: 200, body: {} };
        },
      },
      log() {},
      scheduleAt(_delay, fn) {
        scheduled += 1;
        fn();
      },
    });
    for (let at = start; at < start + 3_600_000; at += 5_000) {
      runner.tick(at);
    }
    runner.tick(start + 3_600_000 - 1);
    let expected = 0;
    let carts = 0;
    let checkouts = 0;
    for (let slot = start; slot < start + 3_600_000; slot += 1_000) {
      const arrivals = arrivalsInSlot(plan, plan.schedule.seed, slot);
      expected += arrivals.length;
      carts += arrivals.filter((arrival) => arrival.stream === 'cart').length;
      checkouts += arrivals.filter((arrival) => arrival.stream === 'checkout').length;
    }
    expect(scheduled).toBe(expected);
    expect(carts).toBe(60);
    expect(checkouts).toBeGreaterThan(0);
  });

  it('adds an item on every local cart activity, including ones that also remove', async () => {
    const start = Date.parse('2026-10-15T04:25:00.000Z');
    const plan = buildPlan(
      applyLocalCartRate(fileSchedule, { LOADGEN_CARTS_PER_MINUTE: '1' }, start),
    );
    const sent: ShopRequest[] = [];
    const client: ShopClient = {
      async request(input) {
        sent.push(input);
        return {
          status: input.operation === 'create-cart' ? 201 : 200,
          body: { cartId: 'cart-1' },
        };
      },
    };
    const state: FlowState = { carts: new Map(), orders: [] };
    let removed = false;
    for (let index = 0; index < 40 && !removed; index += 1) {
      sent.length = 0;
      await runArrival(
        { stream: 'cart', slotStartMs: start, index, atMs: start },
        { plan, seed: plan.schedule.seed, client, state },
      );
      removed = sent.some((request) => request.operation === 'remove-from-cart');
    }
    expect(removed).toBe(true);
    expect(sent.some((request) => request.operation === 'add-to-cart')).toBe(true);
    const addAt = sent.findIndex((request) => request.operation === 'add-to-cart');
    const removeAt = sent.findIndex((request) => request.operation === 'remove-from-cart');
    expect(addAt).toBeGreaterThanOrEqual(0);
    expect(addAt).toBeLessThan(removeAt);
  });

  it('keeps a cloud tick from replaying the seconds it skipped', () => {
    const plan = buildPlan(fileSchedule);
    const slot = Date.parse('2026-10-12T13:00:00.000Z');
    let scheduled = 0;
    const runner = createRunner({
      plan,
      seed: plan.schedule.seed,
      joinMs: slot,
      client: {
        async request() {
          return { status: 200, body: {} };
        },
      },
      log() {},
      scheduleAt() {
        scheduled += 1;
      },
    });
    runner.tick(slot);
    scheduled = 0;
    runner.tick(slot + 5_000);
    const fired = arrivalsInSlot(plan, plan.schedule.seed, slot + 5_000).length;
    let skipped = 0;
    for (let gap = 1_000; gap < 5_000; gap += 1_000) {
      skipped += arrivalsInSlot(plan, plan.schedule.seed, slot + gap).length;
    }
    expect(skipped).toBeGreaterThan(0);
    expect(scheduled).toBe(fired);
  });
});
