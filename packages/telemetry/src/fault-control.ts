import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { SpanStatusCode, type Span } from '@opentelemetry/api';
import { markFaultFlag } from './context.js';
import {
  FAULT_ID_ATTRIBUTE,
  FAULT_INJECTED_ATTRIBUTE,
  FAULT_TYPE_ATTRIBUTE,
  matchingFaults,
  noteConfiguredFault,
  parseFaultSpecs,
  type FaultSpec,
  type FaultTarget,
  type FaultType,
} from './faults.js';

export const DEFAULT_FAULT_POLL_MS = 7_500;
export const MIN_FAULT_POLL_MS = 5_000;
export const MAX_FAULT_POLL_MS = 10_000;
export const DEFAULT_FAULT_LAST_KNOWN_MS = 60_000;
export const DEFAULT_FAULT_FAILURE_LIMIT = 3;

export interface FaultSwitchReader {
  /** `true` enables faults. Throw when the switch cannot be read. */
  read(): Promise<boolean>;
}

export interface FaultSchedule {
  faults: readonly FaultSpec[];
  /** Inclusive start, epoch milliseconds. Omitted means the window is already open. */
  windowStartMs?: number;
  /** Exclusive end, epoch milliseconds. Omitted means the window does not auto-stop. */
  windowEndMs?: number;
}

export interface FaultControlLog {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface FaultController {
  pollOnce(): Promise<void>;
  start(): void;
  stop(): void;
  isActive(): boolean;
  apply(target: FaultTarget, span: Span): Promise<void>;
}

export interface FaultControllerOptions {
  schedule: FaultSchedule;
  reader: FaultSwitchReader;
  log?: FaultControlLog;
  wallClock?: () => number;
  random?: () => number;
  pollIntervalMs?: number;
  lastKnownTtlMs?: number;
  failureLimit?: number;
}

const noopLog: FaultControlLog = {
  info() {},
  warn() {},
};

/** Poll interval clamped to the 5–10s band. */
export function clampPollInterval(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_FAULT_POLL_MS;
  }
  return Math.min(MAX_FAULT_POLL_MS, Math.max(MIN_FAULT_POLL_MS, value));
}

export class FaultInjectedError extends Error {
  readonly faultId: string;
  readonly faultType: FaultType;

  constructor(fault: FaultSpec) {
    super(`fault ${fault.id} injected`);
    this.name = 'FaultInjectedError';
    this.faultId = fault.id;
    this.faultType = fault.type;
  }
}

/**
 * Apply the first matching fault that passes its probability roll.
 * Delay records `fault.injected` and then waits. Error, timeout, and drop
 * also set span status ERROR and throw {@link FaultInjectedError}.
 * A matched fault that fails its roll is recorded with `noteConfiguredFault`.
 */
export async function applyMatchedFault(
  faults: readonly FaultSpec[],
  target: FaultTarget,
  span: Span,
  random: () => number = Math.random,
): Promise<void> {
  const matched = matchingFaults(faults, target);
  if (matched.length === 0) {
    return;
  }
  const selected = matched.find((fault) => {
    const probability = fault.probability ?? 1;
    return probability >= 1 || random() < probability;
  });
  if (!selected) {
    noteConfiguredFault({ enabled: true, faults: matched }, target, span);
    return;
  }
  markFaultFlag(FAULT_INJECTED_ATTRIBUTE);
  span.setAttribute(FAULT_INJECTED_ATTRIBUTE, true);
  span.setAttribute(FAULT_ID_ATTRIBUTE, [selected.id]);
  span.setAttribute(FAULT_TYPE_ATTRIBUTE, [selected.type]);
  if (selected.type === 'delay') {
    await sleep(selected.delayMs ?? 0);
    return;
  }
  span.setStatus({ code: SpanStatusCode.ERROR, message: selected.type });
  if ((selected.delayMs ?? 0) > 0) {
    await sleep(selected.delayMs ?? 0);
  }
  throw new FaultInjectedError(selected);
}

/**
 * Read the fault list and window once. The kill switch is polled separately.
 * `OTEL_DEMO_FAULT_SCHEDULE_FILE` wins, then `OTEL_DEMO_FAULT_SCHEDULE`, then
 * `OTEL_DEMO_FAULTS` plus optional window start/end variables.
 */
