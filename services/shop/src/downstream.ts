import { OutboundHttpError, isOutboundTimeout, tracedRequest } from '@otel-demo/httpkit';
import type { OutboundMetrics } from '@otel-demo/telemetry';

export interface LineItem {
  sku: string;
  qty: number;
}

export type ReserveResult = { ok: true } | { ok: false; reason: 'out_of_stock'; sku?: string };

export interface PaymentSnapshot {
  status: 'authorized' | 'captured' | 'declined' | 'unknown';
}

export interface Downstream {
  reserve(orderId: string, items: readonly LineItem[]): Promise<ReserveResult>;
  charge(orderId: string, amountCents: number): Promise<PaymentSnapshot>;
  capture(orderId: string): Promise<PaymentSnapshot>;
  handoff(orderId: string, city: string): Promise<{ status: string }>;
}

export interface Catalog {
  getSku(sku: string): Promise<{ sku: string; priceCents: number } | undefined>;
}

export interface HttpDownstreamOptions {
  inventoryUrl: string;
  paymentUrl: string;
  deliveryUrl: string;
  timeoutMs: number;
  outbound?: OutboundMetrics;
}

export function createHttpDownstream(options: HttpDownstreamOptions): Downstream {
  return {
    async reserve(orderId, items) {
      const response = await tracedRequest({
        service: 'shop',
        target: 'inventory',
        operation: 'reserve',
        method: 'POST',
        url: joinUrl(options.inventoryUrl, '/reservations'),
        timeoutMs: options.timeoutMs,
        headers: { 'idempotency-key': orderId },
        body: { orderId, items },
        metrics: options.outbound,
      });
      if (response.status === 409) {
        return { ok: false, reason: 'out_of_stock', sku: stringField(response.body, 'sku') };
      }
      if (response.status >= 400) {
        throw new OutboundHttpError('inventory', response.status);
      }
      return { ok: true };
    },

    async charge(orderId, amountCents) {
      const response = await tracedRequest({
        service: 'shop',
        target: 'payment',
        operation: 'charge',
        method: 'POST',
        url: joinUrl(options.paymentUrl, '/charges'),
        timeoutMs: options.timeoutMs,
        headers: { 'idempotency-key': orderId },
        body: { orderId, amountCents, currency: 'ILS' },
        metrics: options.outbound,
      });
      if (response.status >= 400) {
        throw new OutboundHttpError('payment', response.status);
      }
      return { status: paymentStatus(response.body) };
    },

    async capture(orderId) {
      const response = await tracedRequest({
        service: 'shop',
        target: 'payment',
        operation: 'capture',
        method: 'POST',
        url: joinUrl(options.paymentUrl, `/charges/${encodeURIComponent(orderId)}/capture`),
        timeoutMs: options.timeoutMs,
        headers: { 'idempotency-key': orderId },
        metrics: options.outbound,
      });
      if (response.status >= 400) {
        throw new OutboundHttpError('payment', response.status);
      }
      return { status: paymentStatus(response.body) };
    },

    async handoff(orderId, city) {
      const response = await tracedRequest({
        service: 'shop',
        target: 'delivery',
        operation: 'handoff',
        method: 'POST',
        url: joinUrl(options.deliveryUrl, '/handoffs'),
        timeoutMs: options.timeoutMs,
        headers: { 'idempotency-key': orderId },
        body: { orderId, city },
        metrics: options.outbound,
      });
      if (response.status >= 400) {
        throw new OutboundHttpError('delivery', response.status);
      }
      return { status: stringField(response.body, 'status') ?? 'accepted' };
    },
  };
}

export function createHttpCatalog(
  inventoryUrl: string,
  timeoutMs: number,
  outbound?: OutboundMetrics,
): Catalog {
  return {
    async getSku(sku) {
      const response = await tracedRequest({
        service: 'shop',
        target: 'inventory',
        operation: 'get-sku',
        method: 'GET',
        url: joinUrl(inventoryUrl, `/skus/${encodeURIComponent(sku)}`),
        timeoutMs,
        metrics: outbound,
      });
      if (response.status === 404) {
        return undefined;
      }
      if (response.status >= 400) {
        throw new OutboundHttpError('inventory', response.status);
      }
      const priceCents = numberField(response.body, 'priceCents');
      if (priceCents === undefined) {
        throw new OutboundHttpError('inventory', response.status);
      }
      return { sku, priceCents };
    },
  };
}

export { isOutboundTimeout };

function paymentStatus(body: unknown): PaymentSnapshot['status'] {
  const status = stringField(body, 'status');
  if (
    status === 'authorized' ||
    status === 'captured' ||
    status === 'declined' ||
    status === 'unknown'
  ) {
    return status;
  }
  throw new OutboundHttpError('payment', 502);
}

function stringField(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(body: unknown, key: string): number | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : undefined;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}
