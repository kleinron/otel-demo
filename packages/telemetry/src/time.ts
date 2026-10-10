/**
 * Monotonic milliseconds since an arbitrary origin.
 * Use this for durations. Log timestamps come from the logger, not from this clock.
 */
export function now(): number {
  return performance.now();
}
