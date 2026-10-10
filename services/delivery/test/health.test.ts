import { describe, expect, it } from 'vitest';
import { buildApp, SERVICE_NAME } from '../src/server.js';

describe('delivery', () => {
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
        operation: 'GET /health',
        method: 'GET',
        statusCode: 200,
        service: 'delivery',
      }),
    ]);
    await app.close();
  });
});
