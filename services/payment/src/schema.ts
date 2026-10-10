import { type Sql } from '@otel-demo/db';

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS charges (
    order_id text PRIMARY KEY,
    amount_cents integer NOT NULL,
    currency text NOT NULL,
    status text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  )`,
];

export async function migratePayment(sql: Sql): Promise<void> {
  for (const statement of STATEMENTS) {
    await sql.query(statement, [], 'migrate');
  }
}

export async function dropPayment(sql: Sql): Promise<void> {
  await sql.query('DROP TABLE IF EXISTS charges', [], 'seed');
}
