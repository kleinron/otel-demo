export function writeLog(event: Record<string, unknown>, nowMs = Date.now()): void {
  const line = { time: new Date(nowMs).toISOString(), ...event };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}
