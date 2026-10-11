import { connectPg } from '@otel-demo/db';
import { restockInventory } from '../services/inventory/src/restock.js';

const databaseUrl = process.env.INVENTORY_DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error('INVENTORY_DATABASE_URL is required');
}

const sql = await connectPg(databaseUrl);
try {
  await restockInventory(sql);
} finally {
  await sql.close();
}

process.stdout.write('restocked inventory\n');
