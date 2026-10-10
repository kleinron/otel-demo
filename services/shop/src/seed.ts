import { type Sql } from '@otel-demo/db';
import { allCustomers } from './customers.js';
import { dropShop, migrateShop } from './schema.js';

/** Drop shop tables and insert the same 1000 customers again. */
export async function seedShop(sql: Sql): Promise<void> {
  await dropShop(sql);
  await migrateShop(sql);
  const customers = allCustomers();
  const chunkSize = 100;
  for (let offset = 0; offset < customers.length; offset += chunkSize) {
    const chunk = customers.slice(offset, offset + chunkSize);
    const params: unknown[] = [];
    const tuples: string[] = [];
    for (const customer of chunk) {
      const base = params.length;
      tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
      params.push(customer.id, customer.nameEn, customer.nameHe, customer.city, customer.phone);
    }
    await sql.query(
      `INSERT INTO customers (id, name_en, name_he, city, phone) VALUES ${tuples.join(', ')}`,
      params,
      'seed',
    );
  }
}
