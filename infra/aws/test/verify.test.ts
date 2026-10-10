import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { describe, expect, it } from 'vitest';
import { runTeardown } from '../src/teardown.js';
import { verifyAccount } from '../src/verify.js';
import {
  commandNames,
  experimentTag,
  exportEnv,
  fakeAccount,
  fakeArn,
  mockAws,
} from './aws-mock.js';

const REGION = 'eu-central-1';

describe('verify', () => {
  it('uses AWS SDK v3 command classes', () => {
    expect(new DescribeDBInstancesCommand({}).constructor.name).toBe('DescribeDBInstancesCommand');
  });

  it('passes a clean account and ignores bootstrap and unrelated resources', async () => {
    const account = fakeAccount();
    const aws = mockAws(
      {
        cloudformation: {
          ListStacksCommand: () => ({
            StackSummaries: [
              { StackName: 'CDKToolkit', StackStatus: 'CREATE_COMPLETE' },
              { StackName: 'otel-demo-old', StackStatus: 'DELETE_COMPLETE' },
            ],
          }),
        },
        s3: {
          ListBucketsCommand: () => ({
            Buckets: [{ Name: 'other-project' }, { Name: 'cdk-hnb659fds-assets-bucket' }],
          }),
        },
        rds: {
          DescribeDBInstancesCommand: () => ({
            DBInstances: [{ DBInstanceIdentifier: 'other-db' }],
          }),
        },
      },
      { accountId: account },
    );

    const report = await verifyAccount({
      clients: aws.clients,
      region: REGION,
      accountId: account,
    });

    expect(report.ok).toBe(true);
    expect(report.leftovers).toEqual([]);
    const text = report.lines.join('\n');
    expect(text).toMatch(/VERIFY OK: nothing remains/);
    expect(text).toMatch(/WARN: rds-instance other-db/);
    expect(text).toMatch(/does not change the exit code/);
    expect(text.indexOf('VERIFY OK')).toBeLessThan(text.indexOf('WARN:'));
    expect(text).not.toMatch(/other-project/);
    expect(text).not.toMatch(/CDKToolkit/);
    expect(text).not.toContain(account);
    expect(commandNames(aws.calls.s3)).toEqual(['ListBucketsCommand']);
    for (const name of [
      'GetResourcesCommand',
      'DescribeDBInstancesCommand',
      'DescribeDBSnapshotsCommand',
      'DescribeDBInstanceAutomatedBackupsCommand',
      'DescribeDBClusterSnapshotsCommand',
      'DescribeLogGroupsCommand',
      'DescribeNatGatewaysCommand',
      'DescribeAddressesCommand',
      'DescribeNetworkInterfacesCommand',
      'DescribeLoadBalancersCommand',
      'DescribeRepositoriesCommand',
      'ListClustersCommand',
      'ListStacksCommand',
      'ListBucketsCommand',
      'DescribeBudgetsCommand',
      'DescribeSecurityGroupsCommand',
      'ListSecretsCommand',
      'DescribeParametersCommand',
    ]) {
      const all = Object.values(aws.calls).flatMap(commandNames);
      expect(all).toContain(name);
    }
    expect(
      aws.calls.rds.filter((call) => call.name === 'DescribeDBSnapshotsCommand').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('fails when experiment resources remain by name, including types the tagging API misses', async () => {
    const account = fakeAccount();
    const backupArn = fakeArn('rds', REGION, account, 'auto-backup:otel-demo-payment');
    const loadBalancerArn = fakeArn(
      'elasticloadbalancing',
      REGION,
      account,
      'loadbalancer/app/otel-demo-edge/abc',
    );
    const clusterArn = fakeArn('ecs', REGION, account, 'cluster/otel-demo');
    const aws = mockAws(
      {
        rds: {
          DescribeDBInstancesCommand: (input) =>
            input.DBInstanceIdentifier
              ? { DBInstances: [{ DBInstanceIdentifier: input.DBInstanceIdentifier }] }
              : {
                  DBInstances: [
                    { DBInstanceIdentifier: 'otel-demo-shop' },
                    { DBInstanceIdentifier: 'other-db' },
                  ],
                },
          DescribeDBSnapshotsCommand: (input) => {
            if (input.SnapshotType === 'manual') {
              return {
                DBSnapshots: [
                  {
                    DBSnapshotIdentifier: 'otel-demo-shop-snap',
                    DBInstanceIdentifier: 'otel-demo-shop',
                  },
                ],
              };
            }
            return {
              DBSnapshots: [
                {
                  DBSnapshotIdentifier: 'otel-demo-shop-auto',
                  DBInstanceIdentifier: 'otel-demo-shop',
                },
              ],
            };
          },
          DescribeDBInstanceAutomatedBackupsCommand: () => ({
            DBInstanceAutomatedBackups: [
              {
                DBInstanceIdentifier: 'otel-demo-payment',
                DBInstanceAutomatedBackupsArn: backupArn,
              },
            ],
          }),
        },
        logs: {
          DescribeLogGroupsCommand: () => ({
            logGroups: [{ logGroupName: '/otel-demo/shop' }],
          }),
        },
        ec2: {
          DescribeNatGatewaysCommand: () => ({
            NatGateways: [
              {
                NatGatewayId: 'nat-test',
                State: 'available',
                Tags: experimentTag(),
              },
              {
                NatGatewayId: 'nat-gone',
                State: 'deleted',
                Tags: experimentTag(),
              },
            ],
          }),
        },
        elbv2: {
          DescribeLoadBalancersCommand: () => ({
            LoadBalancers: [
              { LoadBalancerName: 'otel-demo-edge', LoadBalancerArn: loadBalancerArn },
            ],
          }),
        },
        elb: {
          DescribeLoadBalancersCommand: () => ({
            LoadBalancerDescriptions: [{ LoadBalancerName: 'otel-demo-classic' }],
          }),
        },
        ecr: {
          DescribeRepositoriesCommand: () => ({
            repositories: [{ repositoryName: 'otel-demo/shop' }],
          }),
        },
        ecs: {
          ListClustersCommand: () => ({ clusterArns: [clusterArn] }),
          DescribeClustersCommand: () => ({
            clusters: [{ clusterName: 'otel-demo', tags: experimentTag() }],
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
        s3: {
          ListBucketsCommand: () => ({
            Buckets: [{ Name: 'otel-demo-artifacts' }, { Name: 'other-project' }],
          }),
          GetBucketLocationCommand: () => ({ LocationConstraint: REGION }),
        },
      },
      { accountId: account },
    );

    const report = await verifyAccount({
      clients: aws.clients,
      region: REGION,
      accountId: account,
    });
    const text = report.lines.join('\n');

    expect(report.ok).toBe(false);
    expect(report.leftovers.map((item) => `${item.kind} ${item.name}`).sort()).toEqual(
      [
        'cloudformation-stack otel-demo-services',
        'ecr-repository otel-demo/shop',
        'ecs-cluster otel-demo',
        'load-balancer otel-demo-classic',
        'load-balancer otel-demo-edge',
        'log-group /otel-demo/shop',
        'nat-gateway nat-test',
        'rds-automated-backup otel-demo-payment',
        'rds-instance otel-demo-shop',
        'rds-snapshot otel-demo-shop-auto',
        'rds-snapshot otel-demo-shop-snap',
        's3-bucket otel-demo-artifacts',
      ].sort(),
    );
    expect(text).not.toContain('CDKToolkit');
    expect(text).toMatch(/WARN: rds-instance other-db/);
    expect(text).not.toContain('other-project');
    expect(text).not.toContain('nat-gone');
    expect(text).not.toContain(account);
    expect(text).not.toContain(backupArn);
  });

  it('follows tagging pagination', async () => {
    const account = fakeAccount();
    let page = 0;
    const aws = mockAws(
      {
        tagging: {
          GetResourcesCommand: () => {
            page += 1;
            if (page === 1) {
              return {
                PaginationToken: 'page-2',
                ResourceTagMappingList: [
                  {
                    ResourceARN: fakeArn('ec2', REGION, account, 'vpc/vpc-one'),
                    Tags: experimentTag(),
                  },
                ],
              };
            }
            return {
              ResourceTagMappingList: [
                {
                  ResourceARN: fakeArn('ec2', REGION, account, 'vpc/vpc-two'),
                  Tags: experimentTag(),
                },
              ],
            };
          },
        },
      },
      { accountId: account },
    );

    const report = await verifyAccount({
      clients: aws.clients,
      region: REGION,
      accountId: account,
    });

    expect(page).toBe(2);
    expect(report.ok).toBe(false);
    expect(report.leftovers.map((item) => item.name).sort()).toEqual([
      'ec2/vpc/vpc-one',
      'ec2/vpc/vpc-two',
    ]);
  });

  it('exits non-zero when a named resource is still present after delete', async () => {
    const account = fakeAccount();
    const aws = mockAws(
      {
        rds: {
          DescribeDBInstancesCommand: () => ({
            DBInstances: [{ DBInstanceIdentifier: 'otel-demo-shop' }],
          }),
        },
      },
      { accountId: account },
    );
    const result = await runTeardown({
      env: exportEnv(),
      region: REGION,
      skipExport: true,
      acknowledgeNoExport: true,
      now: new Date('2026-10-10T00:00:00Z'),
      clients: aws.clients,
      resultsRoot: mkdtempSync(join(tmpdir(), 'otel-demo-results-')),
      waitAttempts: 1,
      waitIntervalMs: 0,
      sleep: async () => undefined,
      loadExpiration: async () => undefined,
    });

    expect(commandNames(aws.calls.rds)).toContain('DeleteDBInstanceCommand');
    expect(result.exitCode).toBe(1);
    expect(result.report).toMatch(/VERIFY FAILED/);
    expect(result.report).toMatch(/rds-instance otel-demo-shop/);
    expect(result.report).not.toContain(account);
  });

  it('fails verify and deletes a Grafana security group, task, secret, and parameter', async () => {
    const account = fakeAccount();
    const clusterArn = fakeArn('ecs', REGION, account, 'cluster/otel-demo');
    const taskArn = fakeArn('ecs', REGION, account, 'task/otel-demo/task-grafana');
    const aws = mockAws(
      {
        ec2: {
          DescribeSecurityGroupsCommand: () => ({
            SecurityGroups: [
              {
                GroupId: 'sg-grafana',
                GroupName: 'otel-demo-grafana',
                Tags: experimentTag(),
              },
            ],
          }),
        },
        ecs: {
          ListClustersCommand: () => ({ clusterArns: [clusterArn] }),
          DescribeClustersCommand: () => ({
            clusters: [{ clusterName: 'otel-demo', tags: experimentTag() }],
          }),
          ListTasksCommand: () => ({ taskArns: [taskArn] }),
          DescribeTasksCommand: () => ({
            tasks: [
              {
                taskArn,
                group: 'service:otel-demo-grafana',
                tags: experimentTag(),
              },
            ],
          }),
        },
        secretsManager: {
          ListSecretsCommand: () => ({
            SecretList: [{ Name: 'otel-demo/grafana-admin', Tags: experimentTag() }],
          }),
        },
        ssm: {
          DescribeParametersCommand: () => ({
            Parameters: [{ Name: '/otel-demo/faults-enabled' }],
          }),
        },
      },
      { accountId: account },
    );

    const report = await verifyAccount({
      clients: aws.clients,
      region: REGION,
      accountId: account,
    });
    expect(report.ok).toBe(false);
    expect(report.leftovers.map((item) => `${item.kind} ${item.name}`)).toEqual(
      expect.arrayContaining([
        'security-group otel-demo-grafana',
        'ecs-task otel-demo-grafana',
        'secret otel-demo/grafana-admin',
        'ssm-parameter /otel-demo/faults-enabled',
      ]),
    );

    const result = await runTeardown({
      env: exportEnv(),
      region: REGION,
      skipExport: true,
      acknowledgeNoExport: true,
      now: new Date('2026-10-10T00:00:00Z'),
      clients: aws.clients,
      resultsRoot: mkdtempSync(join(tmpdir(), 'otel-demo-results-')),
      waitAttempts: 1,
      waitIntervalMs: 0,
      sleep: async () => undefined,
      loadExpiration: async () => undefined,
    });

    expect(result.exitCode).toBe(1);
    expect(result.report).toMatch(/VERIFY FAILED/);
    expect(aws.calls.ec2.some((call) => call.name === 'DeleteSecurityGroupCommand')).toBe(true);
    expect(
      aws.calls.ec2.find((call) => call.name === 'DeleteSecurityGroupCommand')?.input.GroupId,
    ).toBe('sg-grafana');
    const stop = aws.calls.ecs.find((call) => call.name === 'StopTaskCommand');
    expect(stop?.input).toMatchObject({ cluster: 'otel-demo', task: 'task-grafana' });
    expect(
      aws.calls.secretsManager.find((call) => call.name === 'DeleteSecretCommand')?.input,
    ).toMatchObject({
      SecretId: 'otel-demo/grafana-admin',
      ForceDeleteWithoutRecovery: true,
    });
    expect(
      aws.calls.ssm.find((call) => call.name === 'DeleteParameterCommand')?.input,
    ).toMatchObject({ Name: '/otel-demo/faults-enabled' });
    expect(result.report).not.toContain(account);
  });
});
