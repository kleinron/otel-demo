import {
  customerId,
  mixSeed,
  unitFromSeed,
  type Arrival,
  type LoadPlan,
} from '@otel-demo/telemetry';
import type { ShopClient } from './http.js';

const CART_REMOVE_FRACTION = 0.3;

export interface FlowState {
  carts: Map<string, Promise<string | undefined>>;
  orders: string[];
}

export interface FlowContext {
  plan: LoadPlan;
  seed: number;
  client: ShopClient;
  state: FlowState;
}

export function flowId(arrival: Arrival): string {
  return `${arrival.stream}-${arrival.slotStartMs}-${arrival.index}`;
}

export function customerIndex(seed: number, arrival: Arrival, count: number): number {
  return mixSeed(seed, [arrival.stream, arrival.slotStartMs, arrival.index, 'customer']) % count;
}

/** One arrival. Requests are logged by the client. Failures stay inside the flow. */
export async function runArrival(arrival: Arrival, ctx: FlowContext): Promise<void> {
  try {
    switch (arrival.stream) {
      case 'browse':
        await browse(arrival, ctx);
        return;
      case 'cart':
        await cartActivity(arrival, ctx);
        return;
      case 'checkout':
        await checkout(arrival, ctx);
        return;
      case 'orderStatus':
        await orderStatus(arrival, ctx);
        return;
      default: {
        const exhaustive: never = arrival.stream;
        return exhaustive;
      }
    }
  } catch {
    // The client already logged the failed request. Keep the scheduler moving.
  }
}

async function browse(arrival: Arrival, ctx: FlowContext): Promise<void> {
  const cartId = await ensureCart(arrival, ctx, customerFor(arrival, ctx));
  if (!cartId) {
    return;
  }
  await ctx.client.request({
    flowId: flowId(arrival),
    operation: 'browse',
    method: 'GET',
    path: `/carts/${encodeURIComponent(cartId)}`,
  });
}

async function cartActivity(arrival: Arrival, ctx: FlowContext): Promise<void> {
  const cartId = await ensureCart(arrival, ctx, customerFor(arrival, ctx));
  if (!cartId) {
    return;
  }
  const sku = skuFor(ctx, arrival, 'sku');
  const remove =
    unitFromSeed(ctx.seed, [arrival.stream, arrival.slotStartMs, arrival.index, 'remove']) <
    CART_REMOVE_FRACTION;
  // Local carts are touched about once, so a remove with nothing in the cart
  // never reaches add-to-cart. Add first, then remove the same line.
  if (ctx.plan.schedule.steady) {
    await ctx.client.request({
      flowId: flowId(arrival),
      operation: 'add-to-cart',
      method: 'POST',
      path: `/carts/${encodeURIComponent(cartId)}/items`,
      body: { sku, qty: 1 },
    });
    if (!remove) {
      return;
    }
  }
  if (remove) {
    await ctx.client.request({
      flowId: flowId(arrival),
      operation: 'remove-from-cart',
      method: 'DELETE',
      path: `/carts/${encodeURIComponent(cartId)}/items/${encodeURIComponent(sku)}`,
    });
    return;
  }
  await ctx.client.request({
    flowId: flowId(arrival),
    operation: 'add-to-cart',
    method: 'POST',
    path: `/carts/${encodeURIComponent(cartId)}/items`,
    body: { sku, qty: 1 },
  });
}

