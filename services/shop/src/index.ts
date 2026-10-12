import { createPgSql, migrateInBackground, type PgSqlOptions, type Sql } from '@otel-demo/db';
import { installSignalShutdown, listenHost, readPort, readTimeoutMs } from '@otel-demo/httpkit';
import {
  createHttpMetrics,
  createLogger,
  createOutboundMetrics,
  databaseFaultHook,
  getServiceMeter,
  startServiceFaultControl,
  startTelemetry,
  type FaultController,
} from '@otel-demo/telemetry';
import { pathToFileURL } from 'node:url';
import { migrateShop } from './schema.js';
import { buildApp, DEFAULT_PORT, SERVICE_NAME } from './server.js';

export interface ShopHandle {
  faults: FaultController;
  close: () => Promise<void>;
}

export async function startShop(
  env: Record<string, string | undefined> = process.env,
  deps: {
    connect?: (connectionString: string, options?: PgSqlOptions) => Promise<Sql>;
  } = {},
): Promise<ShopHandle> {
  const telemetry = startTelemetry({ serviceName: SERVICE_NAME, env });
  const logger = createLogger({ service: SERVICE_NAME, level: env.LOG_LEVEL });
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
  const connect =
    deps.connect ?? (async (url: string, options?: PgSqlOptions) => createPgSql(url, options));
  const sql = await connect(requiredEnv(env.DATABASE_URL, 'DATABASE_URL'), {
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
  try {
    // Do not block startup on the database; /ready reflects migration + DB state.
    const readiness = migrateInBackground(sql, migrateShop, {
      onError(error, attempt) {
        logger.warn({ err: error, attempt }, 'database migration pending');
      },
    });
    const app = buildApp({
      ready: () => readiness.ready(),
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
    await app.listen({ port, host });
    logger.info({ port }, 'listening');

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      faults.stop();
      readiness.stop();
      await app.close();
      await sql.close();
      await telemetry.shutdown();
    };
    installSignalShutdown(close);
    return { faults, close };
  } catch (error) {
    faults.stop();
    await sql.close().catch(() => undefined);
    await telemetry.shutdown().catch(() => undefined);
    throw error;
  }
}

function requiredEnv(value: string | undefined, name: string): string {
  if (!value || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  await startShop();
}
