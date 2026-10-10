import { type Sql } from '@otel-demo/db';

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS customers (
    id text PRIMARY KEY,
    name_en text NOT NULL,
    name_he text NOT NULL,
    city text NOT NULL,
    phone text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS carts (
    id text PRIMARY KEY,
    customer_id text NOT NULL REFERENCES customers (id),
    created_at text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cart_items (
    cart_id text NOT NULL REFERENCES carts (id),
    sku text NOT NULL,
    qty integer NOT NULL,
    unit_price_cents integer NOT NULL,
    PRIMARY KEY (cart_id, sku)
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id text PRIMARY KEY,
    cart_id text NOT NULL REFERENCES carts (id),
    customer_id text NOT NULL,
    status text NOT NULL,
    city text NOT NULL,
    amount_cents integer NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
];

const DROP_STATEMENTS = [
  'DROP TABLE IF EXISTS orders',
  'DROP TABLE IF EXISTS cart_items',
  'DROP TABLE IF EXISTS carts',
  'DROP TABLE IF EXISTS customers',
];

export async function migrateShop(sql: Sql): Promise<void> {
  for (const statement of STATEMENTS) {
    await sql.query(statement, [], 'migrate');
  }
}

export async function dropShop(sql: Sql): Promise<void> {
  for (const statement of DROP_STATEMENTS) {
    await sql.query(statement, [], 'seed');
  }
}
