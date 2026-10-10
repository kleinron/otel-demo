import { Agent, request } from 'undici';

export interface ShopRequest {
  flowId: string;
  operation: string;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ShopResponse {
  status: number;
  body: unknown;
}

export interface ShopClient {
  request(input: ShopRequest): Promise<ShopResponse>;
}

export function createLoggingClient(
  inner: ShopClient,
  log: (event: Record<string, unknown>) => void,
  now: () => number = Date.now,
): ShopClient {
  return {
    async request(input) {
      const started = performance.now();
      const timestamp = new Date(now()).toISOString();
      let status = 0;
      try {
        const result = await inner.request(input);
        status = result.status;
        return result;
      } finally {
        log({
          msg: 'request',
          flowId: input.flowId,
          timestamp,
          operation: input.operation,
          status,
          latencyMs: Math.round(performance.now() - started),
        });
      }
    },
  };
}

/** Open-loop HTTP. A slow shop does not delay the next scheduled arrival. */
export function createUndiciClient(shopUrl: string): ShopClient {
  const agent = new Agent({
    connectTimeout: 5_000,
    headersTimeout: 30_000,
    bodyTimeout: 30_000,
  });
  const base = shopUrl.replace(/\/+$/, '');
  return {
    async request(input) {
      const response = await request(`${base}${input.path}`, {
        method: input.method,
        dispatcher: agent,
        headers: {
          accept: 'application/json',
          ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...input.headers,
        },
        body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
      });
      const text = await response.body.text();
      return { status: response.statusCode, body: parseBody(text) };
    },
  };
}

function parseBody(text: string): unknown {
  if (text.trim() === '') {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
