import { connectPg } from '@otel-demo/db';
import { seedInventory } from './seed.js';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const sql = await connectPg(databaseUrl);
try {
  await seedInventory(sql);
} finally {
  await sql.close();
}

process.stdout.write('seeded inventory\n');
