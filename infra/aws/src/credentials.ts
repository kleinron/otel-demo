import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { safeError } from './redact.js';
import { asRecord, asString } from './text.js';
import type { SdkClient } from './types.js';
import { assessHardStopForTeardown, assessSession } from './window.js';

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

export interface Caller {
  accountId: string;
}

export async function getCallerAccount(sts: SdkClient): Promise<Caller> {
  let response: unknown;
  try {
    response = await sts.send(new GetCallerIdentityCommand({}));
  } catch (error) {
    throw new CredentialError(`credentials are not valid: ${safeError(error)}`);
  }
  const accountId = asString(asRecord(response).Account);
  if (!accountId || !/^\d{12}$/.test(accountId)) {
    throw new CredentialError('credentials are not valid');
  }
  return { accountId };
}

export async function readExpiration(env: NodeJS.ProcessEnv): Promise<Date | undefined> {
  const raw = env.AWS_CREDENTIAL_EXPIRATION ?? env.AWS_SESSION_EXPIRATION;
  if (raw && raw.trim() !== '') {
    const parsed = new Date(raw.trim());
    if (Number.isNaN(parsed.getTime())) {
      throw new Error('AWS_CREDENTIAL_EXPIRATION is not a valid timestamp');
    }
    return parsed;
  }
  try {
    const { fromNodeProviderChain } = await import('@aws-sdk/credential-providers');
    const creds = await fromNodeProviderChain()();
    return creds.expiration;
  } catch {
    return undefined;
  }
}

export interface CredentialReport {
  ok: boolean;
  lines: string[];
  accountId?: string;
}

export async function checkCredentials(input: {
  sts: SdkClient;
  now: Date;
  expiration: Date | undefined;
  hardStopUtc: string | undefined;
}): Promise<CredentialReport> {
  const lines: string[] = [];
  let accountId: string | undefined;
  try {
    const caller = await getCallerAccount(input.sts);
    accountId = caller.accountId;
    lines.push('Credentials: valid.');
  } catch (error) {
    lines.push(error instanceof CredentialError ? error.message : safeError(error));
    return { ok: false, lines };
  }
  const session = assessSession(input.expiration, input.now);
  lines.push(session.message);
  const hardStop = assessHardStopForTeardown(input.hardStopUtc, input.now);
  lines.push(hardStop.message);
  return { ok: session.ok && hardStop.ok, lines, accountId };
}
