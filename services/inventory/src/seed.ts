import { type Sql } from '@otel-demo/db';
import { CATALOG, stockOnHand, WAREHOUSES } from './catalog.js';
import { dropInventory, migrateInventory } from './schema.js';

/** Drop every inventory table and load the catalog and warehouse stock again. */
export async function seedInventory(sql: Sql): Promise<void> {
  await dropInventory(sql);
  await migrateInventory(sql);

  for (const sku of CATALOG) {
    await sql.query(
      'INSERT INTO skus (sku, name, category, price_cents) VALUES ($1, $2, $3, $4)',
      [sku.sku, sku.name, sku.category, sku.priceCents],
      'seed',
    );
  }
  for (const warehouse of WAREHOUSES) {
    await sql.query(
      'INSERT INTO warehouses (id, city) VALUES ($1, $2)',
      [warehouse.id, warehouse.city],
      'seed',
    );
  }
  for (const sku of CATALOG) {
    for (const warehouse of WAREHOUSES) {
      await sql.query(
        `INSERT INTO stock (warehouse_id, sku, on_hand, reserved) VALUES ($1, $2, $3, 0)`,
        [warehouse.id, sku.sku, stockOnHand(sku.sku, warehouse.id)],
        'seed',
      );
    }
  }
}
