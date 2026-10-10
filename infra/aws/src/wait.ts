import type { SleepOptions } from './types.js';

export async function waitUntil(
  ready: () => Promise<boolean>,
  options: SleepOptions,
): Promise<boolean> {
  for (let attempt = 0; attempt < options.waitAttempts; attempt += 1) {
    if (await ready()) {
      return true;
    }
    if (attempt < options.waitAttempts - 1) {
      await options.sleep(options.waitIntervalMs);
    }
  }
  return false;
}
