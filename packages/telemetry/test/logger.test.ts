import { context, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { Writable } from 'node:stream';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  GCP_SPAN_ID_FIELD,
  GCP_TRACE_FIELD,
  GCP_TRACE_SAMPLED_FIELD,
  createLogger,
  withOrderId,
} from '../src/index.js';

beforeAll(() => {
  const manager = new AsyncLocalStorageContextManager();
  manager.enable();
  context.setGlobalContextManager(manager);
});

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';

function captureLogger(
  service = 'payment',
  options: {
    format?: 'default' | 'gcp';
    cloudProvider?: 'aws' | 'gcp';
    gcpProjectId?: string;
  } = {},
) {
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
  return {
    logger: createLogger({
      service,
      destination: stream,
      format: options.format,
      cloudProvider: options.cloudProvider,
      gcpProjectId: options.gcpProjectId,
    }),
    lines,
  };
}

function restoreEnv(
  name: 'LOG_FORMAT' | 'GCP_PROJECT_ID' | 'OTEL_LOGS_EXPORTER' | 'OTEL_SDK_DISABLED',
  previous: string | undefined,
): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
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

  it('writes Cloud Logging field names when LOG_FORMAT=gcp', () => {
    const provider = new BasicTracerProvider({
      idGenerator: {
        generateTraceId: () => TRACE_ID,
        generateSpanId: () => SPAN_ID,
      },
    });
    const span = provider.getTracer('test').startSpan('charge');
    const { logger, lines } = captureLogger('payment', {
      format: 'gcp',
      gcpProjectId: 'otel-demo-spike',
    });

    context.with(trace.setSpan(ROOT_CONTEXT, span), () => {
      withOrderId('ord_1001', () => {
        logger.info({ route: 'charge' }, 'charge requested');
        logger.warn('charge slow');
        logger.error('charge failed');
      });
    });
    span.end();

    expect(lines[0]).toMatchObject({
      severity: 'INFO',
      service: 'payment',
      [GCP_TRACE_FIELD]: `projects/otel-demo-spike/traces/${TRACE_ID}`,
      [GCP_SPAN_ID_FIELD]: SPAN_ID,
      [GCP_TRACE_SAMPLED_FIELD]: true,
      orderId: 'ord_1001',
      route: 'charge',
      message: 'charge requested',
    });
    expect(typeof lines[0]?.severity).toBe('string');
    expect(lines[0]).not.toHaveProperty('level');
    expect(lines[0]).not.toHaveProperty('msg');
    expect(lines[0]).not.toHaveProperty('trace_id');
    expect(lines[0]).not.toHaveProperty('span_id');
    expect(lines[0]).not.toHaveProperty('xray_trace_id');
    expect(lines[1]?.severity).toBe('WARNING');
    expect(lines[1]?.message).toBe('charge slow');
    expect(lines[2]?.severity).toBe('ERROR');
    expect(lines[2]?.message).toBe('charge failed');
  });

  it('omits the Cloud Logging trace field when GCP_PROJECT_ID is missing', () => {
    const provider = new BasicTracerProvider({
      idGenerator: {
        generateTraceId: () => TRACE_ID,
        generateSpanId: () => SPAN_ID,
      },
    });
    const span = provider.getTracer('test').startSpan('health');
    const { logger, lines } = captureLogger('shop', { format: 'gcp', gcpProjectId: '' });

    context.with(trace.setSpan(ROOT_CONTEXT, span), () => {
      logger.info('health');
    });
    span.end();

    expect(lines[0]?.severity).toBe('INFO');
    expect(lines[0]?.message).toBe('health');
    expect(lines[0]?.[GCP_SPAN_ID_FIELD]).toBe(SPAN_ID);
    expect(lines[0]).not.toHaveProperty(GCP_TRACE_FIELD);
    expect(lines[0]).not.toHaveProperty('xray_trace_id');
  });

  it('drops xray_trace_id when CLOUD_PROVIDER=gcp and keeps the default field names', () => {
    const provider = new BasicTracerProvider({
      idGenerator: {
        generateTraceId: () => TRACE_ID,
        generateSpanId: () => SPAN_ID,
      },
    });
    const span = provider.getTracer('test').startSpan('charge');
    const { logger, lines } = captureLogger('payment', { cloudProvider: 'gcp' });

    context.with(trace.setSpan(ROOT_CONTEXT, span), () => {
      withOrderId('ord_1001', () => {
        logger.info({ route: 'charge' }, 'charge requested');
      });
    });
    span.end();

    expect(lines[0]).toMatchObject({
      level: 'info',
      service: 'payment',
      trace_id: TRACE_ID,
      span_id: SPAN_ID,
      orderId: 'ord_1001',
      msg: 'charge requested',
    });
    expect(lines[0]).not.toHaveProperty('xray_trace_id');
    expect(lines[0]).not.toHaveProperty('severity');
    expect(lines[0]).not.toHaveProperty('message');
  });

  it('reads LOG_FORMAT and GCP_PROJECT_ID from the environment', () => {
    const previousFormat = process.env.LOG_FORMAT;
    const previousProject = process.env.GCP_PROJECT_ID;
    process.env.LOG_FORMAT = 'gcp';
    process.env.GCP_PROJECT_ID = 'otel-demo-spike';
    try {
      const provider = new BasicTracerProvider({
        idGenerator: {
          generateTraceId: () => TRACE_ID,
          generateSpanId: () => SPAN_ID,
        },
      });
      const span = provider.getTracer('test').startSpan('charge');
      const { logger, lines } = captureLogger('shop');
      context.with(trace.setSpan(ROOT_CONTEXT, span), () => {
        logger.info('from env');
      });
      span.end();
      expect(lines[0]?.severity).toBe('INFO');
      expect(lines[0]?.message).toBe('from env');
      expect(lines[0]?.[GCP_TRACE_FIELD]).toBe(`projects/otel-demo-spike/traces/${TRACE_ID}`);
    } finally {
      restoreEnv('LOG_FORMAT', previousFormat);
      restoreEnv('GCP_PROJECT_ID', previousProject);
    }
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

describe('OTLP log export', () => {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter })],
  });

  afterEach(() => {
    exporter.reset();
    restoreEnv('OTEL_LOGS_EXPORTER', undefined);
    restoreEnv('OTEL_SDK_DISABLED', undefined);
  });

  it('copies trace_id and span_id onto the OTLP record without changing the stdout line', () => {
    delete process.env.OTEL_LOGS_EXPORTER;
    delete process.env.OTEL_SDK_DISABLED;
    logs.setGlobalLoggerProvider(provider);
    const tracer = new BasicTracerProvider({
      idGenerator: {
        generateTraceId: () => TRACE_ID,
        generateSpanId: () => SPAN_ID,
      },
    }).getTracer('test');
    const span = tracer.startSpan('charge');

    const quiet = captureLogger('payment');
    context.with(trace.setSpan(ROOT_CONTEXT, span), () => {
      quiet.logger.info({ route: 'charge' }, 'charge requested');
    });
    expect(exporter.getFinishedLogRecords()).toHaveLength(0);
    expect(quiet.lines[0]).toMatchObject({ trace_id: TRACE_ID, span_id: SPAN_ID });

    process.env.OTEL_LOGS_EXPORTER = 'otlp';
    const forwarded = captureLogger('payment');
    context.with(trace.setSpan(ROOT_CONTEXT, span), () => {
      forwarded.logger.info({ route: 'charge' }, 'charge requested');
    });
    span.end();

    expect(forwarded.lines[0]).toMatchObject({
      trace_id: TRACE_ID,
      span_id: SPAN_ID,
      msg: 'charge requested',
      service: 'payment',
    });
    const records = exporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.spanContext?.traceId).toBe(TRACE_ID);
    expect(records[0]?.spanContext?.spanId).toBe(SPAN_ID);
    expect(records[0]?.body).toBe('charge requested');
    expect(records[0]?.attributes).toMatchObject({
      service: 'payment',
      trace_id: TRACE_ID,
      span_id: SPAN_ID,
      route: 'charge',
    });
  });

  it('fills trace_id and span_id from the Cloud Logging fields', () => {
    logs.setGlobalLoggerProvider(provider);
    process.env.OTEL_LOGS_EXPORTER = 'otlp';
    const tracer = new BasicTracerProvider({
      idGenerator: {
        generateTraceId: () => TRACE_ID,
        generateSpanId: () => SPAN_ID,
      },
    }).getTracer('test');
    const span = tracer.startSpan('charge');
    const { logger, lines } = captureLogger('payment', {
      format: 'gcp',
      gcpProjectId: 'otel-demo-spike',
    });
    context.with(trace.setSpan(ROOT_CONTEXT, span), () => {
      logger.info('charge requested');
    });
    span.end();

    expect(lines[0]).not.toHaveProperty('trace_id');
    expect(lines[0]).not.toHaveProperty('span_id');
    const records = exporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.spanContext?.traceId).toBe(TRACE_ID);
    expect(records[0]?.spanContext?.spanId).toBe(SPAN_ID);
    expect(records[0]?.attributes).toMatchObject({
      trace_id: TRACE_ID,
      span_id: SPAN_ID,
    });
  });

  it('does not export when the SDK is disabled', () => {
    logs.setGlobalLoggerProvider(provider);
    process.env.OTEL_LOGS_EXPORTER = 'otlp';
    process.env.OTEL_SDK_DISABLED = 'true';
    const { logger } = captureLogger('payment');
    logger.info('stays on stdout');
    expect(exporter.getFinishedLogRecords()).toHaveLength(0);
  });
});
