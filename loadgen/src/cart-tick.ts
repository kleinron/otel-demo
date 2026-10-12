import { randomUUID } from 'node:crypto';
import {
  context,
  isSpanContextValid,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
} from '@opentelemetry/api';
import {
  customerId,
  GCP_SPAN_ID_FIELD,
  GCP_TRACE_FIELD,
  injectTraceHeaders,
  withCartBaggage,
} from '@otel-demo/telemetry';

/**
 * One load tick for the GCP deploy: `carts` simulated shopping-cart journeys,
 * started `spacingMs` apart. Each journey gets a fresh UUID v4 `cart.id` in
 * W3C baggage and does: open a cart, browse, add one or more items, checkout.
 * A failed checkout is retried once with the same `cart.id`, then the cart is
 * abandoned. After checkout succeeds or the cart is abandoned no request
 * carries that `cart.id` again, and one `cart closed` line is logged.
 * No real user data is involved.
 *
 * After `stopAt` the tick does nothing, so a late run cannot load the shop
 * past the hard stop.
 */
export interface CartTickOptions {
  shopUrl: string;
  carts: number;
  spacingMs: number;
  skus: readonly string[];
  customerCount: number;
  stopAt?: Date;
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  /** Extra headers for every request, such as a Cloud Run identity token. */
  authHeaders?: () => Promise<Record<string, string>>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  newId?: () => string;
  log?: (event: Record<string, unknown>) => void;
  /** Project for `logging.googleapis.com/trace` on loadgen lines. */
  projectId?: string;
}

export type CartOutcome = 'completed' | 'abandoned';

export interface CartResult {
  cartId: string;
  outcome: CartOutcome;
  checkoutAttempts: number;
}

export const MAX_CARTS_PER_TICK = 60;
export const MAX_ITEMS_PER_CART = 3;

export function stopped(stopAt: Date | undefined, nowMs: number): boolean {
  return stopAt !== undefined && nowMs >= stopAt.getTime();
}

function stdoutLog(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export async function runCartTick(options: CartTickOptions): Promise<CartResult[]> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = options.log ?? stdoutLog;
  if (stopped(options.stopAt, now())) {
    log({ severity: 'INFO', message: 'load stopped: past stopAt', stopAt: options.stopAt });
    return [];
  }
  const count = Math.max(0, Math.min(MAX_CARTS_PER_TICK, Math.floor(options.carts)));
  const runs: Promise<CartResult>[] = [];
  for (let i = 0; i < count; i += 1) {
    if (i > 0) {
      await sleep(options.spacingMs);
    }
    if (stopped(options.stopAt, now())) {
      break;
    }
    runs.push(runCart(options));
  }
  const results = await Promise.all(runs);
  log({
    severity: 'INFO',
    message: 'load tick done',
    carts: results.length,
    completed: results.filter((r) => r.outcome === 'completed').length,
  });
  return results;
}

export async function runCart(options: CartTickOptions): Promise<CartResult> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const random = options.random ?? Math.random;
  const log = options.log ?? stdoutLog;
  const cartId = (options.newId ?? randomUUID)();
  const base = options.shopUrl.replace(/\/+$/, '');
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  let checkoutAttempts = 0;

  // Each shopper step is its own root span (trace) carrying cart.id in baggage,
  // so a cart's requests line up by cart.id. With no SDK registered the spans
  // are no-ops and only the baggage header is sent, as before.
  const cartContext = withCartBaggage(cartId, ROOT_CONTEXT);
  const tracer = trace.getTracer('loadgen');

  function step<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
    return tracer.startActiveSpan(
      `cart ${name}`,
      { kind: SpanKind.CLIENT, root: true, attributes: { 'cart.id': cartId, 'cart.step': name } },
      cartContext,
      async (span) => {
        try {
          return await fn(span);
        } finally {
          span.end();
        }
      },
    );
  }

  function traceFields(): Record<string, string> {
    const spanContext = trace.getSpan(context.active())?.spanContext();
    if (!spanContext || !isSpanContextValid(spanContext)) {
      return {};
    }
    return {
      ...(options.projectId
        ? { [GCP_TRACE_FIELD]: `projects/${options.projectId}/traces/${spanContext.traceId}` }
        : {}),
      [GCP_SPAN_ID_FIELD]: spanContext.spanId,
    };
  }

  function call(
    operation: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: unknown }> {
    return step(operation, async (span) => {
      const started = performance.now();
      let status = 0;
      span.setAttribute('http.request.method', method);
      try {
        const response = await doFetch(`${base}${path}`, {
          method,
          headers: {
            accept: 'application/json',
            ...injectTraceHeaders({ baggage: `cart.id=${cartId}` }),
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(options.authHeaders ? await options.authHeaders() : {}),
            ...headers,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
        status = response.status;
        span.setAttribute('http.response.status_code', status);
        if (status >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${status}` });
        }
        return { status, body: parse(await response.text()) };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        return { status: 0, body: undefined };
      } finally {
        log({
          severity: status >= 500 || status === 0 ? 'WARNING' : 'INFO',
          message: 'request',
          ...traceFields(),
          cart: { id: cartId },
          operation,
          status,
          latencyMs: Math.round(performance.now() - started),
        });
      }
    });
  }

  async function close(outcome: CartOutcome): Promise<CartResult> {
    await step('close', async (span) => {
      span.setAttribute('cart.outcome', outcome);
      span.setAttribute('cart.checkout_attempts', checkoutAttempts);
      log({
        severity: 'INFO',
        message: 'cart closed',
        ...traceFields(),
        cart: { id: cartId },
        outcome,
        checkoutAttempts,
      });
    });
    return { cartId, outcome, checkoutAttempts };
  }

  const customer = customerId(Math.floor(random() * options.customerCount), options.customerCount);
  const created = await call('open-cart', 'POST', '/carts', { customerId: customer });
  const shopCart = (created.body as { cartId?: unknown } | undefined)?.cartId;
  if (created.status !== 201 || typeof shopCart !== 'string') {
    return close('abandoned');
  }
  const cartPath = `/carts/${encodeURIComponent(shopCart)}`;
  await call('browse', 'GET', cartPath);
  const items = 1 + Math.floor(random() * MAX_ITEMS_PER_CART);
  for (let i = 0; i < items; i += 1) {
    await call('add-to-cart', 'POST', `${cartPath}/items`, { sku: pick(options.skus), qty: 1 });
  }
  const orderKey = `lg-${cartId}`;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    checkoutAttempts = attempt;
    const checkout = await call('checkout', 'POST', `${cartPath}/checkout`, undefined, {
      'idempotency-key': orderKey,
    });
    if (checkout.status >= 200 && checkout.status < 300) {
      return close('completed');
    }
  }
  return close('abandoned');
}

function parse(text: string): unknown {
  try {
    return text.trim() === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}
