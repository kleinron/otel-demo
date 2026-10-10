/**
 * Checked-in load schedule: diurnal arrival rates, UTC spikes, and fault windows.
 * The load generator and the services both read this file. Times are absolute UTC
 * so a restarted process rejoins the curve instead of replaying it.
 */

export const HARD_MAX_ARRIVALS_PER_SECOND = 60;
export const HARD_MAX_DURATION_MS = 72 * 60 * 60 * 1000;
export const SLOT_MS = 1000;
export const SECONDS_PER_DAY = 24 * 60 * 60;
export const CUSTOMER_COUNT = 1000;

export const STREAMS = ['cart', 'checkout', 'browse', 'orderStatus'] as const;
export type Stream = (typeof STREAMS)[number];

export const FAULT_BLOCK_TYPES = ['delay', 'timeout', 'error'] as const;
export type FaultBlockType = (typeof FAULT_BLOCK_TYPES)[number];

export interface FaultBlock {
  service: string;
  operation: string;
  type: FaultBlockType;
  /** Delay or timeout magnitude in milliseconds. */
  sizeMs: number;
  startOffsetMinutes: number;
  durationMinutes: number;
  zone: string;
  probability: number;
}

export interface SpikeTemplate {
  name: string;
  /** Clock time `HH:MM` in `zone`. */
  at: string;
  zone: string;
  durationMinutes: number;
  multiplier: number;
  saturationMultiplier?: number;
  fault?: FaultBlock;
}

export interface LoadSchedule {
  seed: number;
  curve: {
    zone: string;
    peakLocalHour: number;
    amplitude: number;
    cartActivitiesPerDay: number;
    checkoutsPerDay: number;
    browsePerDay: number;
    orderStatusPerDay: number;
  };
  experiment: {
    start: string;
    zone: string;
    durationHours: number;
  };
  warmup: {
    minutes: number;
    zone: string;
  };
  caps: {
    maxArrivalsPerSecond: number;
    maxDurationHours: number;
    zone: string;
  };
  saturation: {
    spike: string;
    /** UTC days after the experiment start date. 1 is the next UTC date. */
    dayOffset: number;
    zone: string;
  };
  paymentTimeoutMs: number;
  customers: {
    count: number;
  };
  skus: readonly string[];
  outOfStock: {
    sku: string;
    qty: number;
    fraction: number;
  };
  spikes: readonly SpikeTemplate[];
}

export interface ResolvedFault {
  id: string;
  service: string;
  operation: string;
  type: FaultBlockType;
  sizeMs: number;
  probability: number;
  startMs: number;
  endMs: number;
}

export interface SpikeInstance {
  name: string;
  startMs: number;
  endMs: number;
  multiplier: number;
  size: 'normal' | 'saturation';
  baseline: boolean;
  fault?: ResolvedFault;
}

export interface LoadPlan {
  schedule: LoadSchedule;
  startMs: number;
  hardStopMs: number;
  warmupStartMs: number | undefined;
  warmupEndMs: number | undefined;
  /** Min of the schedule cap and the hard cap. Always above the schedule's spike peak. */
  rateCapPerSecond: number;
  spikes: readonly SpikeInstance[];
}

export interface Arrival {
  stream: Stream;
  slotStartMs: number;
  index: number;
  atMs: number;
}

export type MarkerKind = 'warmup' | 'spike' | 'fault';

export interface MarkerWindow {
  kind: MarkerKind;
  id: string;
  startMs: number;
  endMs: number;
  fields: Record<string, unknown>;
}

export interface MarkerEvent {
  msg: string;
  at: string;
  [key: string]: unknown;
}

const START_MSG: Record<MarkerKind, string> = {
  warmup: 'warmup start',
  spike: 'spike start',
  fault: 'fault window start',
};

const END_MSG: Record<MarkerKind, string> = {
  warmup: 'warmup end',
  spike: 'spike end',
  fault: 'fault window end',
};

