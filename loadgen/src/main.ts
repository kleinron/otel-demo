import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  applyLocalCartRate,
  applyRuntimeOverrides,
  buildPlan,
  parseLoadSchedule,
} from '@otel-demo/telemetry';
import { createLoggingClient, createUndiciClient } from './http.js';
import { writeLog } from './log.js';
import { createRunner, runUntilStop } from './runner.js';

const file =
  process.env.LOAD_SCHEDULE_FILE ?? fileURLToPath(new URL('../schedule.json', import.meta.url));
const schedule = applyLocalCartRate(
  applyRuntimeOverrides(
    parseLoadSchedule(JSON.parse(readFileSync(file, 'utf8')) as unknown),
    process.env,
  ),
  process.env,
);
const plan = buildPlan(schedule);
if (schedule.steady) {
  writeLog({
    msg: 'local cart rate',
    cartsPerMinute: process.env.LOADGEN_CARTS_PER_MINUTE?.trim(),
    cartActivitiesPerDay: schedule.curve.cartActivitiesPerDay,
    checkoutsPerDay: schedule.curve.checkoutsPerDay,
    browsePerDay: schedule.curve.browsePerDay,
    orderStatusPerDay: schedule.curve.orderStatusPerDay,
    start: schedule.experiment.start,
  });
}
const shopUrl = process.env.SHOP_URL ?? 'http://localhost:3001';
const joinMs = Date.now();
const signal = { aborted: false };
process.on('SIGTERM', () => {
  signal.aborted = true;
});
process.on('SIGINT', () => {
  signal.aborted = true;
});

const runner = createRunner({
  plan,
  seed: schedule.seed,
  joinMs,
  client: createLoggingClient(createUndiciClient(shopUrl), (event) => writeLog(event)),
  log: (event) => writeLog(event),
});

await runUntilStop(runner, { plan, log: (event) => writeLog(event), signal });
