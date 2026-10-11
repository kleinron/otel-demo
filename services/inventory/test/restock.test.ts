import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { asInt } from '@otel-demo/db';
import { arrivalRatePerSecond, buildPlan, parseLoadSchedule } from '@otel-demo/telemetry';
import { createTestSql } from '../../../packages/db/testutil/sql.ts';
import { describe, expect, it } from 'vitest';
import { CATALOG, stockOnHand, WAREHOUSES } from '../src/catalog.js';
import { createInventoryRepo } from '../src/repo.js';
import { restockInventory } from '../src/restock.js';
import { seedInventory } from '../src/seed.js';

const SECOND_ITEM_FRACTION = 0.4;

describe('inventory restock', () => {
  it('tops available stock back up to the seed target and keeps reservations', async () => {
    const sql = await createTestSql();
    await seedInventory(sql);
    await sql.query(
      'INSERT INTO warehouses (id, city) VALUES ($1, $2)',
      ['wh-junk', 'Kept'],
      'restock',
    );
    const repo = createInventoryRepo(sql);
    await repo.reserve('order-77', [{ sku: 'phone-aurora', qty: 3 }]);
    await sql.query(
      'UPDATE stock SET on_hand = reserved WHERE sku <> $1',
      ['powerbank-dead-sea'],
      'restock',
    );

    await restockInventory(sql);
    await expectAvailable(sql, 'phone-aurora');
    const reserved = await sql.query<{ reserved: number | string }>(
      'SELECT reserved FROM stock WHERE sku = $1 AND warehouse_id = $2',
      ['phone-aurora', 'wh-haifa'],
      'stock.read',
    );
    expect(asInt(reserved.rows[0]?.reserved)).toBe(3);
    const orders = await sql.query<{ order_id: string }>(
      'SELECT order_id FROM reservations ORDER BY order_id',
      [],
      'reservation.read',
    );
    expect(orders.rows.map((row) => row.order_id)).toEqual(['order-77']);

    const before = await onHand(sql, 'laptop-negev-16', 'wh-tlv');
    await restockInventory(sql);
    expect(await onHand(sql, 'laptop-negev-16', 'wh-tlv')).toBe(before);
    const junk = await sql.query(
      'SELECT id FROM warehouses WHERE id = $1',
      ['wh-junk'],
      'sku.read',
    );
    expect(junk.rows).toEqual([{ id: 'wh-junk' }]);
    await sql.close();
  });

  it('holds enough regular stock for the 72h checkout profile and keeps the scarce sku scarce', () => {
    const schedule = parseLoadSchedule(
      JSON.parse(
        readFileSync(
          fileURLToPath(new URL('../../../loadgen/schedule.json', import.meta.url)),
          'utf8',
        ),
      ),
    );
    const plan = buildPlan(schedule);
    let checkouts = 0;
    const stepMs = 60_000;
    for (let t = plan.startMs; t < plan.hardStopMs; t += stepMs) {
      checkouts += arrivalRatePerSecond(plan, 'checkout', t + stepMs / 2) * (stepMs / 1000);
    }
    const skuCount = schedule.skus.length;
    const perCheckout =
      1 / skuCount + SECOND_ITEM_FRACTION * (1 / skuCount) * ((skuCount - 1) / skuCount);
    const perSku = checkouts * (1 - schedule.outOfStock.fraction) * perCheckout;
    const regular = WAREHOUSES.reduce(
      (sum, warehouse) => sum + stockOnHand('phone-aurora', warehouse.id),
      0,
    );
    const scarce = WAREHOUSES.reduce(
      (sum, warehouse) => sum + stockOnHand(schedule.outOfStock.sku, warehouse.id),
      0,
    );
    expect(regular).toBeGreaterThan(perSku * 1.25);
    expect(scarce).toBeLessThan(schedule.outOfStock.qty);
    expect(CATALOG.some((item) => item.sku === 'powerbank-dead-sea')).toBe(true);
  });
});

async function expectAvailable(sql: Awaited<ReturnType<typeof createTestSql>>, sku: string) {
  for (const warehouse of WAREHOUSES) {
    const row = await sql.query<{ on_hand: number | string; reserved: number | string }>(
      'SELECT on_hand, reserved FROM stock WHERE sku = $1 AND warehouse_id = $2',
      [sku, warehouse.id],
      'stock.read',
    );
    const stock = row.rows[0];
    expect(stock).toBeDefined();
    expect(asInt(stock?.on_hand) - asInt(stock?.reserved)).toBe(stockOnHand(sku, warehouse.id));
  }
}

async function onHand(
  sql: Awaited<ReturnType<typeof createTestSql>>,
  sku: string,
  warehouseId: string,
): Promise<number> {
  const row = await sql.query<{ on_hand: number | string }>(
    'SELECT on_hand FROM stock WHERE sku = $1 AND warehouse_id = $2',
    [sku, warehouseId],
    'stock.read',
  );
  return asInt(row.rows[0]?.on_hand);
}
