import { createHttpMetrics, getServiceMeter, startTelemetry } from '@otel-demo/telemetry';
import { buildApp, DEFAULT_PORT, SERVICE_NAME } from './server.js';

const telemetry = startTelemetry({ serviceName: SERVICE_NAME });
const app = buildApp({
  metrics: createHttpMetrics(getServiceMeter(SERVICE_NAME), { service: SERVICE_NAME }),
});

const port = readPort(process.env.PORT, DEFAULT_PORT);
const host = process.env.HOST ?? 'localhost';

const shutdown = async (): Promise<void> => {
  await app.close();
  await telemetry.shutdown();
};

process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});

await app.listen({ port, host });

function readPort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  return port;
}