export function parseLoadSchedule(value: unknown): LoadSchedule {
  const record = objectRecord(value, 'schedule');
  const curve = objectRecord(record.curve, 'curve');
  const experiment = objectRecord(record.experiment, 'experiment');
  const warmup = objectRecord(record.warmup, 'warmup');
  const caps = objectRecord(record.caps, 'caps');
  const saturation = objectRecord(record.saturation, 'saturation');
  const customers = objectRecord(record.customers, 'customers');
  const outOfStock = objectRecord(record.outOfStock, 'outOfStock');
  const spikesRaw = record.spikes;
  if (!Array.isArray(spikesRaw) || spikesRaw.length === 0) {
    throw new Error('schedule spikes must be a non-empty array');
  }
  const schedule: LoadSchedule = {
    seed: positiveInt(record.seed, 'seed'),
    curve: {
      zone: zoneName(curve.zone, 'curve.zone'),
      peakLocalHour: hourOfDay(curve.peakLocalHour, 'curve.peakLocalHour'),
      amplitude: unitAmplitude(curve.amplitude, 'curve.amplitude'),
      cartActivitiesPerDay: positiveInt(curve.cartActivitiesPerDay, 'curve.cartActivitiesPerDay'),
      checkoutsPerDay: positiveInt(curve.checkoutsPerDay, 'curve.checkoutsPerDay'),
      browsePerDay: positiveInt(curve.browsePerDay, 'curve.browsePerDay'),
      orderStatusPerDay: positiveInt(curve.orderStatusPerDay, 'curve.orderStatusPerDay'),
    },
    experiment: {
      start: utcTimestamp(experiment.start, 'experiment.start'),
      zone: utcZone(experiment.zone, 'experiment.zone'),
      durationHours: positiveInt(experiment.durationHours, 'experiment.durationHours'),
    },
    warmup: {
      minutes: positiveInt(warmup.minutes, 'warmup.minutes'),
      zone: utcZone(warmup.zone, 'warmup.zone'),
    },
    caps: {
      maxArrivalsPerSecond: positiveNumber(caps.maxArrivalsPerSecond, 'caps.maxArrivalsPerSecond'),
      maxDurationHours: positiveInt(caps.maxDurationHours, 'caps.maxDurationHours'),
      zone: utcZone(caps.zone, 'caps.zone'),
    },
    saturation: {
      spike: requiredText(saturation.spike, 'saturation.spike'),
      dayOffset: positiveInt(saturation.dayOffset, 'saturation.dayOffset'),
      zone: utcZone(saturation.zone, 'saturation.zone'),
    },
    paymentTimeoutMs: positiveInt(record.paymentTimeoutMs, 'paymentTimeoutMs'),
    customers: {
      count: positiveInt(customers.count, 'customers.count'),
    },
    skus: stringList(record.skus, 'skus'),
    outOfStock: {
      sku: requiredText(outOfStock.sku, 'outOfStock.sku'),
      qty: positiveInt(outOfStock.qty, 'outOfStock.qty'),
      fraction: unitFraction(outOfStock.fraction, 'outOfStock.fraction'),
    },
    spikes: spikesRaw.map((entry, index) => parseSpike(entry, index)),
  };
  if (!schedule.spikes.some((spike) => spike.name === schedule.saturation.spike)) {
    throw new Error(`saturation.spike ${schedule.saturation.spike} is not a spike name`);
  }
  const saturationSpike = schedule.spikes.find((spike) => spike.name === schedule.saturation.spike);
  if (saturationSpike?.saturationMultiplier === undefined) {
    throw new Error(`${schedule.saturation.spike} needs saturationMultiplier`);
  }
  const names = new Set<string>();
  for (const spike of schedule.spikes) {
    if (names.has(spike.name)) {
      throw new Error(`duplicate spike name ${spike.name}`);
    }
    names.add(spike.name);
  }
  return schedule;
}

