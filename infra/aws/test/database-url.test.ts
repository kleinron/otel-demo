import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { buildDatabaseUrl, createFaultSwitch } = require('../docker/fault-switch.cjs') as {
  buildDatabaseUrl: (env: Record<string, string | undefined>) => void;
  createFaultSwitch: (
    env: Record<string, string | undefined>,
    client?: {
      send: (command: { input: { Name?: string } }) => Promise<{ Parameter?: { Value?: string } }>;
    },
  ) => { read: () => Promise<boolean> };
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

  it('polls the parameter named by OTEL_DEMO_FAULTS_PARAMETER', async () => {
    const names: string[] = [];
    const reader = createFaultSwitch(
      { OTEL_DEMO_FAULTS_PARAMETER: '/otel-demo/faults-enabled', AWS_REGION: 'eu-central-1' },
      {
        async send(command) {
          names.push(command.input.Name ?? '');
          return { Parameter: { Value: 'on' } };
        },
      },
    );
    await expect(reader.read()).resolves.toBe(true);
    await expect(
      createFaultSwitch(
        { FAULT_SWITCH_SSM_PARAMETER: '/custom', AWS_REGION: 'eu-central-1' },
        {
          async send(command) {
            names.push(command.input.Name ?? '');
            return { Parameter: { Value: 'off' } };
          },
        },
      ).read(),
    ).resolves.toBe(false);
    expect(names).toEqual(['/otel-demo/faults-enabled', '/custom']);
  });

  it('exposes createFaultSwitch to a dynamic import', async () => {
    const imported = (await import(
      new URL('../docker/fault-switch.cjs', import.meta.url).href
    )) as {
      createFaultSwitch?: unknown;
    };
    expect(typeof imported.createFaultSwitch).toBe('function');
  });
});
