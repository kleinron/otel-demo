import { noteSwitchValue, readSwitch, tracedLog } from './switch-trace.js';
import { readFileSync } from 'node:fs';
import { context, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import {
  applyMatchedFault,
  clampPollInterval,
  createFaultSwitchReader,
  DEFAULT_FAULT_FAILURE_LIMIT,
  DEFAULT_FAULT_LAST_KNOWN_MS,
  DEFAULT_FAULT_POLL_MS,
  FaultInjectedError,
  readTimeoutFromEnv,
  switchOn,
  withReadTimeout,
  DEFAULT_FAULT_READ_TIMEOUT_MS,
  startFaultControl as startSingleWindow,
  type FaultControlLog,
  type FaultController,
  type FaultSwitchReader,
  type FaultSwitchValue,
} from './fault-control.js';
import type { FaultSpec } from './faults.js';
import {
  applyRuntimeOverrides,
  buildPlan,
  parseLoadSchedule,
  type LoadPlan,
  type ResolvedFault,
} from './load-schedule.js';

export interface WindowedFaultControllerOptions {
  plan: LoadPlan;
  /** When set, only this service's spike windows are armed and logged. */
  service?: string;
  reader: FaultSwitchReader;
  log?: FaultControlLog;
  wallClock?: () => number;
  random?: () => number;
  pollIntervalMs?: number;
  lastKnownTtlMs?: number;
  failureLimit?: number;
  readTimeoutMs?: number;
}

const noopLog: FaultControlLog = {
  info() {},
  warn() {},
};

type WindowPhase = 'pending' | 'open' | 'closed';

/**
 * Fault windows from the load schedule. A restart seeds the current phase and
 * does not emit a second start. Nothing is applied unless the kill switch is on.
 */
export function createWindowedFaultController(
  options: WindowedFaultControllerOptions,
): FaultController {
  const log = tracedLog(options.log ?? noopLog);
  let lastValue: FaultSwitchValue | undefined;
  let selection: FaultSwitchValue = false;
  const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_FAULT_READ_TIMEOUT_MS;
  const wallClock = options.wallClock ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const lastKnownTtlMs = options.lastKnownTtlMs ?? DEFAULT_FAULT_LAST_KNOWN_MS;
  const failureLimit = options.failureLimit ?? DEFAULT_FAULT_FAILURE_LIMIT;
  const pollIntervalMs = clampPollInterval(options.pollIntervalMs ?? DEFAULT_FAULT_POLL_MS);
  const faults = faultSpecs(options.plan, options.service);
  let enabled = false;
  let enabledAtMs: number | undefined;
  let consecutiveFailures = 0;
  let operatorOffLogged = false;
  let failSafeLogged = false;
  let active = false;
  let seeded = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const phase = new Map<string, WindowPhase>();

  function noteWindows(now: number): void {
    if (!seeded) {
      for (const fault of faults) {
        if (now >= fault.endMs) {
          phase.set(fault.id, 'closed');
        } else if (now >= fault.startMs && enabled) {
          phase.set(fault.id, 'open');
        } else {
          phase.set(fault.id, 'pending');
        }
      }
      seeded = true;
      return;
    }
    for (const fault of faults) {
      const state = phase.get(fault.id) ?? 'pending';
      if (state === 'closed') {
        continue;
      }
      if (now >= fault.endMs) {
        if (state === 'open') {
          log.info('fault window end', faultFields(fault, fault.endMs));
        }
        phase.set(fault.id, 'closed');
        continue;
      }
      if (state === 'pending' && enabled && now >= fault.startMs) {
        log.info('fault window start', faultFields(fault, fault.startMs));
        phase.set(fault.id, 'open');
      }
    }
  }

  async function pollOnce(): Promise<void> {
    const now = wallClock();
    try {
      const value = await withReadTimeout(readSwitch(options.reader), readTimeoutMs);
      noteSwitchValue(lastValue, value, log);
      lastValue = value;
      selection = value;
      consecutiveFailures = 0;
      if (switchOn(value)) {
        enabled = true;
        enabledAtMs = now;
        operatorOffLogged = false;
        failSafeLogged = false;
      } else if (enabled) {
        enabled = false;
        enabledAtMs = now;
        failSafeLogged = false;
        if (!operatorOffLogged) {
          log.warn('faults off by operator', { at: new Date(now).toISOString() });
          operatorOffLogged = true;
        }
      }
    } catch {
      // The startup read records the failure on its own span; polls stay untraced.
      consecutiveFailures += 1;
      const age = enabledAtMs === undefined ? Number.POSITIVE_INFINITY : now - enabledAtMs;
      if (enabled && consecutiveFailures >= failureLimit && age >= lastKnownTtlMs) {
        enabled = false;
        selection = false;
        lastValue = undefined;
        if (!failSafeLogged) {
          log.warn('faults off by fail-safe', {
            at: new Date(now).toISOString(),
            consecutiveFailures,
          });
          failSafeLogged = true;
        }
      }
    }
    noteWindows(now);
    active = enabled && faults.some((fault) => now >= fault.startMs && now < fault.endMs);
  }

  return {
    pollOnce,
    start() {
      if (timer !== undefined) {
        return;
      }
      timer = setInterval(() => {
        // Detach from whatever context start() ran in (e.g. the startup span).
        void context.with(ROOT_CONTEXT, () => pollOnce());
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
    async apply(target, span) {
      if (!enabled) {
        return;
      }
      const now = wallClock();
      const fault = faults.find(
        (entry) =>
          now >= entry.startMs &&
          now < entry.endMs &&
          entry.service === target.service &&
          entry.operation === target.operation &&
          (selection === true || (Array.isArray(selection) && selection.includes(entry.id))),
      );
      if (!fault) {
        return;
      }
      await applyMatchedFault([toSpec(fault)], target, span, random);
    },
  };
}

export function loadPlanFromEnv(env: Record<string, string | undefined>): LoadPlan | undefined {
  const file = env.OTEL_DEMO_LOAD_SCHEDULE_FILE?.trim();
  if (!file) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return buildPlan(applyRuntimeOverrides(parseLoadSchedule(parsed), env));
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unreadable';
    throw new Error(`fault schedule ${file} is unreadable: ${reason}`, { cause: error });
  }
}

/**
 * Uses the load schedule when `OTEL_DEMO_LOAD_SCHEDULE_FILE` is set, and the
 * single-window schedule otherwise. The kill switch is unchanged.
 */
export async function startScheduledFaultControl(
  env: Record<string, string | undefined>,
  log?: FaultControlLog,
): Promise<FaultController> {
  const plan = loadPlanFromEnv(env);
  if (!plan) {
    return startSingleWindow(env, log);
  }
  return openWindowed(plan, env, log);
}

/**
 * Arm the load-schedule windows for one service. Shop does not inject inventory
 * or payment faults, and a missing schedule file fails startup instead of
 * silently falling back to an empty single-window list.
 */
export async function startServiceFaultControl(
  service: string,
  env: Record<string, string | undefined>,
  log?: FaultControlLog,
): Promise<FaultController> {
  const file = env.OTEL_DEMO_LOAD_SCHEDULE_FILE?.trim();
  if (!file) {
    return startSingleWindow(env, log);
  }
  const plan = loadPlanFromEnv(env);
  if (!plan) {
    throw new Error(`fault schedule ${file} is unreadable`);
  }
  const controller = await openWindowed(plan, env, log, service);
  log?.info('fault schedule loaded', {
    service,
    schedule: file,
    operations: serviceOperations(plan, service),
  });
  return controller;
}

async function openWindowed(
  plan: LoadPlan,
  env: Record<string, string | undefined>,
  log: FaultControlLog | undefined,
  service?: string,
): Promise<FaultController> {
  const reader = await createFaultSwitchReader(env);
  const pollRaw = env.FAULT_SWITCH_POLL_MS
    ? Number(env.FAULT_SWITCH_POLL_MS)
    : DEFAULT_FAULT_POLL_MS;
  const controller = createWindowedFaultController({
    plan,
    service,
    reader,
    log,
    pollIntervalMs: pollRaw,
    readTimeoutMs: readTimeoutFromEnv(env),
  });
  await controller.pollOnce();
  controller.start();
  return controller;
}

/**
 * Call before a database statement. A scheduled timeout sleeps, then fails the
 * statement so the SQL client records `outcome=timeout`. `ping` is left alone
 * so startup can still reach Postgres.
 */
export function databaseFaultHook(
  faults: FaultController,
  service: string,
): (operation: string) => Promise<void> {
  return async (operation) => {
    if (operation === 'ping') {
      return;
    }
    const active = trace.getSpan(context.active());
    const span = active ?? trace.getTracer(service).startSpan('database');
    try {
      await faults.apply({ service, operation: 'database' }, span);
    } catch (error) {
      if (error instanceof FaultInjectedError && error.faultType === 'timeout') {
        throw new Error(`database timeout during ${operation}`, { cause: error });
      }
      throw error;
    } finally {
      if (!active) {
        span.end();
      }
    }
  };
}

/** Error thrown by {@link databaseAttemptHook}; `ETIMEDOUT` makes the pool retry it. */
export class InjectedDatabaseTimeout extends Error {
  readonly code = 'ETIMEDOUT';
  constructor(cause: unknown) {
    super('injected database timeout (connection timeout)', { cause });
    this.name = 'InjectedDatabaseTimeout';
  }
}

/**
 * Pass as the pg pool's `beforeAttempt`. Runs on every attempt, so a
 * `database` timeout fault fails each retry, not just the first try, and the
 * query span shows every `db.retry` event and `db.retry.exhausted`.
 */
export function databaseAttemptHook(faults: FaultController, service: string): () => Promise<void> {
  return async () => {
    const span = trace.getSpan(context.active());
    if (!span) {
      return;
    }
    try {
      await faults.apply({ service, operation: 'database' }, span);
    } catch (error) {
      if (error instanceof FaultInjectedError && error.faultType === 'timeout') {
        throw new InjectedDatabaseTimeout(error);
      }
      throw error;
    }
  };
}

function faultSpecs(plan: LoadPlan, service?: string): ResolvedFault[] {
  const specs: ResolvedFault[] = [];
  for (const spike of plan.spikes) {
    if (!spike.fault) {
      continue;
    }
    if (service !== undefined && spike.fault.service !== service) {
      continue;
    }
    specs.push(spike.fault);
  }
  return specs;
}

function serviceOperations(plan: LoadPlan, service: string): string[] {
  return [...new Set(faultSpecs(plan, service).map((fault) => fault.operation))].sort();
}

function toSpec(fault: ResolvedFault): FaultSpec {
  return {
    id: fault.id,
    type: fault.type,
    service: fault.service,
    operation: fault.operation,
    probability: fault.probability,
    delayMs: fault.sizeMs,
  };
}

function faultFields(fault: ResolvedFault, atMs: number): Record<string, unknown> {
  return {
    at: new Date(atMs).toISOString(),
    name: fault.id,
    service: fault.service,
    operation: fault.operation,
    faultType: fault.type,
    sizeMs: fault.sizeMs,
  };
}
