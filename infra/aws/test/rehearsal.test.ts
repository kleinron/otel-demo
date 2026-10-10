import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli.js';
import {
  bucketCreateInput,
  newRehearsalToken,
  rehearsalNames,
  runRehearsal,
} from '../src/rehearsal.js';
import { commandNames, exportEnv, mockAws } from './aws-mock.js';

const REGION = 'eu-central-1';
const TOKEN = 'abc123';
const NOW = new Date('2026-10-10T00:00:00.000Z');

function harness(options: { remain?: boolean; failCreate?: boolean } = {}) {
  const names = rehearsalNames(TOKEN);
  let bucket = false;
  let logGroup = false;
  const aws = mockAws({
    s3: {
      CreateBucketCommand: () => {
        if (options.failCreate) {
          throw new Error('bucket create failed');
        }
        bucket = true;
        return {};
      },
      PutBucketTaggingCommand: () => ({}),
      ListBucketsCommand: () => ({
        Buckets: bucket ? [{ Name: names.bucket }] : [],
      }),
      GetBucketLocationCommand: () => ({ LocationConstraint: REGION }),
      ListObjectVersionsCommand: () => ({ Versions: [], DeleteMarkers: [] }),
      ListMultipartUploadsCommand: () => ({ Uploads: [] }),
      DeleteBucketCommand: () => {
        if (!options.remain) {
          bucket = false;
        }
        return {};
      },
    },
    logs: {
      CreateLogGroupCommand: () => {
        logGroup = true;
        return {};
      },
      DescribeLogGroupsCommand: () => ({
        logGroups: logGroup ? [{ logGroupName: names.logGroup }] : [],
      }),
      FilterLogEventsCommand: () => ({ events: [] }),
      DeleteLogGroupCommand: () => {
        if (!options.remain) {
          logGroup = false;
        }
        return {};
      },
    },
  });
  return { aws, names };
}

function rehearsalInput(aws: ReturnType<typeof mockAws>, resultsRoot: string) {
  return {
    env: exportEnv({ EXPERIMENT_RUN_ID: undefined }),
    region: REGION,
    now: NOW,
    token: TOKEN,
    clients: aws.clients,
    resultsRoot,
    waitAttempts: 1,
    waitIntervalMs: 0,
    sleep: async () => undefined,
    loadExpiration: async () => undefined,
    runProcess: async () => {
      throw new Error('cdk should not run');
    },
  };
}

describe('teardown rehearsal', () => {
  it('builds a location constraint only outside us-east-1', () => {
    const names = rehearsalNames(TOKEN);
    expect(bucketCreateInput('us-east-1', names.bucket)).toEqual({ Bucket: names.bucket });
    expect(bucketCreateInput(REGION, names.bucket)).toEqual({
      Bucket: names.bucket,
      CreateBucketConfiguration: { LocationConstraint: REGION },
    });
    expect(newRehearsalToken()).toMatch(/^[a-f0-9]{6}$/);
    expect(parseArgs(['--skip-export', '--i-understand-no-export'], 'teardown')).toMatchObject({
      skipExport: true,
      acknowledgeNoExport: true,
    });
    expect(() => parseArgs(['--skip-export'], 'rehearsal')).toThrow(/teardown:rehearsal/);
  });

  it('creates tagged resources, tears them down, and passes verify', async () => {
    const { aws, names } = harness();
    const resultsRoot = mkdtempSync(join(tmpdir(), 'otel-demo-results-'));
    const result = await runRehearsal(rehearsalInput(aws, resultsRoot));
    const directory = join(resultsRoot, names.runId);
    const record = JSON.parse(readFileSync(join(directory, 'run-record.json'), 'utf8')) as {
      loadProfile: string;
    };
    const marker = JSON.parse(readFileSync(join(directory, 'EXPORT_OK'), 'utf8')) as {
      files: string[];
    };
    const create = aws.calls.s3.find((call) => call.name === 'CreateBucketCommand');
    const tagging = aws.calls.s3.find((call) => call.name === 'PutBucketTaggingCommand');
    const log = aws.calls.logs.find((call) => call.name === 'CreateLogGroupCommand');

    expect(result.exitCode).toBe(0);
    expect(result.report).toMatch(/VERIFY OK/);
    expect(result.report).toMatch(new RegExp(names.bucket));
    expect(result.report).toMatch(/EXPORT_OK rehearsal/);
    expect(record.loadProfile).toBe('rehearsal');
    expect(marker.files.length).toBeGreaterThan(0);
    for (const file of marker.files) {
      expect(readFileSync(join(directory, file), 'utf8').length).toBeGreaterThan(0);
    }
    expect(create?.input).toMatchObject({
      Bucket: names.bucket,
      CreateBucketConfiguration: { LocationConstraint: REGION },
    });
    expect(tagging?.input).toMatchObject({
      Tagging: { TagSet: [{ Key: 'experiment', Value: 'otel-demo' }] },
    });
    expect(log?.input).toMatchObject({
      logGroupName: names.logGroup,
      tags: { experiment: 'otel-demo' },
    });
    expect(commandNames(aws.calls.s3)).toContain('DeleteBucketCommand');
    expect(commandNames(aws.calls.logs)).toContain('DeleteLogGroupCommand');
    expect(existsSync(join(directory, 'EXPORT_MISSING'))).toBe(false);
  });

  it('fails when a rehearsal resource is still present', async () => {
    const { aws, names } = harness({ remain: true });
    const result = await runRehearsal(
      rehearsalInput(aws, mkdtempSync(join(tmpdir(), 'otel-demo-results-'))),
    );
    expect(result.exitCode).toBe(1);
    expect(result.report).toMatch(/VERIFY FAILED/);
    expect(result.report).toMatch(new RegExp(names.bucket));
    expect(result.report).toMatch(new RegExp(names.logGroup.replace('/', '\\/')));
  });

  it('does not start teardown when create fails', async () => {
    const { aws } = harness({ failCreate: true });
    const result = await runRehearsal(
      rehearsalInput(aws, mkdtempSync(join(tmpdir(), 'otel-demo-results-'))),
    );
    expect(result.exitCode).toBe(1);
    expect(result.report).toMatch(/create failed/);
    expect(result.report).toMatch(/teardown was not started/);
    expect(commandNames(aws.calls.s3)).not.toContain('DeleteBucketCommand');
    expect(commandNames(aws.calls.logs)).not.toContain('DeleteLogGroupCommand');
    expect(commandNames(aws.calls.logs)).not.toContain('CreateLogGroupCommand');
  });

  it('does not create resources when credentials are not valid', async () => {
    const { aws } = harness();
    aws.clients.sts = {
      async send() {
        throw new Error('denied');
      },
    };
    const result = await runRehearsal(
      rehearsalInput(aws, mkdtempSync(join(tmpdir(), 'otel-demo-results-'))),
    );
    expect(result.exitCode).toBe(1);
    expect(result.report).toMatch(/credentials are not valid/);
    expect(commandNames(aws.calls.s3)).not.toContain('CreateBucketCommand');
  });
});
