import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

/** Kill switch read by services when FAULT_SWITCH_MODULE points at this file. */
export const DEFAULT_FAULT_SWITCH_PARAMETER = '/otel-demo/faults-enabled';

export interface FaultSwitchReader {
  read(): Promise<boolean>;
}

export interface SsmParameterClient {
  send(command: GetParameterCommand): Promise<{ Parameter?: { Value?: string } }>;
}

/**
 * Poll SSM for the fault kill switch. Application services load this module
 * only when FAULT_SWITCH_SOURCE=module. They do not import the AWS SDK themselves.
 */
export function createFaultSwitch(
  env: Record<string, string | undefined> = process.env,
  client?: SsmParameterClient,
): FaultSwitchReader {
  const parameterName = env.FAULT_SWITCH_SSM_PARAMETER?.trim() || DEFAULT_FAULT_SWITCH_PARAMETER;
  let cached = client;
  return {
    async read() {
      const sender = cached ?? (cached = createClient(env));
      const response = await sender.send(new GetParameterCommand({ Name: parameterName }));
      const value = response.Parameter?.Value;
      if (value === undefined || value.trim() === '') {
        throw new Error('ssm parameter has no value');
      }
      return parseSwitch(value);
    },
  };
}

function createClient(env: Record<string, string | undefined>): SsmParameterClient {
  const region = env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim();
  if (!region) {
    throw new Error('AWS region is not set');
  }
  return new SSMClient({ region });
}

function parseSwitch(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'off') {
    return false;
  }
  throw new Error('fault switch value is unreadable');
}
