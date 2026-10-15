import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { customerAt, SEED_CUSTOMER_COUNT } from '../../services/shop/src/customers.ts';
import { CATALOG, stockOnHand } from '../../services/inventory/src/catalog.ts';
import {
  applyLocalCartRate,
  applyRuntimeOverrides,
  arrivalRatePerSecond,
  arrivalsInSlot,
  baseCurvePerSecond,
  buildPlan,
  customerId,
  faultAt,
  mixSeed,
  loadPlanFromEnv,
  parseLoadSchedule,
  SECONDS_PER_DAY,
  spikeAt,
  totalArrivalRatePerSecond,
  zonedHour,
  type LoadSchedule,
  type SpikeInstance,
} from '@otel-demo/telemetry';

const schedule = loadCheckedInSchedule();
const plan = buildPlan(schedule);

describe('checked-in schedule', () => {
  it('follows a Jerusalem day-night curve that totals the daily targets', () => {
    const noonUtc = Date.parse('2026-10-12T13:00:00.000Z');
    expect(zonedHour(noonUtc, 'Asia/Jerusalem')).toBeCloseTo(16, 5);
    expect(baseCurvePerSecond(schedule, 'cart', noonUtc)).toBeGreaterThan(
      baseCurvePerSecond(schedule, 'cart', Date.parse('2026-10-12T00:00:00.000Z')),
    );

    const start = Date.parse('2026-10-12T00:00:00.000Z');
    const stepSec = 60;
    let cart = 0;
    let checkout = 0;
    for (let elapsed = 0; elapsed < SECONDS_PER_DAY; elapsed += stepSec) {
      const at = start + elapsed * 1000;
      cart += baseCurvePerSecond(schedule, 'cart', at) * stepSec;
      checkout += baseCurvePerSecond(schedule, 'checkout', at) * stepSec;
    }
    expect(cart).toBeGreaterThan(98_000);
    expect(cart).toBeLessThan(102_000);
    expect(checkout).toBeGreaterThan(2_940);
    expect(checkout).toBeLessThan(3_060);
  });

  it('places the four UTC spikes and keeps the first one a normal baseline', () => {
    const day = Date.parse('2026-10-12T00:00:00.000Z');
    expect(spikeAt(plan, day + hours(10))?.name).toBe('add-to-cart-delay');
    expect(spikeAt(plan, day + hours(12))?.name).toBe('checkout-delay');
    expect(spikeAt(plan, day + hours(14))?.name).toBe('inventory-db-timeout');
    expect(spikeAt(plan, day + hours(20))?.name).toBe('payment-delay');

    const first = plan.spikes[0];
    expect(first?.baseline).toBe(true);
    expect(first?.size).toBe('normal');
    expect(first?.multiplier).toBe(3);
    expect(first?.fault).toBeUndefined();
    expect(new Date(first?.startMs ?? 0).toISOString()).toBe('2026-10-12T10:00:00.000Z');
    expect((first?.endMs ?? 0) - (first?.startMs ?? 0)).toBe(20 * 60 * 1000);
    expect(plan.warmupStartMs).toBe(Date.parse('2026-10-12T09:55:00.000Z'));
    expect(plan.warmupEndMs).toBe(Date.parse('2026-10-12T10:00:00.000Z'));
    expect(totalArrivalRatePerSecond(plan, Date.parse('2026-10-12T09:57:00.000Z'))).toBe(0);
  });

  it('uses a saturation multiplier only for the day-2 12:00 UTC checkout spike', () => {
    const dayOne = spikeAt(plan, Date.parse('2026-10-12T12:00:00.000Z'));
    const dayTwo = spikeAt(plan, Date.parse('2026-10-13T12:00:00.000Z'));
    expect(dayOne?.size).toBe('normal');
    expect(dayOne?.multiplier).toBe(3);
    expect(dayOne?.fault?.type).toBe('delay');
    expect(dayTwo?.size).toBe('saturation');
    expect(dayTwo?.multiplier).toBe(8);
    expect(dayTwo?.baseline).toBe(false);
    expect(dayTwo?.fault?.operation).toBe('checkout');
    expect(dayTwo?.fault?.startMs).toBe(Date.parse('2026-10-13T12:02:00.000Z'));
    expect(dayTwo?.fault?.endMs).toBe(Date.parse('2026-10-13T12:22:00.000Z'));
  });

  it('keeps the paired fault windows longer than their alert evaluation windows', () => {
    const windows = alertWindows(
      readFileSync(
        fileURLToPath(new URL('../../observability/alerts.yml', import.meta.url)),
        'utf8',
      ),
    );
    const paired: Record<string, readonly string[]> = {
      'add-to-cart-delay': ['shop-add-to-cart-p99-latency'],
      'checkout-delay': ['shop-checkout-p99-latency'],
      'inventory-db-timeout': ['inventory-db-timeout-count', 'inventory-p99-latency'],
      'payment-delay': ['payment-stuck-unknown', 'payment-p99-latency'],
    };
    const faulted = plan.spikes.filter((spike) => spike.fault);
    expect(faulted.length).toBeGreaterThan(0);
    for (const spike of faulted) {
      const alarms = paired[spike.name];
      expect(alarms, spike.name).toBeDefined();
      const duration = (spike.fault?.endMs ?? 0) - (spike.fault?.startMs ?? 0);
      for (const alarm of alarms ?? []) {
        const evaluation = windows.get(alarm);
        expect(evaluation, alarm).toBeGreaterThan(0);
        expect(duration).toBeGreaterThan(evaluation ?? 0);
      }
    }
    expect(faultOf(plan.spikes, 'add-to-cart-delay')?.sizeMs).toBe(1200);
    expect(faultOf(plan.spikes, 'checkout-delay')?.durationMinutes()).toBe(20);
    expect(faultOf(plan.spikes, 'inventory-db-timeout')?.sizeMs).toBeGreaterThan(5_000);
    const payment = faultOf(plan.spikes, 'payment-delay');
    expect(payment?.sizeMs).toBeGreaterThan(schedule.paymentTimeoutMs);
    expect(payment?.operation).toBe('charge');
  });

  it('draws customers from the seeded catalog and aims some checkouts at the scarce sku', () => {
    expect(schedule.customers.count).toBe(SEED_CUSTOMER_COUNT);
    expect(customerId(0)).toBe(customerAt(0).id);
    expect(customerId(999)).toBe(customerAt(999).id);
    for (const sku of schedule.skus) {
      expect(CATALOG.some((item) => item.sku === sku)).toBe(true);
    }
    expect(schedule.outOfStock.qty).toBeGreaterThan(stockOnHand(schedule.outOfStock.sku, 'wh-tlv'));
    expect(mixSeed(schedule.seed, ['cart', 1, 0])).toBe(mixSeed(schedule.seed, ['cart', 1, 0]));
  });

  it('drops the fault when the day-2 checkout spike is the first one that runs', () => {
    const shifted = buildPlan(
      parseLoadSchedule({
        ...structuredClone(schedule),
        experiment: { ...schedule.experiment, start: '2026-10-13T11:00:00.000Z' },
      }),
    );
    const first = shifted.spikes[0];
    expect(first?.name).toBe('checkout-delay');
    expect(first?.baseline).toBe(true);
    expect(first?.size).toBe('normal');
    expect(first?.multiplier).toBe(3);
    expect(first?.fault).toBeUndefined();
    expect(faultAt(shifted, Date.parse('2026-10-13T12:05:00.000Z'))).toBeUndefined();
    const nextDay = spikeAt(shifted, Date.parse('2026-10-14T12:00:00.000Z'));
    expect(nextDay?.size).toBe('saturation');
    expect(nextDay?.fault).toBeDefined();
  });

  it('uses the schedule start unless LOADGEN_START_UTC overrides it', () => {
    const fileStart = schedule.experiment.start;
    expect(applyRuntimeOverrides(schedule, {}).experiment.start).toBe(fileStart);
    expect(applyRuntimeOverrides(schedule, { LOADGEN_START_UTC: '   ' }).experiment.start).toBe(
      fileStart,
    );
    const pinned = '2030-01-02T03:04:05.000Z';
    expect(applyRuntimeOverrides(schedule, { LOADGEN_START_UTC: pinned }).experiment.start).toBe(
      pinned,
    );
    const fromFile = loadPlanFromEnv({
      OTEL_DEMO_LOAD_SCHEDULE_FILE: fileURLToPath(new URL('../schedule.json', import.meta.url)),
    });
    expect(fromFile?.schedule.experiment.start).toBe(fileStart);
    expect(fromFile?.startMs).toBe(Date.parse(fileStart));
    const overridden = loadPlanFromEnv({
      OTEL_DEMO_LOAD_SCHEDULE_FILE: fileURLToPath(new URL('../schedule.json', import.meta.url)),
      LOADGEN_START_UTC: pinned,
    });
    expect(overridden?.schedule.experiment.start).toBe(pinned);
    expect(overridden?.startMs).toBe(Date.parse(pinned));
  });

  it('keeps the cloud schedule when the local cart rate is set on the service path', () => {
    const fromFile = loadPlanFromEnv({
      OTEL_DEMO_LOAD_SCHEDULE_FILE: fileURLToPath(new URL('../schedule.json', import.meta.url)),
      LOADGEN_CARTS_PER_MINUTE: '1',
    });
    expect(fromFile?.schedule.curve.cartActivitiesPerDay).toBe(100_000);
    expect(fromFile?.schedule.steady).toBeUndefined();
    expect(applyRuntimeOverrides(schedule, { LOADGEN_CARTS_PER_MINUTE: '1' }).curve).toEqual(
      schedule.curve,
    );
  });
});

