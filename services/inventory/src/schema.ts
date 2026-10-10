import { type Sql } from '@otel-demo/db';

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS skus (
    sku text PRIMARY KEY,
    name text NOT NULL,
    category text NOT NULL,
    price_cents integer NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS warehouses (
    id text PRIMARY KEY,
    city text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS stock (
    warehouse_id text NOT NULL REFERENCES warehouses (id),
    sku text NOT NULL REFERENCES skus (sku),
    on_hand integer NOT NULL,
    reserved integer NOT NULL,
    PRIMARY KEY (warehouse_id, sku)
  )`,
  `CREATE TABLE IF NOT EXISTS reservations (
    order_id text PRIMARY KEY,
    status text NOT NULL,
    created_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reservation_lines (
    order_id text NOT NULL REFERENCES reservations (order_id),
    sku text NOT NULL,
    warehouse_id text NOT NULL,
    qty integer NOT NULL,
    PRIMARY KEY (order_id, sku, warehouse_id)
  )`,
];

const DROP_STATEMENTS = [
  'DROP TABLE IF EXISTS reservation_lines',
  'DROP TABLE IF EXISTS reservations',
  'DROP TABLE IF EXISTS stock',
  'DROP TABLE IF EXISTS skus',
  'DROP TABLE IF EXISTS warehouses',
];

export async function migrateInventory(sql: Sql): Promise<void> {
  for (const statement of STATEMENTS) {
    await sql.query(statement, [], 'migrate');
  }
}

export async function dropInventory(sql: Sql): Promise<void> {
  for (const statement of DROP_STATEMENTS) {
    await sql.query(statement, [], 'seed');
  }
}
