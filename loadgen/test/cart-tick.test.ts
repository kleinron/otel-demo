import { describe, expect, it } from 'vitest';
import { runCart, runCartTick, type CartTickOptions } from '../src/cart-tick.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fakeShop(checkoutStatuses: number[] = []) {
  const calls: { path: string; method: string; baggage: string }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const path = url.replace('http://shop', '');
    calls.push({ path, method: init.method ?? 'GET', baggage: headers.baggage ?? '' });
    if (path.endsWith('/checkout')) {
      return new Response('{}', { status: checkoutStatuses.shift() ?? 201 });
    }
    const status = init.method === 'POST' && path === '/carts' ? 201 : 200;
    return new Response(JSON.stringify({ cartId: 'c1' }), { status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

function options(shop: ReturnType<typeof fakeShop>, extra: Partial<CartTickOptions> = {}) {
  const logs: Record<string, unknown>[] = [];
  const opts: CartTickOptions = {
    shopUrl: 'http://shop',
    carts: 1,
    spacingMs: 0,
    skus: ['a', 'b'],
    customerCount: 10,
    fetch: shop.fetch,
    sleep: async () => undefined,
    log: (event) => logs.push(event),
    ...extra,
  };
  return { opts, logs };
}

describe('cart journey', () => {
  it('browses, adds items, checks out, closes, and sends nothing after', async () => {
    const shop = fakeShop();
    const { opts, logs } = options(shop, { random: () => 0.99 });
    const result = await runCart(opts);
    expect(result.outcome).toBe('completed');
    expect(result.cartId).toMatch(UUID_V4);
    expect(shop.calls.every((c) => c.baggage === `cart.id=${result.cartId}`)).toBe(true);
    expect(shop.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /carts',
      'GET /carts/c1',
      'POST /carts/c1/items',
      'POST /carts/c1/items',
      'POST /carts/c1/items',
      'POST /carts/c1/checkout',
    ]);
    const closed = logs.filter((l) => l.message === 'cart closed');
    expect(closed).toEqual([
      expect.objectContaining({ outcome: 'completed', cart: { id: result.cartId } }),
    ]);
    expect(logs.at(-1)?.message).toBe('cart closed');
  });

  it('retries a failed checkout once with the same cart.id', async () => {
    const shop = fakeShop([503]);
    const { opts } = options(shop, { random: () => 0 });
    const result = await runCart(opts);
    expect(result).toMatchObject({ outcome: 'completed', checkoutAttempts: 2 });
    expect(shop.calls.filter((c) => c.path.endsWith('/checkout'))).toHaveLength(2);
    expect(new Set(shop.calls.map((c) => c.baggage)).size).toBe(1);
  });

  it('abandons the cart after a second failed checkout', async () => {
    const shop = fakeShop([503, 409, 201]);
    const { opts, logs } = options(shop, { random: () => 0 });
    const result = await runCart(opts);
    expect(result).toMatchObject({ outcome: 'abandoned', checkoutAttempts: 2 });
    expect(shop.calls.filter((c) => c.path.endsWith('/checkout'))).toHaveLength(2);
    expect(logs.filter((l) => l.message === 'cart closed')).toEqual([
      expect.objectContaining({ outcome: 'abandoned' }),
    ]);
  });

  it('gives every journey a fresh cart.id', async () => {
    const shop = fakeShop();
    const { opts } = options(shop, { carts: 3 });
    const results = await runCartTick(opts);
    expect(new Set(results.map((r) => r.cartId)).size).toBe(3);
  });

  it('does nothing at or after stopAt', async () => {
    const shop = fakeShop();
    const { opts } = options(shop, {
      carts: 12,
      stopAt: new Date('2026-10-14T00:00:00Z'),
      now: () => Date.parse('2026-10-14T00:00:00Z'),
    });
    expect(await runCartTick(opts)).toEqual([]);
    expect(shop.calls).toHaveLength(0);
  });

  it('caps carts per tick', async () => {
    const shop = fakeShop();
    const { opts } = options(shop, { carts: 1000 });
    expect(await runCartTick(opts)).toHaveLength(60);
  });
});