describe('local cart rate', () => {
  const now = Date.parse('2030-01-02T03:04:05.000Z');

  it('leaves the schedule untouched when the env is unset', () => {
    expect(applyLocalCartRate(schedule, {})).toBe(schedule);
    expect(applyLocalCartRate(schedule, { LOADGEN_CARTS_PER_MINUTE: '   ' })).toBe(schedule);
  });

  it('runs about one cart per minute, with the other streams in proportion', () => {
    const carts = schedule.curve.cartActivitiesPerDay;
    const scaled = applyLocalCartRate(
      applyRuntimeOverrides(schedule, { LOADGEN_START_UTC: schedule.experiment.start }),
      { LOADGEN_CARTS_PER_MINUTE: '1', LOADGEN_START_UTC: schedule.experiment.start },
      now,
    );
    expect(schedule.curve.cartActivitiesPerDay).toBe(carts);
    expect(schedule.steady).toBeUndefined();
    expect(scaled.steady).toBe(true);
    expect(scaled.curve.amplitude).toBe(0);
    expect(scaled.curve.cartActivitiesPerDay).toBe(1440);
    expect(scaled.curve.checkoutsPerDay).toBe(43);
    expect(scaled.curve.browsePerDay).toBe(1296);
    expect(scaled.curve.orderStatusPerDay).toBe(86);
    expect(scaled.experiment.start).toBe(schedule.experiment.start);
    expect(scaled.curve.checkoutsPerDay / scaled.curve.cartActivitiesPerDay).toBeCloseTo(
      schedule.curve.checkoutsPerDay / schedule.curve.cartActivitiesPerDay,
      2,
    );

    const plan = buildPlan(scaled);
    const perSecond = 1440 / SECONDS_PER_DAY;
    const flat = Date.parse('2026-10-12T08:40:00.000Z');
    const warmup = Date.parse('2026-10-12T09:57:00.000Z');
    const spike = Date.parse('2026-10-12T12:05:00.000Z');
    expect(arrivalRatePerSecond(plan, 'cart', flat)).toBeCloseTo(perSecond, 10);
    expect(arrivalRatePerSecond(plan, 'cart', warmup)).toBeCloseTo(perSecond, 10);
    expect(arrivalRatePerSecond(plan, 'cart', spike)).toBeCloseTo(perSecond, 10);
    expect(arrivalRatePerSecond(plan, 'checkout', flat) * 60).toBeCloseTo(
      (43 / SECONDS_PER_DAY) * 60,
      8,
    );
  });

  it('starts at now unless LOADGEN_START_UTC is already applied', () => {
    const moved = applyLocalCartRate(schedule, { LOADGEN_CARTS_PER_MINUTE: '1' }, now);
    expect(moved.experiment.start).toBe('2030-01-02T03:04:05.000Z');
    const pinned = '2031-05-06T07:08:09.000Z';
    const kept = applyLocalCartRate(
      applyRuntimeOverrides(schedule, { LOADGEN_START_UTC: pinned }),
      { LOADGEN_CARTS_PER_MINUTE: '1', LOADGEN_START_UTC: pinned },
      now,
    );
    expect(kept.experiment.start).toBe(pinned);
    expect(kept.curve.cartActivitiesPerDay).toBe(1440);
  });

  it('yields 60 carts an hour and a checkout in every hour, including 07:25 IDT', () => {
    const morning = Date.parse('2026-10-15T04:25:00.000Z');
    const scaled = applyLocalCartRate(schedule, { LOADGEN_CARTS_PER_MINUTE: '1' }, morning);
    const local = buildPlan(scaled);
    const hour = streamCounts(local, morning, 3600);
    const later = streamCounts(local, morning + 5 * 3_600_000, 3600);
    expect(hour.cart).toBe(60);
    expect(later.cart).toBe(60);
    expect(hour.checkout).toBeGreaterThan(0);
    expect(later.checkout).toBeGreaterThan(0);
    const day = streamCounts(local, morning, SECONDS_PER_DAY);
    expect(day.checkout / day.cart).toBeCloseTo(
      scaled.curve.checkoutsPerDay / scaled.curve.cartActivitiesPerDay,
      5,
    );
    expect(arrivalRatePerSecond(plan, 'cart', morning)).toBeGreaterThan(0.2);
    expect(arrivalRatePerSecond(local, 'cart', morning)).toBeCloseTo(1440 / SECONDS_PER_DAY, 8);
  });

  it('rejects a rate that is not a positive number', () => {
    expect(() => applyLocalCartRate(schedule, { LOADGEN_CARTS_PER_MINUTE: '0' })).toThrow(
      /positive/,
    );
    expect(() => applyLocalCartRate(schedule, { LOADGEN_CARTS_PER_MINUTE: 'nope' })).toThrow(
      /positive/,
    );
  });
});