/**
 * `LOADGEN_START_UTC` and `LOADGEN_SEED` override the file so a deploy can pin
 * the run without editing the checked-in schedule. Services and the generator
 * must see the same values.
 */
export function applyRuntimeOverrides(
  schedule: LoadSchedule,
  env: Record<string, string | undefined>,
): LoadSchedule {
  const start = env.LOADGEN_START_UTC?.trim();
  const seedRaw = env.LOADGEN_SEED?.trim();
  if (!start && !seedRaw) {
    return schedule;
  }
  return {
    ...schedule,
    seed: seedRaw ? positiveInt(Number(seedRaw), 'LOADGEN_SEED') : schedule.seed,
    experiment: {
      ...schedule.experiment,
      start: start ? utcTimestamp(start, 'LOADGEN_START_UTC') : schedule.experiment.start,
    },
  };
}

export function buildPlan(schedule: LoadSchedule): LoadPlan {
  const startMs = Date.parse(schedule.experiment.start);
  const requestedMs = Math.min(
    schedule.experiment.durationHours * 60 * 60 * 1000,
    schedule.caps.maxDurationHours * 60 * 60 * 1000,
  );
  const hardStopMs = startMs + limitDurationMs(requestedMs);
  const spikes = resolveSpikes(schedule, startMs, hardStopMs);
  const first = spikes[0];
  const warmup =
    first === undefined
      ? { warmupStartMs: undefined, warmupEndMs: undefined }
      : warmupWindow(first.startMs, schedule.warmup.minutes);
  const maxMultiplier = spikes.reduce((max, spike) => Math.max(max, spike.multiplier), 1);
  const peak = theoreticalPeakPerSecond(schedule, maxMultiplier);
  const rateCapPerSecond = Math.min(
    schedule.caps.maxArrivalsPerSecond,
    HARD_MAX_ARRIVALS_PER_SECOND,
  );
  if (!(rateCapPerSecond > peak)) {
    throw new Error(
      `rate cap ${rateCapPerSecond}/s is not above the spike peak ${peak.toFixed(3)}/s`,
    );
  }
  return {
    schedule,
    startMs,
    hardStopMs,
    warmupStartMs: warmup.warmupStartMs,
    warmupEndMs: warmup.warmupEndMs,
    rateCapPerSecond,
    spikes,
  };
}

export function limitDurationMs(requestedMs: number): number {
  if (!Number.isFinite(requestedMs) || requestedMs <= 0) {
    return HARD_MAX_DURATION_MS;
  }
  return Math.min(requestedMs, HARD_MAX_DURATION_MS);
}

/** Upper bound: diurnal peak lined up with the largest spike multiplier. */
export function theoreticalPeakPerSecond(schedule: LoadSchedule, maxMultiplier: number): number {
  const perDay =
    schedule.curve.cartActivitiesPerDay +
    schedule.curve.checkoutsPerDay +
    schedule.curve.browsePerDay +
    schedule.curve.orderStatusPerDay;
  return (perDay / SECONDS_PER_DAY) * (1 + schedule.curve.amplitude) * maxMultiplier;
}

/** Unspiked curve. Ignores the experiment window, warm-up, and caps. */
export function baseCurvePerSecond(schedule: LoadSchedule, stream: Stream, utcMs: number): number {
  const factor =
    1 +
    schedule.curve.amplitude *
      Math.cos(
        (2 * Math.PI * (zonedHour(utcMs, schedule.curve.zone) - schedule.curve.peakLocalHour)) / 24,
      );
  return (perDay(schedule, stream) / SECONDS_PER_DAY) * factor;
}

/**
 * Arrival rate for one stream at an absolute instant. Zero during warm-up and
 * outside the experiment. Spike multipliers apply only inside that spike.
 * The sum of streams is clamped to the rate cap.
 */