export function loadFaultSchedule(env: Record<string, string | undefined>): FaultSchedule {
  const file = env.OTEL_DEMO_FAULT_SCHEDULE_FILE?.trim();
  if (file) {
    return parseScheduleJson(readFileSync(file, 'utf8'), file);
  }
  const inline = env.OTEL_DEMO_FAULT_SCHEDULE?.trim();
  if (inline) {
    return parseScheduleJson(inline, 'OTEL_DEMO_FAULT_SCHEDULE');
  }
  const faults = env.OTEL_DEMO_FAULTS?.trim()
    ? parseFaultSpecs(parseJson(env.OTEL_DEMO_FAULTS, 'OTEL_DEMO_FAULTS'))
    : [];
  const schedule: FaultSchedule = { faults };
  if (env.OTEL_DEMO_FAULT_WINDOW_START?.trim()) {
    schedule.windowStartMs = parseTime(
      env.OTEL_DEMO_FAULT_WINDOW_START,
      'OTEL_DEMO_FAULT_WINDOW_START',
    );
  }
  if (env.OTEL_DEMO_FAULT_WINDOW_END?.trim()) {
    schedule.windowEndMs = parseTime(env.OTEL_DEMO_FAULT_WINDOW_END, 'OTEL_DEMO_FAULT_WINDOW_END');
  }
  assertWindow(schedule);
  return schedule;
}

export function createEnvFaultSwitch(readValue: () => string | undefined): FaultSwitchReader {
  return {
    async read() {
      const value = readValue();
      if (value === undefined || value.trim() === '') {
        return false;
      }
      return parseSwitchValue(value);
    },
  };
}

export function createFileFaultSwitch(path: string): FaultSwitchReader {
  return {
    async read() {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unreadable';
        throw new Error(`fault switch file is unreadable: ${message}`, { cause: error });
      }
      if (text.trim() === '') {
        throw new Error('fault switch file is empty');
      }
      return parseSwitchValue(text);
    },
  };
}

/**
 * `env` reads `OTEL_DEMO_FAULTS_ENABLED`. `file` reads `FAULT_SWITCH_FILE`.
 * `module` loads `FAULT_SWITCH_MODULE`, which must export `createFaultSwitch`.
 * SSM is intentionally not implemented here; the AWS reader lives under infra/aws.
 */
export async function createFaultSwitchReader(
  env: Record<string, string | undefined>,
): Promise<FaultSwitchReader> {
  const source = (env.FAULT_SWITCH_SOURCE ?? 'env').trim().toLowerCase();
  if (source === 'env') {
    return createEnvFaultSwitch(() => env.OTEL_DEMO_FAULTS_ENABLED);
  }
  if (source === 'file') {
    const path = env.FAULT_SWITCH_FILE?.trim();
    if (!path) {
      throw new Error('FAULT_SWITCH_FILE is required when FAULT_SWITCH_SOURCE=file');
    }
    return createFileFaultSwitch(path);
  }
  if (source === 'module') {
    const specifier = env.FAULT_SWITCH_MODULE?.trim();
    if (!specifier) {
      throw new Error('FAULT_SWITCH_MODULE is required when FAULT_SWITCH_SOURCE=module');
    }
    const imported = (await import(specifier)) as {
      createFaultSwitch?: (sourceEnv: Record<string, string | undefined>) => FaultSwitchReader;
    };
    if (typeof imported.createFaultSwitch !== 'function') {
      throw new Error('fault switch module must export createFaultSwitch');
    }
    return imported.createFaultSwitch(env);
  }
  if (source === 'ssm') {
    throw new Error(
      'FAULT_SWITCH_SOURCE=ssm cannot be loaded from application code. Set FAULT_SWITCH_SOURCE=module and FAULT_SWITCH_MODULE to the infra fault-switch module.',
    );
  }
  throw new Error(`Unknown FAULT_SWITCH_SOURCE ${source}`);
}