async function checkout(arrival: Arrival, ctx: FlowContext): Promise<void> {
  const id = flowId(arrival);
  const customerIdValue = customerFor(arrival, ctx);
  const created = await ctx.client.request({
    flowId: id,
    operation: 'create-cart',
    method: 'POST',
    path: '/carts',
    body: { customerId: customerIdValue },
  });
  const cartId = cartIdFrom(created.body);
  if (created.status !== 201 || !cartId) {
    return;
  }
  const scarce =
    unitFromSeed(ctx.seed, [arrival.stream, arrival.slotStartMs, arrival.index, 'oos']) <
    ctx.plan.schedule.outOfStock.fraction;
  if (scarce) {
    await addItem(
      ctx,
      id,
      cartId,
      ctx.plan.schedule.outOfStock.sku,
      ctx.plan.schedule.outOfStock.qty,
    );
  } else {
    const first = skuFor(ctx, arrival, 'sku');
    await addItem(ctx, id, cartId, first, 1);
    const secondRoll = unitFromSeed(ctx.seed, [
      arrival.stream,
      arrival.slotStartMs,
      arrival.index,
      'second',
    ]);
    if (secondRoll < 0.4) {
      const second = skuFor(ctx, arrival, 'sku2');
      if (second !== first) {
        await addItem(ctx, id, cartId, second, 1);
      }
    }
  }
  const orderKey = `lg-${mixSeed(ctx.seed, [arrival.slotStartMs, arrival.index, 'order']).toString(36)}`;
  await ctx.client.request({
    flowId: id,
    operation: 'checkout',
    method: 'POST',
    path: `/carts/${encodeURIComponent(cartId)}/checkout`,
    headers: { 'idempotency-key': orderKey },
  });
  ctx.state.orders.push(orderKey);
  if (ctx.state.orders.length > 1000) {
    ctx.state.orders.shift();
  }
  await ctx.client.request({
    flowId: id,
    operation: 'order-status',
    method: 'GET',
    path: `/orders/${encodeURIComponent(orderKey)}`,
  });
}

async function orderStatus(arrival: Arrival, ctx: FlowContext): Promise<void> {
  const known = ctx.state.orders;
  const pick =
    mixSeed(ctx.seed, [arrival.slotStartMs, arrival.index, 'status']) % Math.max(known.length, 1);
  const orderId =
    known.length > 0
      ? known[pick]
      : `lg-missing-${mixSeed(ctx.seed, [arrival.slotStartMs, arrival.index, 'missing']).toString(36)}`;
  if (!orderId) {
    return;
  }
  await ctx.client.request({
    flowId: flowId(arrival),
    operation: 'order-status',
    method: 'GET',
    path: `/orders/${encodeURIComponent(orderId)}`,
  });
}

async function ensureCart(
  arrival: Arrival,
  ctx: FlowContext,
  customer: string,
): Promise<string | undefined> {
  const cached = ctx.state.carts.get(customer);
  if (cached) {
    return cached;
  }
  const created = createCart(ctx.client, flowId(arrival), customer).then(
    (cartId) => {
      if (!cartId) {
        ctx.state.carts.delete(customer);
      }
      return cartId;
    },
    (error: unknown) => {
      ctx.state.carts.delete(customer);
      throw error;
    },
  );
  ctx.state.carts.set(customer, created);
  return created;
}

async function createCart(
  client: ShopClient,
  id: string,
  customer: string,
): Promise<string | undefined> {
  const response = await client.request({
    flowId: id,
    operation: 'create-cart',
    method: 'POST',
    path: '/carts',
    body: { customerId: customer },
  });
  if (response.status !== 201) {
    return undefined;
  }
  return cartIdFrom(response.body);
}

function addItem(
  ctx: FlowContext,
  id: string,
  cartId: string,
  sku: string,
  qty: number,
): Promise<unknown> {
  return ctx.client.request({
    flowId: id,
    operation: 'add-to-cart',
    method: 'POST',
    path: `/carts/${encodeURIComponent(cartId)}/items`,
    body: { sku, qty },
  });
}

function customerFor(arrival: Arrival, ctx: FlowContext): string {
  const count = ctx.plan.schedule.customers.count;
  return customerId(customerIndex(ctx.seed, arrival, count), count);
}

function skuFor(ctx: FlowContext, arrival: Arrival, salt: string): string {
  const skus = ctx.plan.schedule.skus;
  const index = mixSeed(ctx.seed, [arrival.slotStartMs, arrival.index, salt]) % skus.length;
  const sku = skus[index];
  if (!sku) {
    throw new Error('schedule skus is empty');
  }
  return sku;
}

function cartIdFrom(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const cartId = (body as { cartId?: unknown }).cartId;
  return typeof cartId === 'string' && cartId !== '' ? cartId : undefined;
}