export function arrivalRatePerSecond(plan: LoadPlan, stream: Stream, utcMs: number): number {
  return cappedRates(plan, utcMs)[stream];
}

export function totalArrivalRatePerSecond(plan: LoadPlan, utcMs: number): number {
  const rates = cappedRates(plan, utcMs);
  return STREAMS.reduce((sum, stream) => sum + rates[stream], 0);
}

export function spikeAt(plan: LoadPlan, utcMs: number): SpikeInstance | undefined {
  return plan.spikes.find((spike) => utcMs >= spike.startMs && utcMs < spike.endMs);
}

export function faultAt(plan: LoadPlan, utcMs: number): ResolvedFault | undefined {
  for (const spike of plan.spikes) {
    const fault = spike.fault;
    if (fault && utcMs >= fault.startMs && utcMs < fault.endMs) {
      return fault;
    }
  }
  return undefined;
}

export function inWarmup(plan: LoadPlan, utcMs: number): boolean {
  return (
    plan.warmupStartMs !== undefined &&
    plan.warmupEndMs !== undefined &&
    utcMs >= plan.warmupStartMs &&
    utcMs < plan.warmupEndMs
  );
}

export function slotStartAt(plan: LoadPlan, utcMs: number): number {
  if (utcMs <= plan.startMs) {
    return plan.startMs;
  }
  const steps = Math.floor((utcMs - plan.startMs) / SLOT_MS);
  return plan.startMs + steps * SLOT_MS;
}

/** First slot boundary at or after `utcMs`. A partial slot is not replayed. */
export function nextSlotStart(plan: LoadPlan, utcMs: number): number {
  const slot = slotStartAt(plan, utcMs);
  if (utcMs <= plan.startMs) {
    return plan.startMs;
  }
  if (utcMs === slot) {
    return slot;
  }
  return slot + SLOT_MS;
}

export function arrivalsInSlot(
  plan: LoadPlan,
  seed: number,
  slotStartMs: number,
): readonly Arrival[] {
  if (slotStartMs < plan.startMs || slotStartMs >= plan.hardStopMs) {
    return [];
  }
  const midpoint = slotStartMs + SLOT_MS / 2;
  const rates = cappedRates(plan, midpoint);
  const counts = new Map<Stream, number>();
  for (const stream of STREAMS) {
    counts.set(stream, sampleCount(rates[stream], seed, stream, slotStartMs));
  }
  trimCounts(counts, Math.floor(plan.rateCapPerSecond * (SLOT_MS / 1000)));
  const arrivals: Arrival[] = [];
  for (const stream of STREAMS) {
    const count = counts.get(stream) ?? 0;
    for (let index = 0; index < count; index += 1) {
      const offset = Math.floor(((index + 0.5) * SLOT_MS) / count);
      arrivals.push({
        stream,
        slotStartMs,
        index,
        atMs: slotStartMs + offset,
      });
    }
  }
  return arrivals;
}

export function markerWindows(plan: LoadPlan): MarkerWindow[] {
  const windows: MarkerWindow[] = [];
  if (
    plan.warmupStartMs !== undefined &&
    plan.warmupEndMs !== undefined &&
    plan.warmupEndMs > plan.warmupStartMs
  ) {
    windows.push({
      kind: 'warmup',
      id: 'warmup',
      startMs: plan.warmupStartMs,
      endMs: plan.warmupEndMs,
      fields: { minutes: plan.schedule.warmup.minutes },
    });
  }
  for (const spike of plan.spikes) {
    windows.push({
      kind: 'spike',
      id: `spike:${spike.name}:${spike.startMs}`,
      startMs: spike.startMs,
      endMs: spike.endMs,
      fields: {
        name: spike.name,
        multiplier: spike.multiplier,
        size: spike.size,
        baseline: spike.baseline,
      },
    });
    if (spike.fault) {
      windows.push({
        kind: 'fault',
        id: spike.fault.id,
        startMs: spike.fault.startMs,
        endMs: spike.fault.endMs,
        fields: {
          name: spike.name,
          service: spike.fault.service,
          operation: spike.fault.operation,
          faultType: spike.fault.type,
          sizeMs: spike.fault.sizeMs,
        },
      });
    }
  }
  return windows;
}

