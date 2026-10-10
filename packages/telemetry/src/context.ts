import { createHash } from 'node:crypto';
import { context, createContextKey, type Context } from '@opentelemetry/api';

const orderIdKey = createContextKey('otel-demo.orderId');
const customerHashKey = createContextKey('otel-demo.customerHash');
const annotationsKey = createContextKey('otel-demo.logAnnotations');

/** Log and correlation field for the order idempotency key. */
export const ORDER_ID_FIELD = 'orderId';

/** Inbound header carrying {@link customerHash}, never a raw customer id. */
export const CUSTOMER_HASH_HEADER = 'x-customer-hash';

/** 16 hex chars from SHA-256. Short enough to keep a log line near 300 bytes. */
export const CUSTOMER_HASH_PATTERN = /^[a-f0-9]{16}$/;

interface LogBag {
  'fault.configured'?: true;
  'fault.injected'?: true;
  customerHash?: string;
}

export function withOrderId<T>(orderId: string, fn: () => T): T {
  return context.with(context.active().setValue(orderIdKey, orderId), fn);
}

export function currentOrderId(ctx: Context = context.active()): string | undefined {
  const value = ctx.getValue(orderIdKey);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Stable hash of a customer id. The raw id is not a log field. */
export function customerHash(customerId: string): string {
  return createHash('sha256').update(`customer:${customerId}`).digest('hex').slice(0, 16);
}

export function withCustomerHash<T>(hash: string, fn: () => T): T {
  if (!CUSTOMER_HASH_PATTERN.test(hash)) {
    return fn();
  }
  rememberCustomerHash(hash);
  return context.with(context.active().setValue(customerHashKey, hash), fn);
}

export function currentCustomerHash(ctx: Context = context.active()): string | undefined {
  const direct = ctx.getValue(customerHashKey);
  if (typeof direct === 'string' && CUSTOMER_HASH_PATTERN.test(direct)) {
    return direct;
  }
  const bag = logBag(ctx);
  if (bag?.customerHash && CUSTOMER_HASH_PATTERN.test(bag.customerHash)) {
    return bag.customerHash;
  }
  return undefined;
}

/**
 * Attach the order id, a mutable fault/hash bag, and a validated customer hash
 * to a request context. Later logs, including the access line, read this bag.
 */
export function bindRequestLogContext(
  ctx: Context,
  orderId?: string,
  customerHash?: string,
): Context {
  let next = ctx;
  if (!logBag(next)) {
    next = next.setValue(annotationsKey, {});
  }
  if (orderId) {
    next = next.setValue(orderIdKey, orderId);
  }
  if (customerHash && CUSTOMER_HASH_PATTERN.test(customerHash)) {
    next = next.setValue(customerHashKey, customerHash);
    const bag = logBag(next);
    if (bag) {
      bag.customerHash = customerHash;
    }
  }
  return next;
}

export function markFaultFlag(flag: 'fault.configured' | 'fault.injected'): void {
  const bag = logBag(context.active());
  if (bag) {
    bag[flag] = true;
  }
}

export function currentFaultFlags(ctx: Context = context.active()): {
  'fault.configured'?: true;
  'fault.injected'?: true;
} {
  const bag = logBag(ctx);
  const flags: { 'fault.configured'?: true; 'fault.injected'?: true } = {};
  if (bag?.['fault.configured']) {
    flags['fault.configured'] = true;
  }
  if (bag?.['fault.injected']) {
    flags['fault.injected'] = true;
  }
  return flags;
}

function rememberCustomerHash(hash: string): void {
  const bag = logBag(context.active());
  if (bag && CUSTOMER_HASH_PATTERN.test(hash)) {
    bag.customerHash = hash;
  }
}

function logBag(ctx: Context): LogBag | undefined {
  const value = ctx.getValue(annotationsKey);
  if (typeof value === 'object' && value !== null) {
    return value as LogBag;
  }
  return undefined;
}
