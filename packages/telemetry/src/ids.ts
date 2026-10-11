import { randomBytes as nodeRandomBytes } from 'node:crypto';
import type { IdGenerator } from '@opentelemetry/sdk-trace-base';
import type { CloudProvider } from './cloud.js';

export interface IdGeneratorOptions {
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}

export interface CloudIdGenerator extends IdGenerator {
  /** `aws-xray` prefixes the trace id with unix seconds. `gcp-w3c` is 16 random bytes. */
  readonly kind: 'aws-xray' | 'gcp-w3c';
}

/**
 * Trace ids for the active cloud.
 *
 * `aws` (the default) uses the X-Ray form: the first 8 hex characters are
 * unix epoch seconds and the other 24 are random. `gcp` uses a standard W3C
 * id, 16 random bytes, with no time prefix. Span ids are 8 random bytes either way.
 */
export function createTraceIdGenerator(
  provider: CloudProvider,
  options: IdGeneratorOptions = {},
): CloudIdGenerator {
  const now = options.now ?? (() => Date.now());
  const fill = options.randomBytes ?? ((size: number) => nodeRandomBytes(size));
  if (provider === 'gcp') {
    return {
      kind: 'gcp-w3c',
      generateTraceId: () => randomHex(16, fill),
      generateSpanId: () => randomHex(8, fill),
    };
  }
  return {
    kind: 'aws-xray',
    generateTraceId() {
      const seconds = Math.floor(now() / 1000);
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new Error('trace id clock is invalid');
      }
      const prefix = seconds.toString(16).padStart(8, '0');
      if (prefix.length !== 8) {
        throw new Error('trace id time prefix must be 8 hex characters');
      }
      return prefix + randomHex(12, fill);
    },
    generateSpanId: () => randomHex(8, fill),
  };
}

function randomHex(size: number, fill: (size: number) => Buffer): string {
  const buffer = Buffer.from(fill(size));
  if (buffer.length !== size) {
    throw new Error(`random source returned ${buffer.length} bytes, expected ${size}`);
  }
  let nonzero = false;
  for (const byte of buffer) {
    if (byte !== 0) {
      nonzero = true;
      break;
    }
  }
  if (!nonzero) {
    buffer[size - 1] = 1;
  }
  return buffer.toString('hex');
}
