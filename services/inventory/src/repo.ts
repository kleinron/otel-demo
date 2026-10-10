import { asInt, isUniqueViolation, type Sql } from '@otel-demo/db';

export interface ReservationLine {
  sku: string;
  qty: number;
}

export interface Allocation {
  sku: string;
  warehouseId: string;
  qty: number;
}

export class OutOfStockError extends Error {
  readonly sku: string;

  constructor(sku: string) {
    super(`out of stock: ${sku}`);
    this.name = 'OutOfStockError';
    this.sku = sku;
  }
}

export class UnknownSkuError extends Error {
  readonly sku: string;

  constructor(sku: string) {
    super(`unknown sku: ${sku}`);
    this.name = 'UnknownSkuError';
    this.sku = sku;
  }
}

interface StockRow extends Record<string, unknown> {
  warehouse_id: string;
  sku: string;
  on_hand: number | string;
  reserved: number | string;
}

interface LineRow extends Record<string, unknown> {
  sku: string;
  warehouse_id: string;
  qty: number | string;
}

export interface InventoryRepo {
  reserve(orderId: string, items: readonly ReservationLine[]): Promise<Allocation[]>;
  release(orderId: string): Promise<'released' | 'missing'>;
  getSku(sku: string): Promise<
    | {
        sku: string;
        name: string;
        category: string;
        priceCents: number;
        available: number;
      }
    | undefined
  >;
}

export function createInventoryRepo(sql: Sql): InventoryRepo {
  return {
    async reserve(orderId, items) {
      const normalized = normalizeItems(items);
      try {
        return await sql.transaction(async (tx) => {
          const existing = await tx.query<{ status: string }>(
            'SELECT status FROM reservations WHERE order_id = $1',
            [orderId],
            'reservation.read',
          );
          const status = existing.rows[0]?.status;
          if (status === 'reserved') {
            return readAllocations(tx, orderId);
          }
          if (status) {
            throw new Error(`reservation ${orderId} is ${status}`);
          }

          const skuIds = normalized.map((item) => item.sku);
          const known = await tx.query<{ sku: string }>(
            `SELECT sku FROM skus WHERE sku IN (${placeholders(skuIds)})`,
            skuIds,
            'sku.read',
          );
          const knownIds = new Set(known.rows.map((row) => row.sku));
          for (const sku of skuIds) {
            if (!knownIds.has(sku)) {
              throw new UnknownSkuError(sku);
            }
          }

          const stock = await tx.query<StockRow>(
            `SELECT warehouse_id, sku, on_hand, reserved
             FROM stock
             WHERE sku IN (${placeholders(skuIds)})
             ORDER BY warehouse_id
             FOR UPDATE`,
            skuIds,
            'stock.read',
          );
          const allocations = planAllocations(normalized, stock.rows);
          for (const allocation of allocations) {
            const updated = await tx.query(
              `UPDATE stock
               SET reserved = reserved + $1
               WHERE warehouse_id = $2 AND sku = $3 AND on_hand - reserved >= $1
               RETURNING sku`,
              [allocation.qty, allocation.warehouseId, allocation.sku],
              'stock.reserve',
            );
            if (updated.rows.length === 0) {
              throw new OutOfStockError(allocation.sku);
            }
          }
          const createdAt = new Date().toISOString();
          await tx.query(
            'INSERT INTO reservations (order_id, status, created_at) VALUES ($1, $2, $3)',
            [orderId, 'reserved', createdAt],
            'reservation.write',
          );
          for (const allocation of allocations) {
            await tx.query(
              `INSERT INTO reservation_lines (order_id, sku, warehouse_id, qty)
               VALUES ($1, $2, $3, $4)`,
              [orderId, allocation.sku, allocation.warehouseId, allocation.qty],
              'reservation.write',
            );
          }
          return allocations;
        });
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        return sql.transaction(async (tx) => {
          const raced = await tx.query<{ status: string }>(
            'SELECT status FROM reservations WHERE order_id = $1',
            [orderId],
            'reservation.read',
          );
          if (raced.rows[0]?.status !== 'reserved') {
            throw error;
          }
          return readAllocations(tx, orderId);
        });
      }
    },

    async release(orderId) {
      return sql.transaction(async (tx) => {
        const existing = await tx.query<{ status: string }>(
          'SELECT status FROM reservations WHERE order_id = $1',
          [orderId],
          'reservation.read',
        );
        const status = existing.rows[0]?.status;
        if (!status) {
          return 'missing' as const;
        }
        if (status === 'released') {
          return 'released' as const;
        }
        const lines = await tx.query<LineRow>(
          'SELECT sku, warehouse_id, qty FROM reservation_lines WHERE order_id = $1',
          [orderId],
          'reservation.read',
        );
        for (const line of lines.rows) {
          await tx.query(
            `UPDATE stock
             SET reserved = reserved - $1
             WHERE warehouse_id = $2 AND sku = $3 AND reserved >= $1`,
            [asInt(line.qty), line.warehouse_id, line.sku],
            'stock.release',
          );
        }
        await tx.query(
          'UPDATE reservations SET status = $2 WHERE order_id = $1',
          [orderId, 'released'],
          'reservation.write',
        );
        return 'released' as const;
      });
    },

    async getSku(sku) {
      const result = await sql.query<{
        sku: string;
        name: string;
        category: string;
        price_cents: number | string;
        available: number | string | null;
      }>(
        `SELECT skus.sku, skus.name, skus.category, skus.price_cents,
                COALESCE(SUM(stock.on_hand - stock.reserved), 0) AS available
         FROM skus
         LEFT JOIN stock ON stock.sku = skus.sku
         WHERE skus.sku = $1
         GROUP BY skus.sku, skus.name, skus.category, skus.price_cents`,
        [sku],
        'sku.read',
      );
      const row = result.rows[0];
      if (!row) {
        return undefined;
      }
      return {
        sku: row.sku,
        name: row.name,
        category: row.category,
        priceCents: asInt(row.price_cents),
        available: asInt(row.available ?? 0),
      };
    },
  };
}

