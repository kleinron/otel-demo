import { readFileSync } from 'node:fs';
import { context, trace } from '@opentelemetry/api';
import {
  applyMatchedFault,
  clampPollInterval,
  createFaultSwitchReader,
  DEFAULT_FAULT_FAILURE_LIMIT,
  DEFAULT_FAULT_LAST_KNOWN_MS,
  DEFAULT_FAULT_POLL_MS,
  FaultInjectedError,
  startFaultControl as startSingleWindow,
  type FaultControlLog,
  type FaultController,
  type FaultSwitchReader,
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

type WindowPhase = 'pending' | 'open' | 'closed';

/**
 * Fault windows from the load schedule. A restart seeds the current phase and
 * does not emit a second start. Nothing is applied unless the kill switch is on.
 */
export function createWindowedFaultController(
  options: WindowedFaultControllerOptions,
): FaultController {
  const log = options.log ?? noopLog;
  const wallClock = options.wallClock ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const lastKnownTtlMs = options.lastKnownTtlMs ?? DEFAULT_FAULT_LAST_KNOWN_MS;
  const failureLimit = options.failureLimit ?? DEFAULT_FAULT_FAILURE_LIMIT;
  const pollIntervalMs = clampPollInterval(options.pollIntervalMs ?? DEFAULT_FAULT_POLL_MS);
  const faults = faultSpecs(options.plan);
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
          log.warn('faults off by operator', { at: new Date(now).toISOString() });
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
          entry.operation === target.operation,
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
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  return buildPlan(applyRuntimeOverrides(parseLoadSchedule(parsed), env));
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
  const reader = await createFaultSwitchReader(env);
  const pollRaw = env.FAULT_SWITCH_POLL_MS
    ? Number(env.FAULT_SWITCH_POLL_MS)
    : DEFAULT_FAULT_POLL_MS;
  const controller = createWindowedFaultController({
    plan,
    reader,
    log,
    pollIntervalMs: pollRaw,
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

function faultSpecs(plan: LoadPlan): ResolvedFault[] {
  const specs: ResolvedFault[] = [];
  for (const spike of plan.spikes) {
    if (spike.fault) {
      specs.push(spike.fault);
    }
  }
  return specs;
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
