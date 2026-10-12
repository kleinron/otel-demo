import { createPgSql, migrateInBackground } from '@otel-demo/db';
import { installSignalShutdown, listenHost, readPort, readTimeoutMs } from '@otel-demo/httpkit';
import {
  createHttpMetrics,
  createLogger,
  createOutboundMetrics,
  databaseFaultHook,
  getServiceMeter,
  startServiceFaultControl,
  inRootSpan,
  startTelemetry,
} from '@otel-demo/telemetry';
import { migrateDelivery } from './schema.js';
import { buildApp, DEFAULT_PORT, SERVICE_NAME } from './server.js';

const env = process.env;
const telemetry = startTelemetry({ serviceName: SERVICE_NAME });
const logger = createLogger({ service: SERVICE_NAME });
// Startup runs in its own root span so every startup log line is traced.
await inRootSpan(SERVICE_NAME, 'startup', async () => {
  const meter = getServiceMeter(SERVICE_NAME);
  const metrics = createHttpMetrics(meter, { service: SERVICE_NAME });
  const outbound = createOutboundMetrics(meter, { service: SERVICE_NAME });
  const faults = await startServiceFaultControl(SERVICE_NAME, env, {
    info(message, fields) {
      logger.info(fields ?? {}, message);
    },
    warn(message, fields) {
      logger.warn(fields ?? {}, message);
    },
  });
  const sql = createPgSql(requiredEnv(env.DATABASE_URL, 'DATABASE_URL'), {
    timeoutMs: readTimeoutMs(env.DB_STATEMENT_TIMEOUT_MS, 5_000),
    beforeQuery: databaseFaultHook(faults, SERVICE_NAME),
    onConnectionError(error) {
      logger.warn({ err: error }, 'database connection error');
    },
    onCall(event) {
      outbound.record({
        target: 'database',
        operation: event.operation,
        outcome: event.outcome,
      });
    },
  });
  // Do not block startup on the database: the server listens immediately and
  // /ready reports not-ready until the migration has run and the DB answers.
  const readiness = migrateInBackground(sql, migrateDelivery, {
    onError(error, attempt) {
      logger.warn({ err: error, attempt }, 'database migration pending');
    },
  });
  const app = buildApp({ ready: () => readiness.ready(), metrics, logger, sql, faults });
  const port = readPort(env.PORT, DEFAULT_PORT);
  const host = listenHost(env);

  installSignalShutdown(async () => {
    faults.stop();
    readiness.stop();
    await app.close();
    await sql.close();
    await telemetry.shutdown();
  });

  await app.listen({ port, host });
  logger.info({ port }, 'listening');
});

function requiredEnv(value: string | undefined, name: string): string {
  if (!value || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}
