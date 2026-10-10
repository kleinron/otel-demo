import { asInt, isUniqueViolation, type Sql } from '@otel-demo/db';

export const PAYMENT_STATUSES = ['authorized', 'captured', 'declined', 'unknown'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface Charge {
  orderId: string;
  amountCents: number;
  currency: string;
  status: PaymentStatus;
  createdAt: string;
  updatedAt: string;
}

interface ChargeRow extends Record<string, unknown> {
  order_id: string;
  amount_cents: number | string;
  currency: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface PaymentRepo {
  get(orderId: string): Promise<Charge | undefined>;
  create(input: {
    orderId: string;
    amountCents: number;
    currency: string;
    status: PaymentStatus;
  }): Promise<Charge>;
  updateStatus(orderId: string, status: PaymentStatus): Promise<Charge | undefined>;
}

export function createPaymentRepo(sql: Sql): PaymentRepo {
  return {
    async get(orderId) {
      const result = await sql.query<ChargeRow>(
        'SELECT order_id, amount_cents, currency, status, created_at, updated_at FROM charges WHERE order_id = $1',
        [orderId],
        'charge.read',
      );
      const row = result.rows[0];
      return row ? mapCharge(row) : undefined;
    },

    async create(input) {
      const existing = await this.get(input.orderId);
      if (existing) {
        return existing;
      }
      const now = new Date().toISOString();
      try {
        await sql.query(
          `INSERT INTO charges (order_id, amount_cents, currency, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [input.orderId, input.amountCents, input.currency, input.status, now, now],
          'charge.write',
        );
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
      }
      const stored = await this.get(input.orderId);
      if (!stored) {
        throw new Error(`charge ${input.orderId} was not stored`);
      }
      return stored;
    },

    async updateStatus(orderId, status) {
      const now = new Date().toISOString();
      const result = await sql.query<ChargeRow>(
        `UPDATE charges SET status = $2, updated_at = $3 WHERE order_id = $1
         RETURNING order_id, amount_cents, currency, status, created_at, updated_at`,
        [orderId, status, now],
        'charge.write',
      );
      const row = result.rows[0];
      return row ? mapCharge(row) : undefined;
    },
  };
}

function mapCharge(row: ChargeRow): Charge {
  if (!isPaymentStatus(row.status)) {
    throw new Error(`unknown payment status ${row.status}`);
  }
  return {
    orderId: row.order_id,
    amountCents: asInt(row.amount_cents),
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function isPaymentStatus(value: string): value is PaymentStatus {
  return (PAYMENT_STATUSES as readonly string[]).includes(value);
}
