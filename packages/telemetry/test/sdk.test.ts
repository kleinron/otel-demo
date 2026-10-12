import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompositePropagator } from '@opentelemetry/core';
import { AlwaysOnSampler } from '@opentelemetry/sdk-trace-base';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { describe, expect, it } from 'vitest';
import {
  buildNodeSdkConfiguration,
  now,
  resolveTelemetryConfig,
  toXrayTraceId,
  type CloudIdGenerator,
} from '../src/index.js';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe('SDK wiring', () => {
  it('configures OTLP/HTTP, W3C propagation, and no host resource detection', () => {
    const config = resolveTelemetryConfig(
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.internal:4318' },
      { serviceName: 'delivery' },
    );
    const sdkConfig = buildNodeSdkConfiguration(config);

    expect(sdkConfig.autoDetectResources).toBe(false);
    expect(sdkConfig.instrumentations).toEqual([]);
    expect(sdkConfig.textMapPropagator).toBeInstanceOf(CompositePropagator);
    expect(sdkConfig.serviceName).toBe('delivery');
    expect(sdkConfig.sampler).toBeInstanceOf(AlwaysOnSampler);
    expect(sdkConfig.spanProcessors).toHaveLength(3);
    expect(sdkConfig.metricReaders).toHaveLength(1);
    expect(sdkConfig.views).toHaveLength(1);
    expect(new NodeSDK(sdkConfig)).toBeInstanceOf(NodeSDK);
    const awsIds = sdkConfig.idGenerator as CloudIdGenerator;
    expect(awsIds.kind).toBe('aws-xray');
    const awsTraceId = awsIds.generateTraceId();
    const seconds = Math.floor(Date.now() / 1000);
    expect(Math.abs(Number.parseInt(awsTraceId.slice(0, 8), 16) - seconds)).toBeLessThan(5);
  });

  it('uses standard W3C random trace ids when CLOUD_PROVIDER=gcp', () => {
    const config = resolveTelemetryConfig(
      { CLOUD_PROVIDER: 'gcp', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.internal:4318' },
      { serviceName: 'shop' },
    );
    expect(config.cloudProvider).toBe('gcp');
    const sdkConfig = buildNodeSdkConfiguration(config);
    const gcpIds = sdkConfig.idGenerator as CloudIdGenerator;
    expect(gcpIds.kind).toBe('gcp-w3c');
    expect(gcpIds.generateTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(gcpIds.generateSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('time and X-Ray encoding', () => {
  it('returns a monotonic millisecond clock', () => {
    const start = now();
    const end = now();
    expect(Number.isFinite(start)).toBe(true);
    expect(end).toBeGreaterThanOrEqual(start);
  });

  it('encodes a W3C trace id in X-Ray form', () => {
    expect(toXrayTraceId('4bf92f3577b34da6a3ce929d0e0e4736')).toBe(
      '1-4bf92f35-77b34da6a3ce929d0e0e4736',
    );
    expect(() => toXrayTraceId('not-a-trace')).toThrow(/32 lowercase hex/);
  });
});

describe('provider boundary', () => {
  it('does not depend on or import a cloud SDK or a non-OTLP exporter', () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const dependencyNames = Object.keys(packageJson.dependencies ?? {});
    const bannedDependencies = [
      'aws-sdk',
      '@opentelemetry/exporter-zipkin',
      '@opentelemetry/exporter-prometheus',
      '@opentelemetry/exporter-trace-otlp-grpc',
      '@opentelemetry/exporter-metrics-otlp-grpc',
      '@opentelemetry/propagator-b3',
      '@opentelemetry/propagator-jaeger',
    ];
    for (const name of dependencyNames) {
      expect(name.startsWith('@aws-sdk/')).toBe(false);
      expect(bannedDependencies).not.toContain(name);
    }

    const sources = walk(join(packageRoot, 'src')).filter((file) => file.endsWith('.ts'));
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/@aws-sdk\//);
      expect(source).not.toMatch(/from ['"]aws-sdk['"]/);
      expect(source).not.toMatch(/exporter-trace-otlp-grpc/);
      expect(source).not.toMatch(/exporter-metrics-otlp-grpc/);
      expect(source).not.toMatch(/exporter-zipkin/);
      expect(source).not.toMatch(/exporter-prometheus/);
      expect(source).not.toMatch(/propagator-b3/);
      expect(source).not.toMatch(/propagator-jaeger/);
    }
  });
});

function walk(directory: string): string[] {
  const entries = readdirSync(directory);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...walk(path));
    } else {
      files.push(path);
    }
  }
  return files;
}
