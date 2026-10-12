import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { createPgSql, type PoolLike } from '@otel-demo/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFaultController,
  databaseAttemptHook,
  FaultInjectedError,
  parseSwitchValue,
  type FaultControlLog,
  type FaultSpec,
  type FaultSwitchValue,
} from '../src/index.js';

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});
afterAll(() => {
  trace.disable();
  context.disable();
});

const FAULTS: FaultSpec[] = [
  { id: 'inventory-db-timeout', type: 'timeout', service: 'inventory', operation: 'database' },
  { id: 'payment-delay', type: 'error', service: 'payment', operation: 'charge' },
];

function controller(read: () => Promise<FaultSwitchValue>, messages: string[] = []) {
  const log: FaultControlLog = {
    info: (m) => messages.push(m),
    warn: (m) => messages.push(m),
  };
  return createFaultController({
    schedule: { faults: FAULTS },
    reader: { read },
    log,
    readTimeoutMs: 50,
  });
}

async function fires(c: ReturnType<typeof controller>, service: string, operation: string) {
  const span = trace.getTracer('t').startSpan('x');
  try {
    await c.apply({ service, operation }, span);
    return false;
  } catch (error) {
    expect(error).toBeInstanceOf(FaultInjectedError);
    return true;
  } finally {
    span.end();
  }
}

describe('fault switch selector', () => {
  it('parses on/all/off and fault id lists', () => {
    expect(parseSwitchValue('on')).toBe(true);
    expect(parseSwitchValue(' ALL ')).toBe(true);
    expect(parseSwitchValue('off')).toBe(false);
    expect(parseSwitchValue('payment-delay')).toEqual(['payment-delay']);
    expect(parseSwitchValue('payment-delay, inventory-db-timeout')).toEqual([
      'payment-delay',
      'inventory-db-timeout',
    ]);
    expect(() => parseSwitchValue('$$')).toThrow();
  });

  it('runs one fault alone when the switch names it', async () => {
    const c = controller(async () => ['payment-delay']);
    await c.pollOnce();
    expect(await fires(c, 'payment', 'charge')).toBe(true);
    expect(await fires(c, 'inventory', 'database')).toBe(false);
  });

  it('keeps on = all for backward compatibility', async () => {
    const c = controller(async () => true);
    await c.pollOnce();
    expect(await fires(c, 'payment', 'charge')).toBe(true);
    expect(await fires(c, 'inventory', 'database')).toBe(true);
  });
});

describe('fail closed', () => {
  it('turns faults off on the first failed read', async () => {
    const messages: string[] = [];
    let fail = false;
    const c = controller(async () => {
      if (fail) throw new Error('403');
      return true;
    }, messages);
    await c.pollOnce();
    expect(c.isActive()).toBe(true);
    fail = true;
    await c.pollOnce();
    expect(c.isActive()).toBe(false);
    expect(await fires(c, 'payment', 'charge')).toBe(false);
    expect(messages).toContain('faults off by fail-safe');
  });

  it('turns faults off when a read hangs past the timeout', async () => {
    let hang = false;
    const c = controller(() => (hang ? new Promise(() => {}) : Promise.resolve(true)));
    await c.pollOnce();
    expect(c.isActive()).toBe(true);
    hang = true;
    await c.pollOnce();
    expect(c.isActive()).toBe(false);
  });

  it('starts with faults off when the first read fails', async () => {
    const c = controller(async () => {
      throw new Error('unreachable');
    });
    await c.pollOnce();
    expect(c.isActive()).toBe(false);
    expect(await fires(c, 'payment', 'charge')).toBe(false);
  });
});

describe('database attempt hook', () => {
  it('fails every retry attempt, not just the first', async () => {
    const c = controller(async () => ['inventory-db-timeout']);
    await c.pollOnce();
    let connects = 0;
    const pool: PoolLike = {
      async connect() {
        connects += 1;
        return { query: async () => ({ rows: [] }), release() {} };
      },
      on() {},
      async end() {},
    };
    const sql = createPgSql('postgres://localhost/inventory', {
      createPool: () => pool,
      retryAttempts: 3,
      retryBaseDelayMs: 1,
      beforeAttempt: databaseAttemptHook(c, 'inventory'),
    });
    exporter.reset();
    await expect(sql.query('SELECT 1', [], 'stock.read')).rejects.toThrow(
      /timeout/,
    );
    expect(connects).toBe(0);
    const span = exporter.getFinishedSpans().find((s) => s.name === 'SELECT stock.read');
    const events = span?.events.map((e) => e.name);
    expect(events?.filter((e) => e === 'db.retry')).toHaveLength(2);
    expect(events).toContain('db.retry.exhausted');
  });
});
