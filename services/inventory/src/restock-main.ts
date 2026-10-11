import { connectPg } from '@otel-demo/db';
import { restockInventory } from './restock.js';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const sql = await connectPg(databaseUrl);
try {
  await restockInventory(sql);
} finally {
  await sql.close();
}

process.stdout.write('restocked inventory\n');
