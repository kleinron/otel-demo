import { metrics, type Meter } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import {
  defaultResource,
  resourceFromAttributes,
  type DetectedResourceAttributes,
} from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK, type NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import { AlwaysOnSampler, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { resolveTelemetryConfig, type TelemetryConfig, type TelemetryOptions } from './config.js';
import { createTraceIdGenerator } from './ids.js';
import { httpServerDurationView } from './metrics.js';
import { createTracePropagator } from './propagate.js';
import { CartSpanProcessor } from './cart.js';
import { OrderSpanProcessor } from './order-span.js';

export interface TelemetryHandle {
  config: TelemetryConfig;
  started: boolean;
  shutdown: () => Promise<void>;
}

export interface StartTelemetryOptions extends TelemetryOptions {
  serviceName: string;
  env?: Record<string, string | undefined>;
}

/**
 * Build the Node SDK configuration: OTLP/HTTP exporters, W3C traceparent,
 * and explicit resource attributes. Host resource detection is off so a
 * machine address is not attached automatically.
 *
 * Trace ids follow `CLOUD_PROVIDER`. The default `aws` generator is the
 * X-Ray form (unix seconds plus random). `gcp` is 16 random bytes.
 *
 * Every trace is sampled (AlwaysOn). `cart.id` from W3C baggage is copied
 * onto every span before the batch exporter sees it.
 */
export function buildNodeSdkConfiguration(config: TelemetryConfig): Partial<NodeSDKConfiguration> {
  return {
    serviceName: config.serviceName,
    resource: telemetryResource(config),
    autoDetectResources: false,
    instrumentations: [],
    textMapPropagator: createTracePropagator(),
    idGenerator: createTraceIdGenerator(config.cloudProvider),
    sampler: new AlwaysOnSampler(),
    spanProcessors: [
      new CartSpanProcessor(),
      new OrderSpanProcessor(config.serviceName),
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: config.tracesUrl,
          headers: config.tracesHeaders,
        }),
      ),
    ],
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: config.metricsUrl,
          headers: config.metricsHeaders,
        }),
        ...(config.metricExportIntervalMillis === undefined
          ? {}
          : { exportIntervalMillis: config.metricExportIntervalMillis }),
      }),
    ],
    views: [httpServerDurationView()],
  };
}

export function createTelemetrySdk(config: TelemetryConfig): NodeSDK {
  return new NodeSDK(buildNodeSdkConfiguration(config));
}

/**
 * Start tracing and metrics export. When OTEL_SDK_DISABLED=true, returns a
 * handle that does not register global providers.
 */
export function startTelemetry(options: StartTelemetryOptions): TelemetryHandle {
  const env = options.env ?? process.env;
  const config = resolveTelemetryConfig(env, options);
  if (config.sdkDisabled) {
    return {
      config,
      started: false,
      shutdown: async () => {},
    };
  }
  const sdk = createTelemetrySdk(config);
  const logProvider = config.logsEnabled ? startLogProvider(config) : undefined;
  sdk.start();
  return {
    config,
    started: true,
    shutdown: async () => {
      await logProvider?.shutdown();
      await sdk.shutdown();
    },
  };
}

/**
 * OTLP/HTTP logs on the same endpoint and resource as traces. The pino logger
 * emits into this provider when `OTEL_LOGS_EXPORTER=otlp`. Unset leaves logs
 * on stdout only, which is the AWS and GCP path (GCP ships stdout itself).
 */
function startLogProvider(config: TelemetryConfig): LoggerProvider {
  const provider = new LoggerProvider({
    resource: telemetryResource(config),
    processors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({
          url: config.logsUrl,
          headers: config.logsHeaders,
        }),
      }),
    ],
  });
  logs.setGlobalLoggerProvider(provider);
  return provider;
}

function telemetryResource(config: TelemetryConfig) {
  return defaultResource()
    .merge(resourceFromAttributes(config.resourceAttributes))
    .merge(resourceFromAttributes(cloudRunAttributes(process.env)));
}

export function getServiceMeter(name: string, version?: string): Meter {
  return metrics.getMeter(name, version);
}

const INSTANCE_ID_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/id';

/**
 * Cloud Run resource attributes: service, revision, and instance id (from the
 * metadata server, resolved asynchronously; exporters wait for it). Empty off
 * Cloud Run (no `K_REVISION`).
 */
export function cloudRunAttributes(
  env: Record<string, string | undefined>,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): DetectedResourceAttributes {
  const revision = env.K_REVISION?.trim();
  if (!revision) {
    return {};
  }
  const instance = fetchImpl(INSTANCE_ID_URL, {
    headers: { 'Metadata-Flavor': 'Google' },
    signal: AbortSignal.timeout(2_000),
  })
    .then(async (response) => (response.ok ? (await response.text()).trim() : undefined))
    .catch(() => undefined);
  return {
    'cloud.provider': 'gcp',
    'cloud.platform': 'gcp_cloud_run',
    'faas.name': env.K_SERVICE?.trim() || undefined,
    'faas.version': revision,
    'faas.instance': instance,
    'cloud_run.revision': revision,
    'cloud_run.instance_id': instance,
  };
}
