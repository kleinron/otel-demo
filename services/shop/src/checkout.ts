import { isOutboundTimeout } from '@otel-demo/httpkit';
import {
  customerHash,
  withCustomerHash,
  withSideEffectLog,
  type SideEffectVerdict,
} from '@otel-demo/telemetry';
import type { Logger } from 'pino';
import type { Downstream } from './downstream.js';
import type { Cart, Order, ShopRepo } from './repo.js';

export interface CheckoutResult {
  statusCode: number;
  body: Record<string, unknown>;
}

export interface CheckoutHooks {
  logger?: Logger;
  /** Runs inside the checkout side-effect log, so a fault is an error line. */
  before?: () => Promise<void>;
}

export async function runCheckout(
  repo: ShopRepo,
  downstream: Downstream,
  cartId: string,
  idempotencyKey: string,
  markError: (message: string) => void,
  hooks: CheckoutHooks = {},
): Promise<CheckoutResult> {
  const cart = await repo.getCart(cartId);
  if (!cart) {
    return { statusCode: 404, body: { error: 'cart_not_found', cartId } };
  }
  if (cart.items.length === 0) {
    return { statusCode: 400, body: { error: 'empty_cart', cartId } };
  }
  const customer = await repo.customer(cart.customerId);
  if (!customer) {
    return { statusCode: 400, body: { error: 'unknown_customer', customerId: cart.customerId } };
  }

  return withCustomerHash(customerHash(customer.id), () =>
    withSideEffectLog(
      hooks.logger,
      { action: 'checkout', orderId: idempotencyKey },
      async () => {
        await hooks.before?.();
        return finishCheckout(repo, downstream, cart, customer, idempotencyKey, markError);
      },
      { verdict: checkoutVerdict },
    ),
  );
}

async function finishCheckout(
  repo: ShopRepo,
  downstream: Downstream,
  cart: Cart,
  customer: { id: string; city: string },
  idempotencyKey: string,
  markError: (message: string) => void,
): Promise<CheckoutResult> {
  const cartId = cart.cartId;
  const existingForCart = await repo.findOrderByCart(cartId);
  if (existingForCart && existingForCart.orderId !== idempotencyKey) {
    return {
      statusCode: 400,
      body: { error: 'cart_already_checked_out', cartId, orderId: existingForCart.orderId },
    };
  }

  let order =
    existingForCart ??
    (await repo.createOrder({
      orderId: idempotencyKey,
      cartId,
      customerId: cart.customerId,
      city: customer.city,
      amountCents: amountOf(cart),
    }));

  if (order.orderId !== idempotencyKey) {
    return { statusCode: 400, body: { error: 'idempotency_conflict', orderId: order.orderId } };
  }

  if (order.status === 'handed_to_delivery') {
    return { statusCode: 200, body: orderBody(order) };
  }
  if (order.status === 'out_of_stock') {
    markError('out_of_stock');
    return {
      statusCode: 409,
      body: { error: 'out_of_stock', ...orderBody(order) },
    };
  }
  if (order.status === 'payment_declined') {
    markError('payment_declined');
    return { statusCode: 402, body: { error: 'payment_declined', ...orderBody(order) } };
  }

  if (order.status === 'cart') {
    try {
      const reserved = await downstream.reserve(
        order.orderId,
        cart.items.map((item) => ({ sku: item.sku, qty: item.qty })),
      );
      if (!reserved.ok) {
        order = await repo.updateStatus(order.orderId, 'out_of_stock');
        markError('out_of_stock');
        return {
          statusCode: 409,
          body: { error: 'out_of_stock', sku: reserved.sku, ...orderBody(order) },
        };
      }
      order = await repo.updateStatus(order.orderId, 'reserved');
    } catch (error) {
      return failDownstream(order, error, markError);
    }
  }

  if (order.status === 'reserved' || order.status === 'payment_unknown') {
    try {
      let payment = await downstream.charge(order.orderId, order.amountCents);
      if (payment.status === 'declined') {
        order = await repo.updateStatus(order.orderId, 'payment_declined');
        markError('payment_declined');
        return { statusCode: 402, body: { error: 'payment_declined', ...orderBody(order) } };
      }
      if (payment.status === 'unknown') {
        order = await repo.updateStatus(order.orderId, 'payment_unknown');
        markError('payment_unknown');
        return { statusCode: 503, body: { error: 'payment_unknown', ...orderBody(order) } };
      }
      if (payment.status === 'authorized') {
        payment = await downstream.capture(order.orderId);
      }
      if (payment.status !== 'captured') {
        order = await repo.updateStatus(order.orderId, 'payment_unknown');
        markError('payment_unknown');
        return { statusCode: 503, body: { error: 'payment_unknown', ...orderBody(order) } };
      }
      order = await repo.updateStatus(order.orderId, 'paid');
    } catch (error) {
      if (isOutboundTimeout(error)) {
        order = await repo.updateStatus(order.orderId, 'payment_unknown');
      }
      return failDownstream(order, error, markError);
    }
  }

  if (order.status === 'paid' || order.status === 'delivery_pending') {
    try {
      await downstream.handoff(order.orderId, order.city);
      order = await repo.updateStatus(order.orderId, 'handed_to_delivery');
    } catch (error) {
      order = await repo.updateStatus(order.orderId, 'delivery_pending');
      return failDownstream(order, error, markError);
    }
  }

  return { statusCode: 200, body: orderBody(order) };
}

function checkoutVerdict(result: CheckoutResult): SideEffectVerdict {
  if (result.statusCode === 409) {
    return { level: 'warn', outcome: 'out_of_stock' };
  }
  if (result.statusCode === 402) {
    return { level: 'warn', outcome: 'declined' };
  }
  if (result.statusCode === 504) {
    return { level: 'error', outcome: 'timeout' };
  }
  if (result.statusCode >= 500) {
    return { level: 'error', outcome: 'error' };
  }
  if (result.statusCode >= 400) {
    return { level: 'warn', outcome: 'rejected' };
  }
  return 'success';
}

function failDownstream(
  order: Order,
  error: unknown,
  markError: (message: string) => void,
): CheckoutResult {
  if (isOutboundTimeout(error)) {
    markError('timeout');
    return { statusCode: 504, body: { error: 'timeout', ...orderBody(order) } };
  }
  markError('downstream');
  return { statusCode: 502, body: { error: 'downstream', ...orderBody(order) } };
}

function amountOf(cart: Cart): number {
  return cart.items.reduce((sum, item) => sum + item.qty * item.unitPriceCents, 0);
}

function orderBody(order: Order): Record<string, unknown> {
  return {
    orderId: order.orderId,
    cartId: order.cartId,
    customerId: order.customerId,
    status: order.status,
    city: order.city,
    amountCents: order.amountCents,
  };
}
