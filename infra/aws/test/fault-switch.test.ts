import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { describe, expect, it } from 'vitest';
import {
  createFaultSwitch,
  DEFAULT_FAULT_SWITCH_PARAMETER,
  type SsmParameterClient,
} from '../src/fault-switch.js';

describe('SSM fault switch', () => {
  it('reads the otel-demo parameter and treats a true value as enabled', async () => {
    const names: string[] = [];
    const client: SsmParameterClient = {
      async send(command) {
        names.push(command.input.Name ?? '');
        return { Parameter: { Value: 'true' } };
      },
    };
    const reader = createFaultSwitch({}, client);
    await expect(reader.read()).resolves.toBe(true);
    expect(names).toEqual([DEFAULT_FAULT_SWITCH_PARAMETER]);
    expect(new GetParameterCommand({ Name: DEFAULT_FAULT_SWITCH_PARAMETER }).input.Name).toBe(
      '/otel-demo/faults-enabled',
    );
  });

  it('treats an explicit false value as the operator turning faults off', async () => {
    const reader = createFaultSwitch(
      { FAULT_SWITCH_SSM_PARAMETER: '/otel-demo/faults-enabled' },
      {
        async send() {
          return { Parameter: { Value: 'off' } };
        },
      },
    );
    await expect(reader.read()).resolves.toBe(false);
  });

  it('throws when the parameter cannot be read so the fail-safe can count the miss', async () => {
    const reader = createFaultSwitch(
      {},
      {
        async send() {
          throw new Error('throttled');
        },
      },
    );
    await expect(reader.read()).rejects.toThrow(/throttled/);
  });
});
