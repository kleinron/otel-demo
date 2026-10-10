import { asInt } from '@otel-demo/db';
import { createTestSql } from '../../../packages/db/testutil/sql.ts';
import { describe, expect, it } from 'vitest';
import { CATALOG, stockOnHand, WAREHOUSES } from '../src/catalog.js';
import { migrateInventory } from '../src/schema.js';
import { seedInventory } from '../src/seed.js';

describe('inventory seed', () => {
  it('rebuilds the catalog and stock when old rows are only partly present', async () => {
    const sql = await createTestSql();
    await migrateInventory(sql);
    await sql.query(
      'INSERT INTO warehouses (id, city) VALUES ($1, $2)',
      ['wh-junk', 'Atlantis'],
      'seed',
    );
    await seedInventory(sql);

    const skus = await sql.query<{ count: number | string }>(
      'SELECT COUNT(*)::int AS count FROM skus',
      [],
      'sku.read',
    );
    const stock = await sql.query<{ on_hand: number | string }>(
      'SELECT on_hand FROM stock WHERE sku = $1 AND warehouse_id = $2',
      ['powerbank-dead-sea', 'wh-tlv'],
      'stock.read',
    );
    const junk = await sql.query(
      'SELECT id FROM warehouses WHERE id = $1',
      ['wh-junk'],
      'sku.read',
    );
    expect(asInt(skus.rows[0]?.count)).toBe(CATALOG.length);
    expect(asInt(stock.rows[0]?.on_hand)).toBe(stockOnHand('powerbank-dead-sea', 'wh-tlv'));
    expect(junk.rows).toEqual([]);

    await sql.query('UPDATE stock SET on_hand = 1 WHERE sku = $1', ['phone-aurora'], 'seed');
    await seedInventory(sql);
    const rebuilt = await sql.query<{ count: number | string }>(
      'SELECT COUNT(*)::int AS count FROM skus',
      [],
      'sku.read',
    );
    const restored = await sql.query<{ on_hand: number | string }>(
      'SELECT on_hand FROM stock WHERE sku = $1 AND warehouse_id = $2',
      ['phone-aurora', 'wh-haifa'],
      'stock.read',
    );
    const warehouses = await sql.query<{ count: number | string }>(
      'SELECT COUNT(*)::int AS count FROM warehouses',
      [],
      'sku.read',
    );
    expect(asInt(rebuilt.rows[0]?.count)).toBe(CATALOG.length);
    expect(asInt(restored.rows[0]?.on_hand)).toBe(stockOnHand('phone-aurora', 'wh-haifa'));
    expect(asInt(warehouses.rows[0]?.count)).toBe(WAREHOUSES.length);
    await sql.close();
  });
});
