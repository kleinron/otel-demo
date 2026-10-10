import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { buildDatabaseUrl } = require('../docker/fault-switch.cjs') as {
  buildDatabaseUrl: (env: Record<string, string | undefined>) => void;
};

describe('fault switch database url', () => {
  it('builds DATABASE_URL from DB_* and skips certificate verification', () => {
    const env: Record<string, string | undefined> = {
      DB_HOST: 'db.internal',
      DB_PORT: '5432',
      DB_NAME: 'shop',
      DB_USER: 'otel demo',
      DB_PASSWORD: 'a/b',
    };
    buildDatabaseUrl(env);
    expect(env.DATABASE_URL).toBe(
      'postgres://otel%20demo:a%2Fb@db.internal:5432/shop?sslmode=no-verify',
    );
  });

  it('keeps an existing DATABASE_URL and stays quiet without a host', () => {
    const existing: Record<string, string | undefined> = {
      DATABASE_URL: 'postgres://local/shop',
      DB_HOST: 'db.internal',
      DB_USER: 'otel',
      DB_PASSWORD: 'pw',
      DB_NAME: 'shop',
    };
    buildDatabaseUrl(existing);
    expect(existing.DATABASE_URL).toBe('postgres://local/shop');

    const empty: Record<string, string | undefined> = { DB_NAME: 'shop' };
    buildDatabaseUrl(empty);
    expect(empty.DATABASE_URL).toBeUndefined();
  });
});
