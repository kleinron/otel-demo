/** 72 hours. The hard stop must leave room for this run plus export and teardown. */
export const RUN_DURATION_MS = 72 * 60 * 60 * 1000;

/**
 * Minimum time between "now" and the IAM deny-after instant before a deploy
 * is allowed. Five days covers the 72-hour run plus export and teardown.
 */
export const MINIMUM_LEAD_TIME_MS = 5 * 24 * 60 * 60 * 1000;

/** Teardown refuses to start a step when credentials expire inside this window. */
export const MINIMUM_SESSION_REMAINING_MS = 15 * 60 * 1000;

export interface HardStopAssessment {
  ok: boolean;
  remainingMs: number;
  minimumMs: number;
  hardStop?: Date;
  reason?: string;
}

export interface SessionAssessment {
  ok: boolean;
  longLived: boolean;
  remainingMs?: number;
  message: string;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) {
    return 'unknown';
  }
  if (ms < 0) {
    return 'expired';
  }
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes - days * 60 * 24) / 60);
  const minutes = totalMinutes % 60;
  return `${days}d ${hours}h ${minutes}m`;
}

export function assessHardStop(hardStopRaw: string | undefined, now: Date): HardStopAssessment {
  const minimumMs = MINIMUM_LEAD_TIME_MS;
  if (hardStopRaw === undefined || hardStopRaw.trim() === '') {
    return {
      ok: false,
      remainingMs: 0,
      minimumMs,
      reason: 'EXPERIMENT_HARD_STOP_UTC is not set',
    };
  }
  const hardStop = new Date(hardStopRaw.trim());
  if (Number.isNaN(hardStop.getTime())) {
    return {
      ok: false,
      remainingMs: 0,
      minimumMs,
      reason: 'EXPERIMENT_HARD_STOP_UTC is not a valid UTC timestamp',
    };
  }
  const remainingMs = hardStop.getTime() - now.getTime();
  if (remainingMs < minimumMs) {
    return {
      ok: false,
      remainingMs,
      minimumMs,
      hardStop,
      reason: `IAM deny-after leaves ${formatDuration(remainingMs)}, which is under 5 days. A 72-hour run plus export and teardown needs at least 5 days.`,
    };
  }
  return { ok: true, remainingMs, minimumMs, hardStop };
}

export function assessSession(expiration: Date | undefined, now: Date): SessionAssessment {
  if (!expiration || Number.isNaN(expiration.getTime())) {
    return {
      ok: true,
      longLived: true,
      message:
        'Session expiration: long-lived credentials (no expiry). The key owner deletes them after teardown.',
    };
  }
  const remainingMs = expiration.getTime() - now.getTime();
  if (remainingMs < MINIMUM_SESSION_REMAINING_MS) {
    return {
      ok: false,
      longLived: false,
      remainingMs,
      message: `Session expiration is ${formatDuration(remainingMs)} away, inside the 15 minute minimum. Stop and refresh credentials before the next step.`,
    };
  }
  return {
    ok: true,
    longLived: false,
    remainingMs,
    message: `Session expiration: ${formatDuration(remainingMs)} remaining.`,
  };
}

export function assessHardStopForTeardown(
  hardStopRaw: string | undefined,
  now: Date,
): { ok: boolean; message: string } {
  if (hardStopRaw === undefined || hardStopRaw.trim() === '') {
    return {
      ok: true,
      message: 'IAM deny-after: unknown (EXPERIMENT_HARD_STOP_UTC is not set).',
    };
  }
  const hardStop = new Date(hardStopRaw.trim());
  if (Number.isNaN(hardStop.getTime())) {
    return {
      ok: false,
      message: 'IAM deny-after: EXPERIMENT_HARD_STOP_UTC is not a valid UTC timestamp. Stop.',
    };
  }
  const remainingMs = hardStop.getTime() - now.getTime();
  if (remainingMs < MINIMUM_SESSION_REMAINING_MS) {
    return {
      ok: false,
      message: `IAM deny-after is ${formatDuration(remainingMs)} away, inside the 15 minute minimum. Stop and refresh credentials.`,
    };
  }
  return {
    ok: true,
    message: `IAM deny-after: ${hardStop.toISOString()} (${formatDuration(remainingMs)} remaining).`,
  };
}
