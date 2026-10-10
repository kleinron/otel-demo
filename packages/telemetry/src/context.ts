import { context, createContextKey, type Context } from '@opentelemetry/api';

const orderIdKey = createContextKey('otel-demo.orderId');

/** Log and correlation field for the order idempotency key. */
export const ORDER_ID_FIELD = 'orderId';

export function withOrderId<T>(orderId: string, fn: () => T): T {
  return context.with(context.active().setValue(orderIdKey, orderId), fn);
}

export function currentOrderId(ctx: Context = context.active()): string | undefined {
  const value = ctx.getValue(orderIdKey);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
