import { Writable } from 'node:stream';
import { context, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { beforeAll, describe, expect, it } from 'vitest';
import { FaultInjectedError } from '../src/fault-control.js';
import {
  ExpectedSideEffectFailure,
  bindRequestLogContext,
  createLogger,
  customerHash,
  withCustomerHash,
  withLoggedWrites,
  withOrderId,
  withSideEffectLog,
} from '../src/index.js';

beforeAll(() => {
  const manager = new AsyncLocalStorageContextManager();
  manager.enable();
  context.setGlobalContextManager(manager);
});

function captureLogger(level = 'debug') {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim() !== '') {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        }
      }
      callback();
    },
  });
  return { logger: createLogger({ service: 'shop', level, destination: stream }), lines };
}

describe('withSideEffectLog', () => {
  it('logs about to at debug and a success line with duration, then returns the value', async () => {
    const provider = new BasicTracerProvider();
    const span = provider.getTracer('shop').startSpan('checkout');
    const { logger, lines } = captureLogger();
    const hash = customerHash('cust-0000');

    const ctx = bindRequestLogContext(trace.setSpan(ROOT_CONTEXT, span), 'ord_1', hash);
    const value = await context.with(ctx, () =>
      withOrderId('ord_1', () =>
        withCustomerHash(hash, () =>
          withSideEffectLog(
            logger,
            { action: 'payment-charge', target: 'payment' },
            async (detail) => {
              detail.status = 200;
              return 'charged';
            },
          ),
        ),
      ),
    );
    span.end();

    expect(value).toBe('charged');
    expect(lines.map((line) => line.msg)).toEqual([
      'about to payment-charge',
      'payment-charge succeeded',
    ]);
    expect(lines[1]).toMatchObject({
      action: 'payment-charge',
      target: 'payment',
      outcome: 'success',
      status: 200,
      orderId: 'ord_1',
      customer_hash: hash,
      level: 'info',
    });
    expect(lines[0]).toMatchObject({
      action: 'payment-charge',
      orderId: 'ord_1',
      customer_hash: hash,
      trace_id: span.spanContext().traceId,
      span_id: span.spanContext().spanId,
    });
    expect(typeof lines[1]?.duration_ms).toBe('number');
    expect(JSON.stringify(lines)).not.toContain('cust-0000');
  });

  it('warns and rethrows an expected business failure', async () => {
    const { logger, lines } = captureLogger();
    await expect(
      withSideEffectLog(logger, { action: 'inventory-reserve' }, async () => {
        throw new ExpectedSideEffectFailure('out_of_stock');
      }),
    ).rejects.toBeInstanceOf(ExpectedSideEffectFailure);

    expect(lines.map((line) => line.msg)).toEqual([
      'about to inventory-reserve',
      'inventory-reserve out_of_stock',
    ]);
    expect(lines[1]).toMatchObject({
      level: 'warn',
      outcome: 'out_of_stock',
      action: 'inventory-reserve',
    });
    expect(typeof lines[1]?.duration_ms).toBe('number');
  });

  it('logs an injected fault at error with fault.injected and rethrows', async () => {
    const { logger, lines } = captureLogger();
    const error = new FaultInjectedError({ id: 'inventory-reserve-error', type: 'error' });
    await expect(
      withSideEffectLog(logger, { action: 'inventory-reserve' }, async () => {
        throw error;
      }),
    ).rejects.toBe(error);

    expect(lines[1]).toMatchObject({
      level: 'error',
      outcome: 'error',
      action: 'inventory-reserve',
      'fault.injected': true,
      msg: 'inventory-reserve failed',
    });
  });

  it('hides the about-to line when the logger is info', async () => {
    const { logger, lines } = captureLogger('info');
    await withSideEffectLog(logger, { action: 'delivery-handoff' }, async () => 'ok');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.msg).toBe('delivery-handoff succeeded');
  });
});

describe('withLoggedWrites', () => {
  it('logs a db-write pair and keeps SQL text out of a timeout line', async () => {
    const statement = "UPDATE orders SET city = 'Haifa' WHERE customer_id = 'cust-0000'";
    const { logger, lines } = captureLogger();
    const sql = withLoggedWrites(
      {
        async query() {
          throw new Error(`database timeout during ${statement}`);
        },
        async transaction(fn) {
          return fn(this);
        },
        async close() {},
      },
      logger,
    );

    await expect(sql.query(statement, ['cust-0000'], 'order.write')).rejects.toThrow(/timeout/);
    expect(lines.map((line) => line.msg)).toEqual(['about to db-write', 'db-write failed']);
    expect(lines[1]).toMatchObject({
      action: 'db-write',
      operation: 'order.write',
      outcome: 'timeout',
      level: 'error',
    });
    const text = JSON.stringify(lines);
    expect(text).not.toContain('UPDATE');
    expect(text).not.toContain('cust-0000');
    expect(text).not.toContain('Haifa');
  });
});
