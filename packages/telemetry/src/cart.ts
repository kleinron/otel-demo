import { context, propagation, type Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';

/**
 * Baggage key, span attribute, and nested log field (`{ cart: { id } }`) for
 * one simulated shopping-cart journey. It is our own UUID v4, not the shop's
 * database cart id, and it ends when the cart is checked out or abandoned.
 */
export const CART_ID_KEY = 'cart.id';

/** Only a UUID v4 that our own code generated is kept as `cart.id`. */
export const CART_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const CART_REDACTED = '[REDACTED]';

/**
 * `cart.id` from W3C baggage: the id when it is a lowercase UUID v4,
 * `[REDACTED]` for any other value, `undefined` when absent.
 */
export function currentCartId(ctx: Context = context.active()): string | undefined {
  const value = propagation.getBaggage(ctx)?.getEntry(CART_ID_KEY)?.value;
  if (value === undefined || value === '') {
    return undefined;
  }
  return CART_UUID_PATTERN.test(value) ? value : CART_REDACTED;
}

/** Context with `cart.id` in baggage, for a client that starts a cart journey. */
export function withCartBaggage(cartId: string, ctx: Context = context.active()): Context {
  const bag = propagation.getBaggage(ctx) ?? propagation.createBaggage();
  return propagation.setBaggage(ctx, bag.setEntry(CART_ID_KEY, { value: cartId }));
}

/** Copies `cart.id` from the parent context baggage onto every span at start. */
export class CartSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const cartId = currentCartId(parentContext);
    if (cartId) {
      span.setAttribute(CART_ID_KEY, cartId);
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
