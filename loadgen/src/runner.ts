import {
  arrivalsInSlot,
  createMarkerTracker,
  HARD_MAX_DURATION_MS,
  markerWindows,
  nextSlotStart,
  SLOT_MS,
  slotStartAt,
  type LoadPlan,
} from '@otel-demo/telemetry';
import { runArrival, type FlowState } from './flows.js';
import type { ShopClient } from './http.js';

export interface Runner {
  tick(nowMs: number): void;
}

export interface RunnerOptions {
  plan: LoadPlan;
  seed: number;
  /** Absolute UTC instant this process joined. Past slots are not replayed. */
  joinMs: number;
  client: ShopClient;
  log: (event: Record<string, unknown>) => void;
  /** Fire-and-forget. The runner does not wait for the callback to finish. */
  scheduleAt?: (delayMs: number, fn: () => void) => void;
}

export function stopAtMs(plan: LoadPlan): number {
  return Math.min(plan.hardStopMs, plan.startMs + HARD_MAX_DURATION_MS);
}

export function createRunner(options: RunnerOptions): Runner {
  const stopAt = stopAtMs(options.plan);
  const tracker = createMarkerTracker(markerWindows(options.plan), options.joinMs);
  let nextSlot = nextSlotStart(options.plan, options.joinMs);
  const state: FlowState = { carts: new Map(), orders: [] };
  const scheduleAt =
    options.scheduleAt ??
    ((delayMs, fn) => {
      const timer = setTimeout(fn, delayMs);
      timer.unref?.();
    });
  options.log({
    msg: 'runner started',
    at: new Date(options.joinMs).toISOString(),
    seed: options.seed,
  });

  return {
    tick(nowMs: number) {
      for (const event of tracker.poll(nowMs)) {
        options.log(event);
      }
      if (nowMs < options.plan.startMs || nowMs >= stopAt || nextSlot >= stopAt) {
        return;
      }
      if (nowMs < nextSlot) {
        return;
      }
      const due = slotStartAt(options.plan, nowMs);
      const fire = due >= nextSlot ? due : nextSlot;
      nextSlot = fire + SLOT_MS;
      if (fire >= stopAt) {
        return;
      }
      for (const arrival of arrivalsInSlot(options.plan, options.seed, fire)) {
        const delay = Math.max(0, arrival.atMs - nowMs);
        scheduleAt(delay, () => {
          void runArrival(arrival, {
            plan: options.plan,
            seed: options.seed,
            client: options.client,
            state,
          });
        });
      }
    },
  };
}

export async function runUntilStop(
  runner: Runner,
  options: {
    plan: LoadPlan;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    log: (event: Record<string, unknown>) => void;
    signal?: { aborted: boolean };
  },
): Promise<void> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const stopAt = stopAtMs(options.plan);
  while (!options.signal?.aborted) {
    const current = now();
    if (current >= stopAt) {
      runner.tick(current);
      options.log({ msg: 'hard stop', at: new Date(stopAt).toISOString() });
      return;
    }
    runner.tick(current);
    await sleep(250);
  }
}
