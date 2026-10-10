import { connectPg } from '@otel-demo/db';
import { installSignalShutdown, listenHost, readPort, readTimeoutMs } from '@otel-demo/httpkit';
import {
  createHttpMetrics,
  createLogger,
  createOutboundMetrics,
  databaseFaultHook,
  getServiceMeter,
  startFaultControl,
  startTelemetry,
} from '@otel-demo/telemetry';
import { migrateShop } from './schema.js';
import { buildApp, DEFAULT_PORT, SERVICE_NAME } from './server.js';

const env = process.env;
const telemetry = startTelemetry({ serviceName: SERVICE_NAME });
const logger = createLogger({ service: SERVICE_NAME });
const meter = getServiceMeter(SERVICE_NAME);
const metrics = createHttpMetrics(meter, { service: SERVICE_NAME });
const outbound = createOutboundMetrics(meter, { service: SERVICE_NAME });
const faults = await startFaultControl(env, {
  info(message, fields) {
    logger.info(fields ?? {}, message);
  },
  warn(message, fields) {
    logger.warn(fields ?? {}, message);
  },
});
const sql = await connectPg(requiredEnv(env.DATABASE_URL, 'DATABASE_URL'), {
  timeoutMs: readTimeoutMs(env.DB_STATEMENT_TIMEOUT_MS, 5_000),
  beforeQuery: databaseFaultHook(faults, SERVICE_NAME),
  onCall(event) {
    outbound.record({
      target: 'database',
      operation: event.operation,
      outcome: event.outcome,
    });
  },
});
await migrateShop(sql);
const app = buildApp({
  metrics,
  outbound,
  logger,
  sql,
  faults,
  inventoryUrl: requiredEnv(env.INVENTORY_URL, 'INVENTORY_URL'),
  paymentUrl: requiredEnv(env.PAYMENT_URL, 'PAYMENT_URL'),
  deliveryUrl: requiredEnv(env.DELIVERY_URL, 'DELIVERY_URL'),
  timeoutMs: readTimeoutMs(env.OUTBOUND_TIMEOUT_MS, 2_000),
});
const port = readPort(env.PORT, DEFAULT_PORT);
const host = listenHost(env);

installSignalShutdown(async () => {
  faults.stop();
  await app.close();
  await sql.close();
  await telemetry.shutdown();
});

await app.listen({ port, host });
logger.info({ port }, 'listening');

function requiredEnv(value: string | undefined, name: string): string {
  if (!value || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}
