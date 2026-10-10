import { type Sql } from '@otel-demo/db';

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS deliveries (
    order_id text PRIMARY KEY,
    city text NOT NULL,
    status text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
];

export async function migrateDelivery(sql: Sql): Promise<void> {
  for (const statement of STATEMENTS) {
    await sql.query(statement, [], 'migrate');
  }
}

export async function dropDelivery(sql: Sql): Promise<void> {
  await sql.query('DROP TABLE IF EXISTS deliveries', [], 'seed');
}
