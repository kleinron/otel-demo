import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { currentOrderId, ORDER_ID_FIELD } from './context.js';

/**
 * Copies the request's order id (the idempotency key) onto every span started
 * under it. In the payment service it is also `payment.idempotency_key`.
 */
export class OrderSpanProcessor implements SpanProcessor {
  constructor(private readonly serviceName: string) {}

  onStart(span: Span, parentContext: Context): void {
    const orderId = currentOrderId(parentContext);
    if (!orderId) {
      return;
    }
    span.setAttribute(ORDER_ID_FIELD, orderId);
    if (this.serviceName === 'payment') {
      span.setAttribute('payment.idempotency_key', orderId);
    }
  }

  onEnd(_span: ReadableSpan): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
