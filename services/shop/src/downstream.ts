import { OutboundHttpError, isOutboundTimeout, tracedRequest } from '@otel-demo/httpkit';
import {
  currentCustomerHash,
  CUSTOMER_HASH_HEADER,
  ExpectedSideEffectFailure,
  withSideEffectLog,
  type OutboundMetrics,
} from '@otel-demo/telemetry';
import type { Logger } from 'pino';

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
  logger?: Logger;
}

export function createHttpDownstream(options: HttpDownstreamOptions): Downstream {
  return {
    async reserve(orderId, items) {
      try {
        await withSideEffectLog(
          options.logger,
          outboundFields('inventory-reserve', 'inventory', orderId),
          async (detail) => {
            const response = await tracedRequest({
              service: 'shop',
              target: 'inventory',
              operation: 'reserve',
              method: 'POST',
              url: joinUrl(options.inventoryUrl, '/reservations'),
              timeoutMs: options.timeoutMs,
              headers: callHeaders(orderId),
              body: { orderId, items },
              metrics: options.outbound,
            });
            detail.status = response.status;
            if (response.status === 409) {
              throw new ExpectedSideEffectFailure('out_of_stock', {
                sku: stringField(response.body, 'sku'),
              });
            }
            if (response.status >= 400) {
              throw new OutboundHttpError('inventory', response.status);
            }
          },
        );
        return { ok: true as const };
      } catch (error) {
        const settled = expectedResult(error, 'out_of_stock');
        if (settled) {
          return {
            ok: false as const,
            reason: 'out_of_stock' as const,
            sku: stringField(settled, 'sku'),
          };
        }
        throw error;
      }
    },

    async charge(orderId, amountCents) {
      try {
        const status = await withSideEffectLog(
          options.logger,
          outboundFields('payment-charge', 'payment', orderId),
          async (detail) => {
            const response = await tracedRequest({
              service: 'shop',
              target: 'payment',
              operation: 'charge',
              method: 'POST',
              url: joinUrl(options.paymentUrl, '/charges'),
              timeoutMs: options.timeoutMs,
              headers: callHeaders(orderId),
              body: { orderId, amountCents, currency: 'ILS' },
              metrics: options.outbound,
            });
            detail.status = response.status;
            if (response.status >= 400) {
              throw new OutboundHttpError('payment', response.status);
            }
            const payment = paymentStatus(response.body);
            if (payment === 'declined') {
              throw new ExpectedSideEffectFailure('declined');
            }
            return payment;
          },
        );
        return { status };
      } catch (error) {
        if (error instanceof ExpectedSideEffectFailure && error.outcome === 'declined') {
          return { status: 'declined' as const };
        }
        throw error;
      }
    },

    async capture(orderId) {
      const status = await withSideEffectLog(
        options.logger,
        outboundFields('payment-capture', 'payment', orderId),
        async (detail) => {
          const response = await tracedRequest({
            service: 'shop',
            target: 'payment',
            operation: 'capture',
            method: 'POST',
            url: joinUrl(options.paymentUrl, `/charges/${encodeURIComponent(orderId)}/capture`),
            timeoutMs: options.timeoutMs,
            headers: callHeaders(orderId),
            metrics: options.outbound,
          });
          detail.status = response.status;
          if (response.status >= 400) {
            throw new OutboundHttpError('payment', response.status);
          }
          return paymentStatus(response.body);
        },
      );
      return { status };
    },

    async handoff(orderId, city) {
      const status = await withSideEffectLog(
        options.logger,
        outboundFields('delivery-handoff', 'delivery', orderId),
        async (detail) => {
          const response = await tracedRequest({
            service: 'shop',
            target: 'delivery',
            operation: 'handoff',
            method: 'POST',
            url: joinUrl(options.deliveryUrl, '/handoffs'),
            timeoutMs: options.timeoutMs,
            headers: callHeaders(orderId),
            body: { orderId, city },
            metrics: options.outbound,
          });
          detail.status = response.status;
          if (response.status >= 400) {
            throw new OutboundHttpError('delivery', response.status);
          }
          return stringField(response.body, 'status') ?? 'accepted';
        },
      );
      return { status };
    },
  };
}

export function createHttpCatalog(
  inventoryUrl: string,
  timeoutMs: number,
  outbound?: OutboundMetrics,
  logger?: Logger,
): Catalog {
  return {
    async getSku(sku) {
      return withSideEffectLog(
        logger,
        outboundFields('inventory-get-sku', 'inventory'),
        async (detail) => {
          const response = await tracedRequest({
            service: 'shop',
            target: 'inventory',
            operation: 'get-sku',
            method: 'GET',
            url: joinUrl(inventoryUrl, `/skus/${encodeURIComponent(sku)}`),
            timeoutMs,
            headers: callHeaders(),
            metrics: outbound,
          });
          detail.status = response.status;
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
      );
    },
  };
}

export { isOutboundTimeout };

function outboundFields(action: string, target: string, orderId?: string) {
  return {
    action,
    target,
    orderId,
    customerHash: currentCustomerHash(),
  };
}

function callHeaders(orderId?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (orderId) {
    headers['idempotency-key'] = orderId;
  }
  const hash = currentCustomerHash();
  if (hash) {
    headers[CUSTOMER_HASH_HEADER] = hash;
  }
  return headers;
}

function expectedResult(error: unknown, outcome: string): unknown {
  if (error instanceof ExpectedSideEffectFailure && error.outcome === outcome) {
    return error.result ?? {};
  }
  return undefined;
}

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
