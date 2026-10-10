import { metrics, type Meter } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK, type NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import { resolveTelemetryConfig, type TelemetryConfig, type TelemetryOptions } from './config.js';
import { httpServerDurationView } from './metrics.js';
import { createTracePropagator } from './propagate.js';

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
 */
export function buildNodeSdkConfiguration(config: TelemetryConfig): Partial<NodeSDKConfiguration> {
  return {
    serviceName: config.serviceName,
    resource: defaultResource().merge(resourceFromAttributes(config.resourceAttributes)),
    autoDetectResources: false,
    instrumentations: [],
    textMapPropagator: createTracePropagator(),
    traceExporter: new OTLPTraceExporter({
      url: config.tracesUrl,
      headers: config.tracesHeaders,
    }),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: config.metricsUrl,
          headers: config.metricsHeaders,
        }),
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
  sdk.start();
  return {
    config,
    started: true,
    shutdown: () => sdk.shutdown(),
  };
}

export function getServiceMeter(name: string, version?: string): Meter {
  return metrics.getMeter(name, version);
}
