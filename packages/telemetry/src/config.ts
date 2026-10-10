import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
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

  return {
    sdkDisabled: isSdkDisabled(env.OTEL_SDK_DISABLED),
    serviceName,
    resourceAttributes,
    protocol: 'http/protobuf',
    propagator: 'w3c-tracecontext',
    ...resolveOtlpEndpoints(env),
  };
}

function isSdkDisabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}
