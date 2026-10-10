import { context, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { Writable } from 'node:stream';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { beforeAll, describe, expect, it } from 'vitest';
import { createLogger, withOrderId } from '../src/index.js';

beforeAll(() => {
  const manager = new AsyncLocalStorageContextManager();
  manager.enable();
  context.setGlobalContextManager(manager);
});

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';

function captureLogger(service = 'payment') {
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
  return { logger: createLogger({ service, destination: stream }), lines };
}

describe('structured logs', () => {
  it('includes service, trace ids, the X-Ray trace id, and orderId', () => {
    const provider = new BasicTracerProvider({
      idGenerator: {
        generateTraceId: () => TRACE_ID,
        generateSpanId: () => SPAN_ID,
      },
    });
    const span = provider.getTracer('test').startSpan('charge');
    const { logger, lines } = captureLogger('payment');

    context.with(trace.setSpan(ROOT_CONTEXT, span), () => {
      withOrderId('ord_1001', () => {
        logger.info({ route: 'charge' }, 'charge requested');
      });
    });
    span.end();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      service: 'payment',
      trace_id: TRACE_ID,
      span_id: SPAN_ID,
      xray_trace_id: '1-4bf92f35-77b34da6a3ce929d0e0e4736',
      orderId: 'ord_1001',
      route: 'charge',
      msg: 'charge requested',
    });
  });

  it('keeps an explicit orderId ahead of the context value', () => {
    const { logger, lines } = captureLogger('shop');

    withOrderId('ord_context', () => {
      logger.info({ orderId: 'ord_explicit' }, 'state changed');
    });

    expect(lines[0]?.orderId).toBe('ord_explicit');
  });

  it('omits trace fields and orderId when they are not present', () => {
    const { logger, lines } = captureLogger('inventory');
    logger.info('health');

    expect(lines[0]).toMatchObject({ service: 'inventory', msg: 'health' });
    expect(lines[0]).not.toHaveProperty('trace_id');
    expect(lines[0]).not.toHaveProperty('span_id');
    expect(lines[0]).not.toHaveProperty('xray_trace_id');
    expect(lines[0]).not.toHaveProperty('orderId');
  });

  it('redacts emails, phones, bearer tokens, access key ids, and secret fields', () => {
    const { logger, lines } = captureLogger('shop');
    const accessKey = 'AKIA' + 'A'.repeat(16);

    logger.info(
      {
        email: 'ada@example.com',
        note: 'call +1 555-123-4567 or 555-010-9999',
        password: 'correct-horse',
        accessToken: accessKey,
        nested: { clientSecret: 'nested-secret', orderId: 'ord_42' },
      },
      `receipt for ada@example.com Bearer ${'abc' + '123'}`,
    );

    const line = lines[0];
    expect(line?.email).toBe('[REDACTED_EMAIL]');
    expect(line?.note).toBe('call [REDACTED_PHONE] or [REDACTED_PHONE]');
    expect(line?.password).toBe('[REDACTED]');
    expect(line?.accessToken).toBe('[REDACTED]');
    expect(line?.nested).toEqual({ clientSecret: '[REDACTED]', orderId: 'ord_42' });
    expect(line?.msg).toBe('receipt for [REDACTED_EMAIL] Bearer [REDACTED]');
    expect(JSON.stringify(line)).not.toContain('ada@example.com');
    expect(JSON.stringify(line)).not.toContain('555-123-4567');
    expect(JSON.stringify(line)).not.toContain(accessKey);
  });

  it('reads LOG_LEVEL from the environment when the logger is created', () => {
    const previous = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'debug';
    try {
      const { logger, lines } = captureLogger('shop');
      logger.debug({ action: 'payment-charge' }, 'about to payment-charge');
      expect(lines).toHaveLength(1);
      expect(lines[0]?.msg).toBe('about to payment-charge');
    } finally {
      if (previous === undefined) {
        delete process.env.LOG_LEVEL;
      } else {
        process.env.LOG_LEVEL = previous;
      }
    }

    const quiet = captureLogger('shop');
    quiet.logger.debug({ action: 'payment-charge' }, 'about to payment-charge');
    expect(quiet.lines).toHaveLength(0);
    quiet.logger.info(
      { action: 'payment-charge', outcome: 'success', duration_ms: 1 },
      'payment-charge succeeded',
    );
    expect(quiet.lines).toHaveLength(1);
  });

  it('redacts secret bindings on child loggers', () => {
    const { logger, lines } = captureLogger('payment');
    logger.child({ apiKey: 'child-secret', orderId: 'ord_7' }).info('captured');

    expect(lines[0]).toMatchObject({
      apiKey: '[REDACTED]',
      orderId: 'ord_7',
      msg: 'captured',
    });
  });
});