function streamCounts(
  loadPlan: ReturnType<typeof buildPlan>,
  fromMs: number,
  seconds: number,
): Record<'cart' | 'checkout' | 'browse' | 'orderStatus', number> {
  const counts = { cart: 0, checkout: 0, browse: 0, orderStatus: 0 };
  for (let step = 0; step < seconds; step += 1) {
    const slot = fromMs + step * 1000;
    for (const arrival of arrivalsInSlot(loadPlan, loadPlan.schedule.seed, slot)) {
      counts[arrival.stream] += 1;
    }
  }
  return counts;
}

function loadCheckedInSchedule(): LoadSchedule {
  return parseLoadSchedule(
    JSON.parse(readFileSync(fileURLToPath(new URL('../schedule.json', import.meta.url)), 'utf8')),
  );
}

function hours(value: number): number {
  return value * 60 * 60 * 1000;
}

function alertWindows(yaml: string): Map<string, number> {
  const windows = new Map<string, number>();
  let name: string | undefined;
  for (const line of yaml.split('\n')) {
    const nameMatch = line.match(/^\s*- name:\s*(\S+)\s*$/);
    if (nameMatch?.[1]) {
      name = nameMatch[1];
      continue;
    }
    const windowMatch = line.match(/^\s*window:\s*'?(\d+)(m|h)'?/);
    if (windowMatch?.[1] && windowMatch[2] && name) {
      const amount = Number(windowMatch[1]);
      windows.set(name, windowMatch[2] === 'h' ? amount * 60 * 60 * 1000 : amount * 60 * 1000);
      name = undefined;
    }
  }
  return windows;
}

function faultOf(spikes: readonly SpikeInstance[], name: string) {
  const fault = spikes.find((spike) => spike.name === name && spike.fault)?.fault;
  if (!fault) {
    return undefined;
  }
  return {
    ...fault,
    durationMinutes: () => (fault.endMs - fault.startMs) / 60_000,
  };
}
