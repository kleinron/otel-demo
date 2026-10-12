import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseLoadSchedule, startTelemetry } from '@otel-demo/telemetry';
import { runCartTick } from './cart-tick.js';

/**
 * Cloud Run job entry: one tick of simulated cart journeys against the shop.
 * SHOP_URL is required. SHOP_AUDIENCE, when set, adds a Cloud Run identity
 * token from the metadata server. LOAD_STOP_AT (ISO UTC) disables the tick.
 * LOADGEN_TRACING=on starts the OTel SDK (OTLP to OTEL_EXPORTER_OTLP_ENDPOINT,
 * e.g. a collector sidecar) so each shopper step exports a root span.
 */
const tracing = process.env.LOADGEN_TRACING?.trim().toLowerCase() === 'on';
if (tracing && process.env.LOADGEN_OTLP_TARGET?.trim() === 'gcp-telemetry-api') {
  await useTelemetryApi(process.env);
}
const telemetry = tracing ? startTelemetry({ serviceName: 'loadgen' }) : undefined;

/**
 * Send spans straight to the Cloud Telemetry API (OTLP) with the job's own
 * access token from the metadata server (the job runs < 90s, the token lasts
 * ~1h). Needs telemetry.traces.write (in roles/cloudtrace.agent).
 */
async function useTelemetryApi(env: NodeJS.ProcessEnv): Promise<void> {
  const response = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } },
  );
  if (!response.ok) {
    throw new Error(`metadata token read failed: ${response.status}`);
  }
  const body = (await response.json()) as { access_token?: string };
  const project = env.GCP_PROJECT_ID?.trim() ?? '';
  env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'https://telemetry.googleapis.com/v1/traces';
  env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = `authorization=Bearer ${body.access_token ?? ''},x-goog-user-project=${project}`;
  env.OTEL_RESOURCE_ATTRIBUTES = [env.OTEL_RESOURCE_ATTRIBUTES, `gcp.project_id=${project}`]
    .filter(Boolean)
    .join(',');
}
const shopUrl = process.env.SHOP_URL?.trim();
if (!shopUrl) {
  throw new Error('SHOP_URL is required');
}
const file =
  process.env.LOAD_SCHEDULE_FILE ?? fileURLToPath(new URL('../schedule.json', import.meta.url));
const schedule = parseLoadSchedule(JSON.parse(readFileSync(file, 'utf8')) as unknown);
const audience = process.env.SHOP_AUDIENCE?.trim();
let token: { value: string; expiresMs: number } | undefined;

async function authHeaders(): Promise<Record<string, string>> {
  if (!audience) {
    return {};
  }
  if (!token || token.expiresMs < Date.now()) {
    const response = await fetch(
      `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`,
      { headers: { 'Metadata-Flavor': 'Google' } },
    );
    if (!response.ok) {
      throw new Error(`identity token request failed with ${response.status}`);
    }
    token = { value: await response.text(), expiresMs: Date.now() + 30 * 60_000 };
  }
  return { authorization: `Bearer ${token.value}` };
}

const stopAt = process.env.LOAD_STOP_AT?.trim();
await runCartTick({
  shopUrl,
  carts: Number(process.env.LOAD_CARTS ?? '12'),
  spacingMs: Number(process.env.LOAD_SPACING_MS ?? '5000'),
  skus: schedule.skus,
  customerCount: schedule.customers.count,
  stopAt: stopAt ? new Date(stopAt) : undefined,
  authHeaders,
  projectId: process.env.GCP_PROJECT_ID?.trim() || undefined,
});
await telemetry?.shutdown();
