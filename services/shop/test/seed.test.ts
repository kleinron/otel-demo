import { asInt } from '@otel-demo/db';
import { createTestSql } from '../../../packages/db/testutil/sql.ts';
import { describe, expect, it } from 'vitest';
import { customerAt, SEED_CUSTOMER_COUNT } from '../src/customers.js';
import { migrateShop } from '../src/schema.js';
import { seedShop } from '../src/seed.js';

describe('shop seed', () => {
  it('rebuilds 1000 Israeli customers when the table is only partly filled', async () => {
    const sql = await createTestSql();
    await migrateShop(sql);
    await sql.query(
      `INSERT INTO customers (id, name_en, name_he, city, phone)
       VALUES ('junk-customer', 'Junk', 'זבל', 'Atlantis', '+972-51-111-1111')`,
      [],
      'seed',
    );
    await seedShop(sql);

    const first = customerAt(0);
    const last = customerAt(SEED_CUSTOMER_COUNT - 1);
    expect(first.phone).not.toMatch(/\d{12}/);
    expect(last.nameEn.length).toBeGreaterThan(0);
    expect(last.nameHe.length).toBeGreaterThan(0);

    const count = await countCustomers(sql);
    const junk = await sql.query(
      'SELECT id FROM customers WHERE id = $1',
      ['junk-customer'],
      'customer.read',
    );
    const stored = await sql.query<{
      name_en: string;
      name_he: string;
      city: string;
      phone: string;
    }>(
      'SELECT name_en, name_he, city, phone FROM customers WHERE id = $1',
      [first.id],
      'customer.read',
    );
    expect(count).toBe(SEED_CUSTOMER_COUNT);
    expect(junk.rows).toEqual([]);
    expect(stored.rows[0]).toEqual({
      name_en: first.nameEn,
      name_he: first.nameHe,
      city: first.city,
      phone: first.phone,
    });

    await sql.query('DELETE FROM customers WHERE id = $1', [first.id], 'seed');
    await sql.query(
      `INSERT INTO customers (id, name_en, name_he, city, phone)
       VALUES ('junk-customer', 'Junk', 'זבל', 'Atlantis', '+972-51-111-2222')`,
      [],
      'seed',
    );
    await seedShop(sql);
    const rebuilt = await countCustomers(sql);
    const restored = await sql.query<{ phone: string }>(
      'SELECT phone FROM customers WHERE id = $1',
      [first.id],
      'customer.read',
    );
    const junkAgain = await sql.query(
      'SELECT id FROM customers WHERE id = $1',
      ['junk-customer'],
      'customer.read',
    );
    expect(rebuilt).toBe(SEED_CUSTOMER_COUNT);
    expect(restored.rows[0]?.phone).toBe(first.phone);
    expect(junkAgain.rows).toEqual([]);
    await sql.close();
  });
});

async function countCustomers(sql: Awaited<ReturnType<typeof createTestSql>>): Promise<number> {
  const result = await sql.query<{ count: number | string }>(
    'SELECT COUNT(*)::int AS count FROM customers',
    [],
    'customer.read',
  );
  return asInt(result.rows[0]?.count);
}