/**
 * Edge-triggered markers. The first `poll` only records where `now` already
 * sits, so a restart inside a warm-up or spike does not emit a second start.
 */
export function createMarkerTracker(windows: readonly MarkerWindow[], nowMs: number) {
  const phase = new Map<string, 'before' | 'inside' | 'after'>();
  for (const window of windows) {
    phase.set(window.id, phaseAt(window, nowMs));
  }
  return {
    poll(now: number): MarkerEvent[] {
      const events: MarkerEvent[] = [];
      for (const window of windows) {
        const prev = phase.get(window.id) ?? 'before';
        const next = phaseAt(window, now);
        if (prev === next) {
          continue;
        }
        if (prev === 'before' && (next === 'inside' || next === 'after')) {
          events.push(markerEvent(START_MSG[window.kind], window.startMs, window.fields));
        }
        if (prev !== 'after' && next === 'after') {
          events.push(markerEvent(END_MSG[window.kind], window.endMs, window.fields));
        }
        phase.set(window.id, next);
      }
      return events;
    },
  };
}

export function zonedHour(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(utcMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value === undefined ? 0 : Number(value);
  };
  return (read('hour') % 24) + read('minute') / 60 + read('second') / 3600;
}

/** Stable unit interval in [0, 1) for a time slot. Restarts derive the same draw. */
export function unitFromSeed(seed: number, parts: readonly (string | number)[]): number {
  return mixSeed(seed, parts) / 4294967296;
}

export function mixSeed(seed: number, parts: readonly (string | number)[]): number {
  let hash = seed >>> 0;
  for (const part of parts) {
    const text = String(part);
    for (let index = 0; index < text.length; index += 1) {
      hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
    }
    hash = Math.imul(hash ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  }
  return hash >>> 0;
}

export function customerId(index: number, count = CUSTOMER_COUNT): string {
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`customer index must be 0..${count - 1}`);
  }
  return `cust-${String(index).padStart(4, '0')}`;
}

function cappedRates(plan: LoadPlan, utcMs: number): Record<Stream, number> {
  const raw = {} as Record<Stream, number>;
  let total = 0;
  for (const stream of STREAMS) {
    const rate = rawRate(plan, stream, utcMs);
    raw[stream] = rate;
    total += rate;
  }
  if (total <= plan.rateCapPerSecond || total === 0) {
    return raw;
  }
  const scale = plan.rateCapPerSecond / total;
  const scaled = {} as Record<Stream, number>;
  for (const stream of STREAMS) {
    scaled[stream] = raw[stream] * scale;
  }
  return scaled;
}

function rawRate(plan: LoadPlan, stream: Stream, utcMs: number): number {
  if (utcMs < plan.startMs || utcMs >= plan.hardStopMs || inWarmup(plan, utcMs)) {
    return 0;
  }
  const spike = spikeAt(plan, utcMs);
  const multiplier = spike?.multiplier ?? 1;
  return baseCurvePerSecond(plan.schedule, stream, utcMs) * multiplier;
}

function sampleCount(
  ratePerSec: number,
  seed: number,
  stream: Stream,
  slotStartMs: number,
): number {
  if (ratePerSec <= 0) {
    return 0;
  }
  const expected = ratePerSec * (SLOT_MS / 1000);
  const whole = Math.floor(expected);
  const fraction = expected - whole;
  const extra = unitFromSeed(seed, [stream, slotStartMs, 'count']) < fraction ? 1 : 0;
  return whole + extra;
}

