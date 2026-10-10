import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTeardown } from '../src/teardown.js';
import {
  commandNames,
  experimentTag,
  exportEnv,
  fakeAccount,
  fakeArn,
  mockAws,
} from './aws-mock.js';

const REGION = 'eu-central-1';
const NOW = new Date('2026-10-10T00:00:00.000Z');

function input(
  aws: ReturnType<typeof mockAws>,
  extra: Partial<Parameters<typeof runTeardown>[0]> = {},
) {
  return {
    env: exportEnv(),
    region: REGION,
    now: NOW,
    clients: aws.clients,
    resultsRoot: mkdtempSync(join(tmpdir(), 'otel-demo-results-')),
    waitAttempts: 1,
    waitIntervalMs: 0,
    sleep: async () => undefined,
    loadExpiration: async () => undefined,
    runProcess: async () => {
      throw new Error('cdk should not run');
    },
    ...extra,
  };
}

describe('dry-run', () => {
  it('lists leftovers and does not call delete or destroy', async () => {
    const account = fakeAccount();
    const aws = mockAws(
      {
        rds: {
          DescribeDBInstancesCommand: () => ({
            DBInstances: [{ DBInstanceIdentifier: 'otel-demo-shop' }],
          }),
        },
        logs: {
          DescribeLogGroupsCommand: () => ({
            logGroups: [{ logGroupName: '/otel-demo/shop' }],
          }),
        },
        cloudformation: {
          ListStacksCommand: () => ({
            StackSummaries: [
              { StackName: 'otel-demo-services', StackStatus: 'CREATE_COMPLETE' },
              { StackName: 'CDKToolkit', StackStatus: 'CREATE_COMPLETE' },
            ],
          }),
        },
        tagging: {
          GetResourcesCommand: () => ({
            ResourceTagMappingList: [
              {
                ResourceARN: fakeArn('logs', REGION, account, 'log-group:/aws/lambda/custom'),
                Tags: experimentTag(),
              },
            ],
          }),
        },
      },
      { accountId: account, rejectMutations: true },
    );

    const result = await runTeardown(input(aws, { dryRun: true }));
    const mutations = Object.values(aws.calls)
      .flatMap(commandNames)
      .filter((name) => /^(Delete|Release|Abort|Terminate)/.test(name));

    expect(result.exitCode).toBe(0);
    expect(result.report).toMatch(/dry-run/);
    expect(result.report).toMatch(/otel-demo-shop/);
    expect(result.report).toMatch(/otel-demo-services/);
    expect(result.report).toMatch(/\/aws\/lambda\/custom/);
    expect(result.report).not.toMatch(/CDKToolkit/);
    expect(mutations).toEqual([]);
    expect(result.report).not.toContain(account);
  });

  it('stops before listing resources when credentials are not valid', async () => {
    const aws = mockAws(
      {
        sts: {
          GetCallerIdentityCommand: () => {
            throw new Error('denied');
          },
        },
      },
      { rejectMutations: true },
    );
    const result = await runTeardown(input(aws, { dryRun: true }));
    expect(result.exitCode).toBe(1);
    expect(result.report).toMatch(/credentials are not valid/);
    expect(aws.calls.tagging).toHaveLength(0);
    expect(aws.calls.rds).toHaveLength(0);
  });

  it('stops when the session expires inside 15 minutes', async () => {
    const aws = mockAws({}, { rejectMutations: true });
    const result = await runTeardown(
      input(aws, {
        dryRun: true,
        loadExpiration: async () => new Date(NOW.getTime() + 5 * 60 * 1000),
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.report).toMatch(/15 minute/);
    expect(aws.calls.tagging).toHaveLength(0);
  });

  it('does not invoke cdk destroy while printing the stack it would destroy', async () => {
    let ran = false;
    const aws = mockAws({
      cloudformation: {
        ListStacksCommand: () => ({
          StackSummaries: [{ StackName: 'otel-demo-services', StackStatus: 'CREATE_COMPLETE' }],
        }),
      },
    });
    const result = await runTeardown(
      input(aws, {
        dryRun: true,
        cdkAppPresent: true,
        runProcess: async () => {
          ran = true;
          return 0;
        },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(ran).toBe(false);
    expect(result.report).toMatch(/dry-run would destroy otel-demo-services/);
    expect(commandNames(aws.calls.cloudformation)).not.toContain('DeleteStackCommand');
  });
});
