import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  arrivalsInSlot,
  buildPlan,
  HARD_MAX_ARRIVALS_PER_SECOND,
  HARD_MAX_DURATION_MS,
  limitDurationMs,
  parseLoadSchedule,
  SLOT_MS,
  theoreticalPeakPerSecond,
  totalArrivalRatePerSecond,
  type LoadSchedule,
} from '@otel-demo/telemetry';

const schedule = parseLoadSchedule(
  JSON.parse(readFileSync(fileURLToPath(new URL('../schedule.json', import.meta.url)), 'utf8')),
);
const plan = buildPlan(schedule);

describe('hard caps', () => {
  it('keeps the checked-in rate cap above the spike peak and under the hard cap', () => {
    const peak = theoreticalPeakPerSecond(schedule, 8);
    expect(plan.rateCapPerSecond).toBeGreaterThan(peak);
    expect(plan.rateCapPerSecond).toBeLessThanOrEqual(HARD_MAX_ARRIVALS_PER_SECOND);
    expect(schedule.caps.maxArrivalsPerSecond).toBeGreaterThan(peak);

    const saturation = Date.parse('2026-10-13T12:10:00.000Z');
    expect(totalArrivalRatePerSecond(plan, saturation)).toBeGreaterThan(
      totalArrivalRatePerSecond(plan, Date.parse('2026-10-13T11:00:00.000Z')),
    );
    expect(totalArrivalRatePerSecond(plan, saturation)).toBeLessThanOrEqual(plan.rateCapPerSecond);
    expect(totalArrivalRatePerSecond(plan, saturation)).toBeLessThanOrEqual(
      HARD_MAX_ARRIVALS_PER_SECOND,
    );

    const slotCount = arrivalsInSlot(plan, schedule.seed, saturation).length;
    expect(slotCount).toBeLessThanOrEqual(Math.floor(plan.rateCapPerSecond * (SLOT_MS / 1000)));
    expect(slotCount).toBeLessThanOrEqual(HARD_MAX_ARRIVALS_PER_SECOND);
  });

  it('clamps the run to the hard duration even if the schedule asks for longer', () => {
    expect(plan.hardStopMs - plan.startMs).toBeLessThanOrEqual(HARD_MAX_DURATION_MS);
    expect(plan.hardStopMs).toBe(Date.parse('2026-10-15T08:30:00.000Z'));

    const longer: LoadSchedule = {
      ...schedule,
      experiment: { ...schedule.experiment, durationHours: 1000 },
      caps: { ...schedule.caps, maxDurationHours: 1000 },
    };
    const clamped = buildPlan(longer);
    expect(clamped.hardStopMs - clamped.startMs).toBe(HARD_MAX_DURATION_MS);
    expect(limitDurationMs(1000 * 60 * 60 * 1000)).toBe(HARD_MAX_DURATION_MS);
  });

  it('refuses a schedule whose spike peak would pass the hard rate cap', () => {
    const wild: LoadSchedule = {
      ...schedule,
      spikes: schedule.spikes.map((spike) =>
        spike.name === 'checkout-delay'
          ? { ...spike, multiplier: 100, saturationMultiplier: 100 }
          : spike,
      ),
    };
    expect(() => buildPlan(wild)).toThrow(/rate cap/i);
  });
});
