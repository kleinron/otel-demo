import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { resolveCloudProvider, type CloudProvider } from './cloud.js';
import { parseKeyValueList, resolveOtlpEndpoints, type OtlpEndpoints } from './otlp.js';

export interface TelemetryOptions {
  serviceName?: string;
  serviceVersion?: string;
}

export interface TelemetryConfig extends OtlpEndpoints {
  sdkDisabled: boolean;
  serviceName: string;
  resourceAttributes: Record<string, string>;
  protocol: 'http/protobuf';
  propagator: 'w3c-tracecontext';
  /** `aws` keeps X-Ray-style trace ids. `gcp` uses standard W3C random ids. */
  cloudProvider: CloudProvider;
  /** OTLP log export. Unset `OTEL_LOGS_EXPORTER` keeps stdout-only logs. */
  logsEnabled: boolean;
  /**
   * `OTEL_METRIC_EXPORT_INTERVAL` in milliseconds. Unset keeps the SDK
   * default (60s).
   */
  metricExportIntervalMillis?: number;
}

export function resolveTelemetryConfig(
  env: Record<string, string | undefined>,
  options: TelemetryOptions = {},
): TelemetryConfig {
  const resourceFromEnv = parseKeyValueList(env.OTEL_RESOURCE_ATTRIBUTES);
  const serviceName =
    env.OTEL_SERVICE_NAME?.trim() ||
    options.serviceName?.trim() ||
    resourceFromEnv[ATTR_SERVICE_NAME]?.trim();
  if (!serviceName) {
    throw new Error('service.name is required. Pass serviceName or set OTEL_SERVICE_NAME.');
  }

  const resourceAttributes: Record<string, string> = {
    ...resourceFromEnv,
    [ATTR_SERVICE_NAME]: serviceName,
  };
  const serviceVersion =
    env.OTEL_SERVICE_VERSION?.trim() ||
    options.serviceVersion?.trim() ||
    resourceAttributes[ATTR_SERVICE_VERSION]?.trim();
  if (serviceVersion) {
    resourceAttributes[ATTR_SERVICE_VERSION] = serviceVersion;
  }
  const deployment = env.DEPLOYMENT_ENVIRONMENT?.trim();
  if (deployment && !resourceAttributes[ATTR_DEPLOYMENT_ENVIRONMENT_NAME]) {
    resourceAttributes[ATTR_DEPLOYMENT_ENVIRONMENT_NAME] = deployment;
  }

  const sdkDisabled = isSdkDisabled(env.OTEL_SDK_DISABLED);
  return {
    sdkDisabled,
    serviceName,
    resourceAttributes,
    protocol: 'http/protobuf',
    propagator: 'w3c-tracecontext',
    cloudProvider: resolveCloudProvider(env),
    logsEnabled: !sdkDisabled && logsExportRequested(env),
    metricExportIntervalMillis: metricExportInterval(env),
    ...resolveOtlpEndpoints(env),
  };
}

/** `OTEL_LOGS_EXPORTER=otlp` copies JSON logs to the collector. Unset and `none` do not. */
export function logsExportRequested(env: Record<string, string | undefined>): boolean {
  const raw = env.OTEL_LOGS_EXPORTER?.trim().toLowerCase() ?? '';
  if (raw === '' || raw === 'none') {
    return false;
  }
  if (raw === 'otlp') {
    return true;
  }
  throw new Error(`OTEL_LOGS_EXPORTER must be otlp or none (received ${raw})`);
}

function metricExportInterval(env: Record<string, string | undefined>): number | undefined {
  const raw = env.OTEL_METRIC_EXPORT_INTERVAL?.trim();
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1000) {
    throw new Error(
      'OTEL_METRIC_EXPORT_INTERVAL must be an integer number of milliseconds, at least 1000',
    );
  }
  return value;
}

function isSdkDisabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}
