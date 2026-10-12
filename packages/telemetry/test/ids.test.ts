import { describe, expect, it } from 'vitest';
import { resolveCloudProvider, resolveLogFormat, toXrayTraceId } from '../src/index.js';
import { createTraceIdGenerator } from '../src/ids.js';

const NOW = 1_700_000_000_000;

function fill(size: number): Buffer {
  return Buffer.alloc(size, 0xab);
}

describe('cloud provider', () => {
  it('defaults to aws and accepts gcp', () => {
    expect(resolveCloudProvider({})).toBe('aws');
    expect(resolveCloudProvider({ CLOUD_PROVIDER: '' })).toBe('aws');
    expect(resolveCloudProvider({ CLOUD_PROVIDER: 'AWS' })).toBe('aws');
    expect(resolveCloudProvider({ CLOUD_PROVIDER: 'gcp' })).toBe('gcp');
    expect(() => resolveCloudProvider({ CLOUD_PROVIDER: 'azure' })).toThrow(
      /Unknown CLOUD_PROVIDER/,
    );
  });

  it('keeps the default log format unless LOG_FORMAT=gcp', () => {
    expect(resolveLogFormat({})).toBe('default');
    expect(resolveLogFormat({ LOG_FORMAT: 'gcp' })).toBe('gcp');
    expect(() => resolveLogFormat({ LOG_FORMAT: 'json' })).toThrow(/Unknown LOG_FORMAT/);
  });
});

describe('trace id generators', () => {
  it('keeps X-Ray-style ids on aws: unix seconds plus random', () => {
    const generator = createTraceIdGenerator('aws', { now: () => NOW, randomBytes: fill });
    const seconds = Math.floor(NOW / 1000)
      .toString(16)
      .padStart(8, '0');
    const traceId = generator.generateTraceId();

    expect(generator.kind).toBe('aws-xray');
    expect(traceId).toBe(seconds + 'ab'.repeat(12));
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(toXrayTraceId(traceId)).toBe(`1-${seconds}-${'ab'.repeat(12)}`);
    expect(generator.generateSpanId()).toBe('ab'.repeat(8));
  });

  it('uses standard W3C random ids on gcp, with no time prefix', () => {
    const generator = createTraceIdGenerator('gcp', { now: () => NOW, randomBytes: fill });
    const seconds = Math.floor(NOW / 1000)
      .toString(16)
      .padStart(8, '0');
    const traceId = generator.generateTraceId();

    expect(generator.kind).toBe('gcp-w3c');
    expect(traceId).toBe('ab'.repeat(16));
    expect(traceId.startsWith(seconds)).toBe(false);
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(generator.generateSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('replaces an all-zero random id so the W3C id stays valid', () => {
    const generator = createTraceIdGenerator('gcp', {
      randomBytes: (size) => Buffer.alloc(size, 0),
    });
    expect(generator.generateTraceId().endsWith('01')).toBe(true);
    expect(generator.generateTraceId()).not.toBe('0'.repeat(32));
  });
});
