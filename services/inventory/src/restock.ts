import { type Sql } from '@otel-demo/db';
import { CATALOG, stockOnHand, WAREHOUSES } from './catalog.js';
import { migrateInventory } from './schema.js';

/**
 * Bring available stock back to the seed target.
 *
 * `on_hand` becomes `reserved + target`, so a second run with no new reserves
 * writes the same numbers. Reservations, reservation lines, and any shop orders
 * are left in place. This does not drop tables.
 */
export async function restockInventory(sql: Sql): Promise<void> {
  await migrateInventory(sql);

  for (const sku of CATALOG) {
    await sql.query(
      `INSERT INTO skus (sku, name, category, price_cents) VALUES ($1, $2, $3, $4)
       ON CONFLICT (sku) DO NOTHING`,
      [sku.sku, sku.name, sku.category, sku.priceCents],
      'restock',
    );
  }
  for (const warehouse of WAREHOUSES) {
    await sql.query(
      `INSERT INTO warehouses (id, city) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [warehouse.id, warehouse.city],
      'restock',
    );
  }
  for (const sku of CATALOG) {
    for (const warehouse of WAREHOUSES) {
      await sql.query(
        `INSERT INTO stock (warehouse_id, sku, on_hand, reserved) VALUES ($1, $2, $3, 0)
         ON CONFLICT (warehouse_id, sku)
         DO UPDATE SET on_hand = stock.reserved + EXCLUDED.on_hand`,
        [warehouse.id, sku.sku, stockOnHand(sku.sku, warehouse.id)],
        'restock',
      );
    }
  }
}
