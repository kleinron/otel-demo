import { randomBytes } from 'node:crypto';
import { CreateLogGroupCommand } from '@aws-sdk/client-cloudwatch-logs';
import {
  CreateBucketCommand,
  PutBucketTaggingCommand,
  type BucketLocationConstraint,
} from '@aws-sdk/client-s3';
import { loadConfig } from './config.js';
import { checkCredentials } from './credentials.js';
import { redactText, safeError } from './redact.js';
import { EXPERIMENT_TAG_KEY, EXPERIMENT_TAG_VALUE } from './tags.js';
import { runTeardown, type TeardownInput, type TeardownResult } from './teardown.js';
import type { TeardownClients } from './types.js';

const TOKEN = /^[a-f0-9]{6}$/;

export interface RehearsalNames {
  bucket: string;
  logGroup: string;
  runId: string;
}

export interface BucketCreateInput {
  Bucket: string;
  CreateBucketConfiguration?: { LocationConstraint: BucketLocationConstraint };
}

export function newRehearsalToken(): string {
  return randomBytes(3).toString('hex');
}

export function rehearsalNames(token: string): RehearsalNames {
  if (!TOKEN.test(token)) {
    throw new Error('rehearsal token must be 6 hex characters');
  }
  return {
    bucket: `otel-demo-rehearsal-${token}`,
    logGroup: `/otel-demo/rehearsal-${token}`,
    runId: `rehearsal-${token}`,
  };
}

/** us-east-1 rejects a location constraint. Every other region requires one. */
export function bucketCreateInput(region: string, bucket: string): BucketCreateInput {
  if (region === 'us-east-1') {
    return { Bucket: bucket };
  }
  return {
    Bucket: bucket,
    CreateBucketConfiguration: { LocationConstraint: region as BucketLocationConstraint },
  };
}

export async function createRehearsalResources(
  clients: TeardownClients,
  region: string,
  names: RehearsalNames,
): Promise<void> {
  await clients.s3.send(new CreateBucketCommand(bucketCreateInput(region, names.bucket)));
  await clients.s3.send(
    new PutBucketTaggingCommand({
      Bucket: names.bucket,
      Tagging: { TagSet: [{ Key: EXPERIMENT_TAG_KEY, Value: EXPERIMENT_TAG_VALUE }] },
    }),
  );
  await clients.logs.send(
    new CreateLogGroupCommand({
      logGroupName: names.logGroup,
      tags: { [EXPERIMENT_TAG_KEY]: EXPERIMENT_TAG_VALUE },
    }),
  );
}

export async function runRehearsal(
  input: Omit<
    TeardownInput,
    'dryRun' | 'skipExport' | 'acknowledgeNoExport' | 'runId' | 'rehearsal'
  > & {
    token?: string;
  },
): Promise<TeardownResult> {
  const now = input.now ?? new Date();
  const config = loadConfig(input.env, {
    region: input.region,
    repoRoot: input.repoRoot,
    resultsRoot: input.resultsRoot,
  });
  const expiration = input.loadExpiration ? await input.loadExpiration() : undefined;
  const check = await checkCredentials({
    sts: input.clients.sts,
    now,
    expiration,
    hardStopUtc: config.hardStopUtc,
  });
  if (!check.ok) {
    return { exitCode: 1, report: redactText(check.lines.join('\n')) };
  }
  const names = rehearsalNames(input.token ?? newRehearsalToken());
  try {
    await createRehearsalResources(input.clients, config.region, names);
  } catch (error) {
    return {
      exitCode: 1,
      report: redactText(
        [
          ...check.lines,
          `Rehearsal: create failed. ${safeError(error)}`,
          'Rehearsal: teardown was not started.',
        ].join('\n'),
      ),
    };
  }
  const teardown = await runTeardown({
    env: input.env,
    region: config.region,
    runId: names.runId,
    now,
    clients: input.clients,
    loadExpiration: input.loadExpiration,
    runProcess: input.runProcess,
    sleep: input.sleep,
    waitAttempts: input.waitAttempts,
    waitIntervalMs: input.waitIntervalMs,
    repoRoot: input.repoRoot,
    resultsRoot: input.resultsRoot,
    cdkAppPresent: input.cdkAppPresent,
    rehearsal: { logGroup: names.logGroup },
  });
  return {
    exitCode: teardown.exitCode,
    report: redactText(
      [
        ...check.lines,
        `Rehearsal: created s3-bucket ${names.bucket} and log-group ${names.logGroup}.`,
        teardown.report,
      ].join('\n'),
    ),
  };
}
