const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/**
 * Cloud Scheduler cron for a one-shot UTC hard stop.
 * Format is `minute hour day-of-month month day-of-week`.
 * Seconds must be 00 because the schedule is minute resolution.
 * `2026-10-14T00:00:00Z` becomes `0 0 14 10 *`.
 */
export function hardStopCron(timestamp: string): string {
  const match = TIMESTAMP.exec(timestamp.trim());
  if (!match) {
    throw new Error('hard_stop_utc must be an ISO-8601 UTC timestamp');
  }
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6];
  if (
    second !== '00' ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59
  ) {
    throw new Error('hard_stop_utc must fall on a real UTC minute');
  }
  return `${minute} ${hour} ${day} ${month} *`;
}
