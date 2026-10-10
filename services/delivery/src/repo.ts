import { isUniqueViolation, type Sql } from '@otel-demo/db';

export const DELIVERY_STATUSES = ['accepted', 'packaging', 'shipped'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface Delivery {
  orderId: string;
  city: string;
  status: DeliveryStatus;
  createdAt: string;
  updatedAt: string;
}

interface DeliveryRow extends Record<string, unknown> {
  order_id: string;
  city: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface DeliveryRepo {
  get(orderId: string): Promise<Delivery | undefined>;
  accept(orderId: string, city: string): Promise<Delivery>;
  transition(orderId: string, status: DeliveryStatus): Promise<Delivery | undefined>;
}

export function createDeliveryRepo(sql: Sql): DeliveryRepo {
  return {
    async get(orderId) {
      const result = await sql.query<DeliveryRow>(
        'SELECT order_id, city, status, created_at, updated_at FROM deliveries WHERE order_id = $1',
        [orderId],
        'delivery.read',
      );
      const row = result.rows[0];
      return row ? mapDelivery(row) : undefined;
    },

    async accept(orderId, city) {
      const existing = await this.get(orderId);
      if (existing) {
        return existing;
      }
      const now = new Date().toISOString();
      try {
        await sql.query(
          `INSERT INTO deliveries (order_id, city, status, created_at, updated_at)
           VALUES ($1, $2, 'accepted', $3, $4)`,
          [orderId, city, now, now],
          'delivery.write',
        );
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
      }
      const stored = await this.get(orderId);
      if (!stored) {
        throw new Error(`delivery ${orderId} was not stored`);
      }
      return stored;
    },

    async transition(orderId, status) {
      const now = new Date().toISOString();
      const result = await sql.query<DeliveryRow>(
        `UPDATE deliveries SET status = $2, updated_at = $3 WHERE order_id = $1
         RETURNING order_id, city, status, created_at, updated_at`,
        [orderId, status, now],
        'delivery.write',
      );
      const row = result.rows[0];
      return row ? mapDelivery(row) : undefined;
    },
  };
}

export function nextStatus(status: DeliveryStatus): DeliveryStatus | undefined {
  if (status === 'accepted') {
    return 'packaging';
  }
  if (status === 'packaging') {
    return 'shipped';
  }
  return undefined;
}

function mapDelivery(row: DeliveryRow): Delivery {
  if (!isDeliveryStatus(row.status)) {
    throw new Error(`unknown delivery status ${row.status}`);
  }
  return {
    orderId: row.order_id,
    city: row.city,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isDeliveryStatus(value: string): value is DeliveryStatus {
  return (DELIVERY_STATUSES as readonly string[]).includes(value);
}
