import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  arrivalsInSlot,
  buildPlan,
  createMarkerTracker,
  markerWindows,
  nextSlotStart,
  parseLoadSchedule,
} from '@otel-demo/telemetry';
import { createRunner } from '../src/runner.js';
import type { ShopClient } from '../src/http.js';

const plan = buildPlan(
  parseLoadSchedule(
    JSON.parse(readFileSync(fileURLToPath(new URL('../schedule.json', import.meta.url)), 'utf8')),
  ),
);

describe('restart rejoin', () => {
  it('does not replay a warm-up or spike that is already in progress', () => {
    const insideWarmup = Date.parse('2026-10-12T09:57:00.000Z');
    const tracker = createMarkerTracker(markerWindows(plan), insideWarmup);
    expect(tracker.poll(insideWarmup)).toEqual([]);
    expect(tracker.poll(Date.parse('2026-10-12T09:59:00.000Z'))).toEqual([]);

    const atSpike = tracker.poll(Date.parse('2026-10-12T10:00:00.000Z'));
    expect(atSpike.map((event) => event.msg)).toEqual(['warmup end', 'spike start']);
    expect(atSpike.find((event) => event.msg === 'spike start')).toMatchObject({
      at: '2026-10-12T10:00:00.000Z',
      name: 'add-to-cart-delay',
      baseline: true,
      size: 'normal',
    });
    expect(atSpike.some((event) => event.msg === 'warmup start')).toBe(false);
    expect(atSpike.some((event) => event.msg === 'fault window start')).toBe(false);
  });

  it('joins a spike without a second start and still emits the scheduled end', () => {
    const joined = Date.parse('2026-10-12T10:05:00.000Z');
    const tracker = createMarkerTracker(markerWindows(plan), joined);
    expect(tracker.poll(joined).map((event) => event.msg)).toEqual([]);
    const ended = tracker.poll(Date.parse('2026-10-12T10:20:00.000Z'));
    expect(ended.map((event) => event.msg)).toEqual(['spike end']);
    expect(ended[0]).toMatchObject({ at: '2026-10-12T10:20:00.000Z', name: 'add-to-cart-delay' });
  });

  it('skips slots from before the join time and keeps the same seeded arrivals', () => {
    const joined = Date.parse('2026-10-12T10:05:00.500Z');
    const slot = nextSlotStart(plan, joined);
    expect(slot).toBe(Date.parse('2026-10-12T10:05:01.000Z'));
    const events: Record<string, unknown>[] = [];
    const flowIds: string[] = [];
    const client: ShopClient = {
      async request(input) {
        flowIds.push(input.flowId);
        return { status: 201, body: { cartId: 'cart-1' } };
      },
    };
    const runner = createRunner({
      plan,
      seed: plan.schedule.seed,
      joinMs: joined,
      client,
      log: (event) => events.push(event),
      scheduleAt(_delay, fn) {
        fn();
      },
    });
    runner.tick(joined);
    expect(flowIds).toEqual([]);
    expect(events.some((event) => event.msg === 'spike start')).toBe(false);
    expect(events[0]).toMatchObject({
      msg: 'runner started',
      at: '2026-10-12T10:05:00.500Z',
      seed: plan.schedule.seed,
    });

    runner.tick(slot);
    const expected = arrivalsInSlot(plan, plan.schedule.seed, slot).map(
      (arrival) => `${arrival.stream}-${arrival.slotStartMs}-${arrival.index}`,
    );
    expect(flowIds).toEqual(expected);
    expect(arrivalsInSlot(plan, plan.schedule.seed, slot)).toEqual(
      arrivalsInSlot(plan, plan.schedule.seed, slot),
    );
    expect(flowIds.every((id) => id.includes(String(slot)))).toBe(true);
  });

  it('logs runner started again for a second process with the same seed', () => {
    const first: Record<string, unknown>[] = [];
    const second: Record<string, unknown>[] = [];
    const join = Date.parse('2026-10-12T11:00:00.000Z');
    const options = {
      plan,
      seed: 99,
      joinMs: join,
      client: {
        async request() {
          return { status: 200, body: {} };
        },
      },
      scheduleAt() {},
    };
    createRunner({ ...options, log: (event) => first.push(event) });
    createRunner({ ...options, log: (event) => second.push(event) });
    expect(first[0]).toMatchObject({ msg: 'runner started', seed: 99 });
    expect(second[0]).toMatchObject({ msg: 'runner started', seed: 99, at: first[0]?.at });
  });
});
