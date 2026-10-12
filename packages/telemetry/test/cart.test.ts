import { ROOT_CONTEXT, context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CartSpanProcessor,
  createLogger,
  currentCartId,
  extractTraceContext,
  injectTraceHeaders,
  redactLogEntry,
  redactSensitiveText,
  withCartBaggage,
} from '../src/index.js';

const CID = '3f2b8c1e-9a4d-4e7f-8b2a-1c5d6e7f8a9b';
const manager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  manager.enable();
  context.setGlobalContextManager(manager);
});
afterAll(() => {
  context.disable();
});

function capture(): { lines: Record<string, unknown>[]; stream: Writable } {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      done();
    },
  });
  return { lines, stream };
}

describe('cart.id via W3C baggage', () => {
  it('round-trips cart.id through the baggage header', () => {
    const headers = injectTraceHeaders({}, withCartBaggage(CID, ROOT_CONTEXT));
    expect(headers.baggage).toBe(`cart.id=${CID}`);
    expect(currentCartId(extractTraceContext(headers, ROOT_CONTEXT))).toBe(CID);
  });

  it('redacts a baggage value that is not a UUID v4', () => {
    expect(currentCartId(extractTraceContext({ baggage: 'cart.id=abc123' }, ROOT_CONTEXT))).toBe(
      '[REDACTED]',
    );
    expect(currentCartId(ROOT_CONTEXT)).toBeUndefined();
  });

  it('sets cart.id on spans started under the baggage', () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new CartSpanProcessor(), new SimpleSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer('t');
    tracer.startSpan('with', {}, withCartBaggage(CID, ROOT_CONTEXT)).end();
    tracer.startSpan('without', {}, ROOT_CONTEXT).end();
    const [withCart, withoutCart] = exporter.getFinishedSpans();
    expect(withCart?.attributes['cart.id']).toBe(CID);
    expect(withoutCart?.attributes['cart.id']).toBeUndefined();
  });
});

describe('cart.id redaction guardrail', () => {
  it('keeps only our own UUID v4 cart.id, nested', () => {
    expect(redactLogEntry({ message: 'x' }, CID)).toEqual({ message: 'x', cart: { id: CID } });
    expect(redactLogEntry({ message: 'x' }, 'not-a-uuid')).toEqual({
      message: 'x',
      cart: { id: '[REDACTED]' },
    });
    expect(redactLogEntry({ message: 'x' })).toEqual({ message: 'x' });
  });

  it('redacts cart and session ids that arrive in raw data, even a valid UUID', () => {
    const out = redactLogEntry({
      'cart.id': CID,
      cartId: 'abc',
      cart_id: 'abc',
      'session.id': CID,
      sessionId: 'abc',
      cart: { id: CID, items: 2 },
      session: { id: CID },
      headers: { cookie: 'cartid=abc', 'x-session-id': 'abc', 'x-cart-id': 'abc' },
      body: { SessionID: 'abc', CartId: 'abc' },
    });
    expect(out['cart.id']).toBe('[REDACTED]');
    expect(out.cartId).toBe('[REDACTED]');
    expect(out.cart_id).toBe('[REDACTED]');
    expect(out['session.id']).toBe('[REDACTED]');
    expect(out.sessionId).toBe('[REDACTED]');
    expect(out.cart).toEqual({ id: '[REDACTED]', items: 2 });
    expect(out.session).toEqual({ id: '[REDACTED]' });
    expect(out.headers).toEqual({
      cookie: '[REDACTED]',
      'x-session-id': '[REDACTED]',
      'x-cart-id': '[REDACTED]',
    });
    expect(out.body).toEqual({ SessionID: '[REDACTED]', CartId: '[REDACTED]' });
  });

  it('redacts cartid and sessionid inside raw cookie, header, query, and JSON text', () => {
    expect(redactSensitiveText('Cookie: a=1; sessionid=s3cr3t; cartid=c4rt; b=2')).toBe(
      'Cookie: a=1; sessionid=[REDACTED]; cartid=[REDACTED]; b=2',
    );
    expect(redactSensitiveText('/cb?cart_id=s3cr3t&x=1')).toBe('/cb?cart_id=[REDACTED]&x=1');
    expect(redactSensitiveText('{"cartId":"s3cr3t","sessionId":"x"}')).toBe(
      '{"cartId":"[REDACTED]","sessionId":"[REDACTED]"}',
    );
    expect(redactSensitiveText('X-Cart-Id: s3cr3t')).toBe('X-Cart-Id: [REDACTED]');
  });

  it('logger writes the baggage cart.id nested and redacts raw ones', () => {
    for (const format of ['gcp', 'json'] as const) {
      const { lines, stream } = capture();
      const logger = createLogger({
        service: 'shop',
        destination: stream,
        format,
        gcpProjectId: 'p',
      });
      const tracer = new BasicTracerProvider().getTracer('t');
      const ctx = withCartBaggage(CID, ROOT_CONTEXT);
      const span = tracer.startSpan('s', {}, ctx);
      context.with(trace.setSpan(ctx, span), () => {
        logger.info({ cartId: 'raw', cookie: 'cartid=raw', cart: { id: CID } }, 'hello');
      });
      logger.info({ n: 1 }, 'no cart');
      span.end();
      expect(lines[0]?.cart).toEqual({ id: CID });
      expect(lines[0]?.cartId).toBe('[REDACTED]');
      expect(lines[0]?.cookie).toBe('[REDACTED]');
      expect(lines[1]?.cart).toBeUndefined();
      expect(JSON.stringify(lines)).not.toContain('raw');
    }
  });

  it('adds GCP-native fields in the gcp format', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ service: 'payment', destination: stream, format: 'gcp' });
    logger.warn('w');
    expect(lines[0]?.severity).toBe('WARNING');
    expect(lines[0]?.message).toBe('w');
    expect(lines[0]?.['logging.googleapis.com/labels']).toEqual({ service: 'payment' });
    expect(lines[0]?.serviceContext).toEqual({ service: 'payment' });
  });
});