export function createFaultController(options: FaultControllerOptions): FaultController {
  const log = options.log ?? noopLog;
  const wallClock = options.wallClock ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const lastKnownTtlMs = options.lastKnownTtlMs ?? DEFAULT_FAULT_LAST_KNOWN_MS;
  const failureLimit = options.failureLimit ?? DEFAULT_FAULT_FAILURE_LIMIT;
  const pollIntervalMs = clampPollInterval(options.pollIntervalMs ?? DEFAULT_FAULT_POLL_MS);
  let enabled = false;
  let enabledAtMs: number | undefined;
  let consecutiveFailures = 0;
  let operatorOffLogged = false;
  let failSafeLogged = false;
  let windowStartLogged = false;
  let windowEndLogged = false;
  let active = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function pollOnce(): Promise<void> {
    const now = wallClock();
    try {
      const value = await options.reader.read();
      consecutiveFailures = 0;
      if (value) {
        enabled = true;
        enabledAtMs = now;
        operatorOffLogged = false;
        failSafeLogged = false;
      } else if (enabled) {
        enabled = false;
        enabledAtMs = now;
        failSafeLogged = false;
        if (!operatorOffLogged) {
          log.warn('faults off by operator', { at: isoUtc(now) });
          operatorOffLogged = true;
        }
      }
    } catch {
      consecutiveFailures += 1;
      const age = enabledAtMs === undefined ? Number.POSITIVE_INFINITY : now - enabledAtMs;
      if (enabled && consecutiveFailures >= failureLimit && age >= lastKnownTtlMs) {
        enabled = false;
        if (!failSafeLogged) {
          log.warn('faults off by fail-safe', {
            at: isoUtc(now),
            consecutiveFailures,
          });
          failSafeLogged = true;
        }
      }
    }

    const windowEnd = options.schedule.windowEndMs;
    const ended = windowEnd !== undefined && now >= windowEnd;
    const started =
      options.schedule.windowStartMs === undefined || now >= options.schedule.windowStartMs;
    const inWindow = started && !ended;
    if (
      ended &&
      !windowEndLogged &&
      options.schedule.faults.length > 0 &&
      windowEnd !== undefined
    ) {
      log.info('fault window end', { at: isoUtc(windowEnd) });
      windowEndLogged = true;
    }
    active = enabled && inWindow && options.schedule.faults.length > 0;
    if (active && !windowStartLogged) {
      log.info('fault window start', { at: isoUtc(now) });
      windowStartLogged = true;
    }
  }

  return {
    pollOnce,
    start() {
      if (timer !== undefined) {
        return;
      }
      timer = setInterval(() => {
        void pollOnce();
      }, pollIntervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    isActive() {
      return active;
    },
    async apply(target: FaultTarget, span: Span) {
      if (!active) {
        return;
      }
      const now = wallClock();
      const windowEnd = options.schedule.windowEndMs;
      if (windowEnd !== undefined && now >= windowEnd) {
        return;
      }
      const windowStart = options.schedule.windowStartMs;
      if (windowStart !== undefined && now < windowStart) {
        return;
      }
      await applyMatchedFault(options.schedule.faults, target, span, random);
    },
  };
}

export async function startFaultControl(
  env: Record<string, string | undefined>,
  log?: FaultControlLog,
): Promise<FaultController> {
  const schedule = loadFaultSchedule(env);
  const reader = await createFaultSwitchReader(env);
  const pollRaw = env.FAULT_SWITCH_POLL_MS
    ? Number(env.FAULT_SWITCH_POLL_MS)
    : DEFAULT_FAULT_POLL_MS;
  const controller = createFaultController({
    schedule,
    reader,
    log,
    pollIntervalMs: pollRaw,
  });
  await controller.pollOnce();
  controller.start();
  return controller;
}

function parseScheduleJson(raw: string, label: string): FaultSchedule {
  const parsed = parseJson(raw, label);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  const schedule: FaultSchedule = {
    faults: parseFaultSpecs(record.faults ?? []),
  };
  if (record.windowStart !== undefined) {
    schedule.windowStartMs = parseTime(record.windowStart, `${label} windowStart`);
  }
  if (record.windowEnd !== undefined) {
    schedule.windowEndMs = parseTime(record.windowEnd, `${label} windowEnd`);
  }
  assertWindow(schedule);
  return schedule;
}

function assertWindow(schedule: FaultSchedule): void {
  if (
    schedule.windowStartMs !== undefined &&
    schedule.windowEndMs !== undefined &&
    schedule.windowEndMs <= schedule.windowStartMs
  ) {
    throw new Error('fault windowEnd must be after windowStart');
  }
}

function parseTime(value: unknown, label: string): number {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return parsed;
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} must be JSON`);
  }
}

export function parseSwitchValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'off') {
    return false;
  }
  throw new Error('fault switch value is unreadable');
}

function isoUtc(ms: number): string {
  return new Date(ms).toISOString();
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
