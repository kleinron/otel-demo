import { describe, expect, it } from 'vitest';
import { hardStopCron } from '../src/hard-stop.js';
import {
  createFaultSwitch,
  createSecretManagerClient,
  resolveFaultSwitchProvider,
  secretVersionResource,
  type SecretFetch,
} from '../src/fault-switch.js';

describe('fault switch provider', () => {
  it('defaults to the AWS SSM reader', async () => {
    expect(resolveFaultSwitchProvider({})).toBe('aws-ssm');
    expect(resolveFaultSwitchProvider({ FAULT_SWITCH_PROVIDER: 'aws' })).toBe('aws-ssm');
    const names: string[] = [];
    const secrets: string[] = [];
    const reader = createFaultSwitch(
      {},
      {
        ssm: {
          async send(command) {
            names.push(command.input.Name ?? '');
            return { Parameter: { Value: 'true' } };
          },
        },
        secrets: {
          async access(resource) {
            secrets.push(resource);
            return 'on';
          },
        },
      },
    );
    await expect(reader.read()).resolves.toBe(true);
    expect(names).toEqual(['/otel-demo/faults-enabled']);
    expect(secrets).toEqual([]);
  });

  it('reads a Secret Manager value through a fake and does not call SSM', async () => {
    const resources: string[] = [];
    let ssmCalled = false;
    const reader = createFaultSwitch(
      {
        FAULT_SWITCH_PROVIDER: 'gcp',
        GCP_PROJECT_ID: 'otel-demo-spike',
      },
      {
        ssm: {
          async send() {
            ssmCalled = true;
            return { Parameter: { Value: 'true' } };
          },
        },
        secrets: {
          async access(resource) {
            resources.push(resource);
            return 'off';
          },
        },
      },
    );
    await expect(reader.read()).resolves.toBe(false);
    expect(ssmCalled).toBe(false);
    expect(resources).toEqual([
      'projects/otel-demo-spike/secrets/otel-demo-faults-enabled/versions/latest',
    ]);
  });

  it('reads a config value and does not call Secret Manager', async () => {
    expect(
      resolveFaultSwitchProvider({
        FAULT_SWITCH_PROVIDER: 'gcp',
        GCP_FAULT_SWITCH_SOURCE: 'config',
      }),
    ).toBe('gcp-config');
    let called = false;
    const reader = createFaultSwitch(
      {
        FAULT_SWITCH_PROVIDER: 'gcp-config',
        GCP_FAULT_SWITCH_VALUE: 'on',
      },
      {
        secrets: {
          async access() {
            called = true;
            return 'off';
          },
        },
      },
    );
    await expect(reader.read()).resolves.toBe(true);
    expect(called).toBe(false);
  });

  it('throws when the secret or the config value cannot be read', async () => {
    const secret = createFaultSwitch(
      { FAULT_SWITCH_PROVIDER: 'gcp', GCP_PROJECT_ID: 'otel-demo-spike' },
      {
        secrets: {
          async access() {
            throw new Error('permission denied');
          },
        },
      },
    );
    await expect(secret.read()).rejects.toThrow(/permission denied/);

    const empty = createFaultSwitch(
      { FAULT_SWITCH_PROVIDER: 'gcp', GCP_PROJECT_ID: 'otel-demo-spike' },
      {
        secrets: {
          async access() {
            return '   ';
          },
        },
      },
    );
    await expect(empty.read()).rejects.toThrow(/empty/);

    const config = createFaultSwitch({ FAULT_SWITCH_PROVIDER: 'gcp-config' });
    await expect(config.read()).rejects.toThrow(/empty/);
    expect(() => resolveFaultSwitchProvider({ FAULT_SWITCH_PROVIDER: 'azure' })).toThrow(
      /Unknown FAULT_SWITCH_PROVIDER/,
    );
  });

  it('builds a secret version name and decodes a payload without a network call', async () => {
    expect(secretVersionResource('otel-demo-spike', 'otel-demo-faults-enabled')).toBe(
      'projects/otel-demo-spike/secrets/otel-demo-faults-enabled/versions/latest',
    );
    expect(secretVersionResource(undefined, 'projects/p/secrets/s/versions/3')).toBe(
      'projects/p/secrets/s/versions/3',
    );
    expect(() => secretVersionResource(undefined, 'otel-demo-faults-enabled')).toThrow(
      /GCP_PROJECT_ID/,
    );

    const calls: { url: string; authorization?: string; flavor?: string }[] = [];
    const fetchImpl: SecretFetch = async (url, init) => {
      calls.push({
        url,
        authorization: init?.headers?.Authorization,
        flavor: init?.headers?.['Metadata-Flavor'],
      });
      if (url.includes('metadata.google.internal')) {
        return jsonResponse({ access_token: 'metadata-test-token' });
      }
      return jsonResponse({
        payload: { data: Buffer.from('on').toString('base64') },
      });
    };
    const client = createSecretManagerClient({ fetch: fetchImpl });
    await expect(
      client.access('projects/otel-demo-spike/secrets/otel-demo-faults-enabled/versions/latest'),
    ).resolves.toBe('on');
    expect(calls[0]?.url).toContain('metadata.google.internal');
    expect(calls[0]?.flavor).toBe('Google');
    expect(calls[1]?.url).toBe(
      'https://secretmanager.googleapis.com/v1/projects/otel-demo-spike/secrets/otel-demo-faults-enabled/versions/latest:access',
    );
    expect(calls[1]?.authorization).toBe('Bearer metadata-test-token');

    const failing = createSecretManagerClient({
      token: async () => 'metadata-test-token',
      fetch: async () => jsonResponse({}, 403),
    });
    await expect(failing.access('projects/p/secrets/s/versions/latest')).rejects.toThrow(/403/);
  });
});

describe('hard stop cron', () => {
  it('turns the default UTC timestamp into a Cloud Scheduler cron', () => {
    expect(hardStopCron('2026-10-14T00:00:00Z')).toBe('0 0 14 10 *');
    expect(hardStopCron('2026-10-14T00:05:00Z')).toBe('5 0 14 10 *');
    expect(() => hardStopCron('2026-10-14T00:00:30Z')).toThrow(/whole minute|real UTC minute/);
    expect(() => hardStopCron('next week')).toThrow(/ISO-8601/);
  });
});

function jsonResponse(
  body: unknown,
  status = 200,
): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}