function trimCounts(counts: Map<Stream, number>, capCount: number): void {
  const total = () => STREAMS.reduce((sum, stream) => sum + (counts.get(stream) ?? 0), 0);
  while (total() > capCount) {
    let victim: Stream = STREAMS[0] ?? 'browse';
    let victimCount = -1;
    for (const stream of STREAMS) {
      const count = counts.get(stream) ?? 0;
      if (count > victimCount) {
        victim = stream;
        victimCount = count;
      }
    }
    if (victimCount <= 0) {
      return;
    }
    counts.set(victim, victimCount - 1);
  }
}

function resolveSpikes(
  schedule: LoadSchedule,
  startMs: number,
  hardStopMs: number,
): SpikeInstance[] {
  const instances: SpikeInstance[] = [];
  for (const day of utcDays(startMs, hardStopMs)) {
    for (const template of schedule.spikes) {
      const start = clockOnUtcDay(day, template.at);
      if (start < startMs || start >= hardStopMs) {
        continue;
      }
      const end = start + template.durationMinutes * 60 * 1000;
      instances.push({
        name: template.name,
        startMs: start,
        endMs: end,
        multiplier: template.multiplier,
        size: 'normal',
        baseline: false,
        fault: template.fault ? resolveFault(template, start) : undefined,
      });
    }
  }
  instances.sort(
    (left, right) => left.startMs - right.startMs || left.name.localeCompare(right.name),
  );
  const first = instances[0];
  if (first) {
    first.baseline = true;
    first.size = 'normal';
    first.multiplier = multiplierFor(schedule, first.name, false);
    first.fault = undefined;
  }
  const saturationDay = addUtcDays(utcDayStart(startMs), schedule.saturation.dayOffset);
  for (const instance of instances) {
    if (instance.baseline) {
      continue;
    }
    const saturate =
      instance.name === schedule.saturation.spike &&
      utcDayStart(instance.startMs) === saturationDay;
    if (!saturate) {
      continue;
    }
    instance.size = 'saturation';
    instance.multiplier = multiplierFor(schedule, instance.name, true);
  }
  return instances;
}

function multiplierFor(schedule: LoadSchedule, name: string, saturate: boolean): number {
  const template = schedule.spikes.find((spike) => spike.name === name);
  if (!template) {
    return 1;
  }
  if (saturate) {
    return template.saturationMultiplier ?? template.multiplier;
  }
  return template.multiplier;
}

function resolveFault(template: SpikeTemplate, spikeStartMs: number): ResolvedFault {
  const fault = template.fault;
  if (!fault) {
    throw new Error(`${template.name} has no fault`);
  }
  const startMs = spikeStartMs + fault.startOffsetMinutes * 60 * 1000;
  return {
    id: `${template.name}:${new Date(startMs).toISOString()}`,
    service: fault.service,
    operation: fault.operation,
    type: fault.type,
    sizeMs: fault.sizeMs,
    probability: fault.probability,
    startMs,
    endMs: startMs + fault.durationMinutes * 60 * 1000,
  };
}

function warmupWindow(
  firstSpikeStartMs: number,
  minutes: number,
): { warmupStartMs: number; warmupEndMs: number } {
  return {
    warmupStartMs: firstSpikeStartMs - minutes * 60 * 1000,
    warmupEndMs: firstSpikeStartMs,
  };
}

function perDay(schedule: LoadSchedule, stream: Stream): number {
  switch (stream) {
    case 'cart':
      return schedule.curve.cartActivitiesPerDay;
    case 'checkout':
      return schedule.curve.checkoutsPerDay;
    case 'browse':
      return schedule.curve.browsePerDay;
    case 'orderStatus':
      return schedule.curve.orderStatusPerDay;
    default: {
      const exhaustive: never = stream;
      return exhaustive;
    }
  }
}

function utcDays(startMs: number, endMs: number): number[] {
  const days: number[] = [];
  let day = utcDayStart(startMs);
  while (day < endMs) {
    days.push(day);
    day = addUtcDays(day, 1);
  }
  return days;
}

