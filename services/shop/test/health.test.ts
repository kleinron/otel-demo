import { describe, expect, it } from 'vitest';
import { buildApp, SERVICE_NAME } from '../src/server.js';

describe('shop', () => {
  it('serves health and records the call', async () => {
    const seen: Array<{ operation: string; statusCode: number; method: string; service?: string }> =
      [];
    const app = buildApp({
      metrics: {
        record(observation) {
          seen.push(observation);
        },
      },
    });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: SERVICE_NAME });
    expect(seen).toEqual([
      expect.objectContaining({
        operation: '/health',
        method: 'GET',
        statusCode: 200,
        service: 'shop',
      }),
    ]);
    await app.close();
  });

  it('records the route template rather than the raw URL', async () => {
    const seen: string[] = [];
    const app = buildApp({
      metrics: {
        record(observation) {
          seen.push(observation.operation);
        },
      },
    });
    app.get('/cart/items/:id', async () => ({ ok: true }));

    const missing = await app.inject({ method: 'GET', url: '/no-such-route/sku-42?verbose=1' });
    const health = await app.inject({ method: 'GET', url: '/health?verbose=1' });
    const item = await app.inject({ method: 'GET', url: '/cart/items/sku-42?verbose=1' });

    expect(missing.statusCode).toBe(404);
    expect(health.statusCode).toBe(200);
    expect(item.statusCode).toBe(200);
    expect(seen).toEqual(['unmatched', '/health', '/cart/items/:id']);
    await app.close();
  });
});
