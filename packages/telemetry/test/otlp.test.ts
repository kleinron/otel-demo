import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OTLP_HTTP_ENDPOINT,
  resolveOtlpEndpoints,
  resolveTelemetryConfig,
  startTelemetry,
} from '../src/index.js';

describe('OTLP configuration', () => {
  it('appends signal paths to the base endpoint', () => {
    const endpoints = resolveOtlpEndpoints({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318/',
    });

    expect(endpoints.tracesUrl).toBe('http://localhost:4318/v1/traces');
    expect(endpoints.metricsUrl).toBe('http://localhost:4318/v1/metrics');
  });

  it('uses the spec default endpoint when none is set', () => {
    const endpoints = resolveOtlpEndpoints({});

    expect(endpoints.tracesUrl).toBe(`${DEFAULT_OTLP_HTTP_ENDPOINT}/v1/traces`);
    expect(endpoints.metricsUrl).toBe(`${DEFAULT_OTLP_HTTP_ENDPOINT}/v1/metrics`);
  });

  it('lets signal-specific endpoints and headers override the base', () => {
    const endpoints = resolveOtlpEndpoints({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.internal:4318',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://traces.collector.internal/v1/traces',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://metrics.collector.internal/v1/metrics',
      OTEL_EXPORTER_OTLP_HEADERS: 'x-team=demo,Authorization=Bearer%20shared',
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'Authorization=Bearer%20traces',
    });

    expect(endpoints.tracesUrl).toBe('https://traces.collector.internal/v1/traces');
    expect(endpoints.metricsUrl).toBe('https://metrics.collector.internal/v1/metrics');
    expect(endpoints.tracesHeaders).toEqual({
      'x-team': 'demo',
      Authorization: 'Bearer traces',
    });
    expect(endpoints.metricsHeaders).toEqual({
      'x-team': 'demo',
      Authorization: 'Bearer shared',
    });
  });

  it('rejects non-HTTP protocols and exporters other than OTLP/HTTP protobuf', () => {
    expect(() => resolveOtlpEndpoints({ OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' })).toThrow(
      /http\/protobuf/,
    );
    expect(() =>
      resolveOtlpEndpoints({ OTEL_EXPORTER_OTLP_ENDPOINT: 'unix:///tmp/otlp.sock' }),
    ).toThrow(/http or https/);
  });
});

describe('resource attributes', () => {
  it('sets service name, version, and deployment environment', () => {
    const config = resolveTelemetryConfig(
      {
        OTEL_SERVICE_VERSION: '0.1.0',
        DEPLOYMENT_ENVIRONMENT: 'ci',
        OTEL_RESOURCE_ATTRIBUTES: 'team=demo',
      },
      { serviceName: 'shop' },
    );

    expect(config.serviceName).toBe('shop');
    expect(config.propagator).toBe('w3c-tracecontext');
    expect(config.protocol).toBe('http/protobuf');
    expect(config.resourceAttributes).toEqual({
      team: 'demo',
      [ATTR_SERVICE_NAME]: 'shop',
      [ATTR_SERVICE_VERSION]: '0.1.0',
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: 'ci',
    });
  });

  it('lets OTEL_SERVICE_NAME override the programmatic service name', () => {
    const config = resolveTelemetryConfig(
      { OTEL_SERVICE_NAME: 'shop-canary' },
      { serviceName: 'shop' },
    );

    expect(config.serviceName).toBe('shop-canary');
    expect(config.resourceAttributes[ATTR_SERVICE_NAME]).toBe('shop-canary');
  });

  it('requires a service name', () => {
    expect(() => resolveTelemetryConfig({})).toThrow(/service.name/);
  });

  it('does not start the SDK when OTEL_SDK_DISABLED is true', async () => {
    const handle = startTelemetry({
      serviceName: 'shop',
      env: { OTEL_SDK_DISABLED: 'true' },
    });

    expect(handle.started).toBe(false);
    expect(handle.config.sdkDisabled).toBe(true);
    await handle.shutdown();
  });
});