function utcDayStart(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function addUtcDays(dayStartMs: number, days: number): number {
  return dayStartMs + days * 24 * 60 * 60 * 1000;
}

function clockOnUtcDay(dayStartMs: number, hhmm: string): number {
  const [hourRaw, minuteRaw] = hhmm.split(':');
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  return dayStartMs + hour * 60 * 60 * 1000 + minute * 60 * 1000;
}

function phaseAt(window: MarkerWindow, nowMs: number): 'before' | 'inside' | 'after' {
  if (nowMs < window.startMs) {
    return 'before';
  }
  if (nowMs < window.endMs) {
    return 'inside';
  }
  return 'after';
}

function markerEvent(msg: string, atMs: number, fields: Record<string, unknown>): MarkerEvent {
  return { msg, at: new Date(atMs).toISOString(), ...fields };
}

function parseSpike(value: unknown, index: number): SpikeTemplate {
  const record = objectRecord(value, `spikes[${index}]`);
  const spike: SpikeTemplate = {
    name: requiredText(record.name, `spikes[${index}].name`),
    at: clockTime(record.at, `spikes[${index}].at`),
    zone: utcZone(record.zone, `spikes[${index}].zone`),
    durationMinutes: positiveInt(record.durationMinutes, `spikes[${index}].durationMinutes`),
    multiplier: positiveNumber(record.multiplier, `spikes[${index}].multiplier`),
  };
  if (record.saturationMultiplier !== undefined) {
    spike.saturationMultiplier = positiveNumber(
      record.saturationMultiplier,
      `spikes[${index}].saturationMultiplier`,
    );
  }
  if (record.fault !== undefined && record.fault !== null) {
    spike.fault = parseFaultBlock(record.fault, `spikes[${index}].fault`);
  }
  return spike;
}

function parseFaultBlock(value: unknown, label: string): FaultBlock {
  const record = objectRecord(value, label);
  const type = requiredText(record.type, `${label}.type`);
  if (!isFaultBlockType(type)) {
    throw new Error(`${label}.type must be one of ${FAULT_BLOCK_TYPES.join(', ')}`);
  }
  return {
    service: requiredText(record.service, `${label}.service`),
    operation: requiredText(record.operation, `${label}.operation`),
    type,
    sizeMs: positiveInt(record.sizeMs, `${label}.sizeMs`),
    startOffsetMinutes: nonNegativeInt(record.startOffsetMinutes, `${label}.startOffsetMinutes`),
    durationMinutes: positiveInt(record.durationMinutes, `${label}.durationMinutes`),
    zone: utcZone(record.zone, `${label}.zone`),
    probability:
      record.probability === undefined
        ? 1
        : unitFraction(record.probability, `${label}.probability`),
  };
}

function isFaultBlockType(value: string): value is FaultBlockType {
  return (FAULT_BLOCK_TYPES as readonly string[]).includes(value);
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function zoneName(value: unknown, label: string): string {
  const zone = requiredText(value, label);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
  } catch {
    throw new Error(`${label} must be an IANA time zone`);
  }
  return zone;
}

function utcZone(value: unknown, label: string): string {
  const zone = requiredText(value, label);
  if (zone !== 'UTC') {
    throw new Error(`${label} must be UTC`);
  }
  return zone;
}

function utcTimestamp(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (!text.endsWith('Z')) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return new Date(parsed).toISOString();
}

function clockTime(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) {
    throw new Error(`${label} must be HH:MM`);
  }
  return text;
}

function positiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return value;
}

function unitAmplitude(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error(`${label} must be in [0, 1)`);
  }
  return value;
}

function unitFraction(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be in [0, 1]`);
  }
  return value;
}

function hourOfDay(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 24) {
    throw new Error(`${label} must be in [0, 24)`);
  }
  return value;
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return value.map((entry, index) => requiredText(entry, `${label}[${index}]`));
}
