import { connectPg } from '@otel-demo/db';
import { seedShop } from './seed.js';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const sql = await connectPg(databaseUrl);
try {
  await seedShop(sql);
} finally {
  await sql.close();
}

process.stdout.write('seeded shop\n');