async function readAllocations(sql: Sql, orderId: string): Promise<Allocation[]> {
  const lines = await sql.query<LineRow>(
    'SELECT sku, warehouse_id, qty FROM reservation_lines WHERE order_id = $1 ORDER BY warehouse_id, sku',
    [orderId],
    'reservation.read',
  );
  return lines.rows.map((line) => ({
    sku: line.sku,
    warehouseId: line.warehouse_id,
    qty: asInt(line.qty),
  }));
}

function planAllocations(
  items: readonly ReservationLine[],
  rows: readonly StockRow[],
): Allocation[] {
  const allocations: Allocation[] = [];
  for (const item of items) {
    let remaining = item.qty;
    const matches = rows
      .filter((row) => row.sku === item.sku)
      .slice()
      .sort((left, right) => left.warehouse_id.localeCompare(right.warehouse_id));
    for (const row of matches) {
      const available = asInt(row.on_hand) - asInt(row.reserved);
      if (available <= 0) {
        continue;
      }
      const take = Math.min(available, remaining);
      allocations.push({ sku: item.sku, warehouseId: row.warehouse_id, qty: take });
      remaining -= take;
      if (remaining === 0) {
        break;
      }
    }
    if (remaining > 0) {
      throw new OutOfStockError(item.sku);
    }
  }
  return allocations;
}

function normalizeItems(items: readonly ReservationLine[]): ReservationLine[] {
  const totals = new Map<string, number>();
  for (const item of items) {
    totals.set(item.sku, (totals.get(item.sku) ?? 0) + item.qty);
  }
  return [...totals.entries()].map(([sku, qty]) => ({ sku, qty }));
}

function placeholders(values: readonly unknown[]): string {
  return values.map((_, index) => `$${index + 1}`).join(', ');
}
