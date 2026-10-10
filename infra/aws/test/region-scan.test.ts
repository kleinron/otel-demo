import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatRegionScan, scanRegion } from '../src/region-scan.js';
import { runTeardown } from '../src/teardown.js';
import { verifyAccount } from '../src/verify.js';
import { RETAINED_BUDGET_NAME } from '../src/tags.js';
import { commandNames, exportEnv, fakeAccount, fakeArn, mockAws } from './aws-mock.js';

const REGION = 'eu-central-1';

describe('region scan', () => {
  it('ignores the retained budget and still warns about another resource with that name', () => {
    const lines = formatRegionScan(
      [
        { kind: 'budget', name: RETAINED_BUDGET_NAME },
        { kind: 'cloudwatch-dashboard', name: RETAINED_BUDGET_NAME },
      ],
      [],
    ).join('\n');
    expect(lines).not.toMatch(/WARN: budget /);
    expect(lines).toMatch(/WARN: cloudwatch-dashboard otel-demo-experiment/);
    expect(lines).toMatch(/does not change the exit code/);
  });

  it('warns about billable resources and skips ones that are already gone', async () => {
    const account = fakeAccount();
    const publicIp = ['203', '0', '113', '10'].join('.');
    const cluster = fakeArn('ecs', REGION, account, 'cluster/demo');
    const task = fakeArn('ecs', REGION, account, 'task/demo/task-1');
    let secretPage = 0;
    const aws = mockAws(
      {
        ec2: {
          DescribeVpcEndpointsCommand: () => ({
            VpcEndpoints: [
              { VpcEndpointId: 'vpce-1', State: 'available' },
              { VpcEndpointId: 'vpce-gone', State: 'deleted' },
            ],
          }),
          DescribeInstancesCommand: () => ({
            Reservations: [
              {
                Instances: [
                  { InstanceId: 'i-running', State: { Name: 'running' } },
                  { InstanceId: 'i-stopped', State: { Name: 'stopped' } },
                  { InstanceId: 'i-dead', State: { Name: 'terminated' } },
                ],
              },
            ],
          }),
          DescribeVolumesCommand: () => ({
            Volumes: [
              { VolumeId: 'vol-1', State: 'available' },
              { VolumeId: 'vol-gone', State: 'deleting' },
            ],
          }),
          DescribeAddressesCommand: () => ({
            Addresses: [{ AllocationId: 'eipalloc-1', PublicIp: publicIp }],
          }),
          DescribeNatGatewaysCommand: () => ({
            NatGateways: [
              { NatGatewayId: 'nat-1', State: 'available' },
              { NatGatewayId: 'nat-deleted', State: 'deleted' },
            ],
          }),
        },
        secretsManager: {
          ListSecretsCommand: () => {
            secretPage += 1;
            if (secretPage === 1) {
              return { SecretList: [{ Name: 'first-secret' }], NextToken: 'more' };
            }
            return { SecretList: [{ Name: 'second-secret' }] };
          },
        },
        kms: {
          ListKeysCommand: () => ({
            Keys: [{ KeyId: 'customer-key' }, { KeyId: 'aws-key' }],
            Truncated: false,
          }),
          DescribeKeyCommand: (input) => ({
            KeyMetadata: {
              KeyId: input.KeyId,
              KeyManager: input.KeyId === 'customer-key' ? 'CUSTOMER' : 'AWS',
            },
          }),
        },
        cloudwatch: {
          DescribeAlarmsCommand: () => ({
            MetricAlarms: [{ AlarmName: 'cpu-high' }],
            CompositeAlarms: [{ AlarmName: 'rolled-up' }],
          }),
          ListDashboardsCommand: () => ({
            DashboardEntries: [{ DashboardName: RETAINED_BUDGET_NAME }],
          }),
        },
        ecs: {
          ListClustersCommand: () => ({ clusterArns: [cluster, 'empty-cluster'] }),
          ListServicesCommand: (input) =>
            input.cluster === 'empty-cluster'
              ? { serviceArns: [] }
              : { serviceArns: ['shop', 'idle'] },
          DescribeServicesCommand: () => ({
            services: [
              { serviceName: 'shop', runningCount: 0, desiredCount: 2 },
              { serviceName: 'idle', runningCount: 0, desiredCount: 0 },
            ],
          }),
          ListTasksCommand: (input) =>
            input.cluster === 'empty-cluster' ? { taskArns: [] } : { taskArns: [task] },
        },
        elbv2: {
          DescribeLoadBalancersCommand: () => ({
            LoadBalancers: [{ LoadBalancerName: 'edge' }],
          }),
        },
        elb: {
          DescribeLoadBalancersCommand: () => ({
            LoadBalancerDescriptions: [{ LoadBalancerName: 'classic-edge' }],
          }),
        },
        rds: {
          DescribeDBInstancesCommand: () => ({
            DBInstances: [{ DBInstanceIdentifier: 'shop-db' }],
          }),
          DescribeDBClustersCommand: () => ({
            DBClusters: [{ DBClusterIdentifier: 'shop-cluster' }],
          }),
          DescribeDBSnapshotsCommand: () => ({
            DBSnapshots: [{ DBSnapshotIdentifier: 'shop-snap' }],
          }),
          DescribeDBClusterSnapshotsCommand: () => ({
            DBClusterSnapshots: [{ DBClusterSnapshotIdentifier: 'shop-cluster-snap' }],
          }),
        },
        elasticache: {
          DescribeCacheClustersCommand: () => ({
            CacheClusters: [{ CacheClusterId: 'cache-1' }],
          }),
          DescribeReplicationGroupsCommand: () => ({
            ReplicationGroups: [{ ReplicationGroupId: 'rep-1' }],
          }),
          DescribeServerlessCachesCommand: () => ({
            ServerlessCaches: [{ ServerlessCacheName: 'serverless-1' }],
          }),
        },
        opensearch: {
          ListDomainNamesCommand: () => ({
            DomainNames: [{ DomainName: 'logs-domain' }],
          }),
        },
      },
      { accountId: account },
    );

    const scan = await scanRegion(aws.clients);
    const text = scan.lines.join('\n');

    expect(secretPage).toBe(2);
    expect(scan.findings.map((finding) => `${finding.kind} ${finding.name}`)).toEqual([
      'vpc-endpoint vpce-1',
      'secret first-secret',
      'secret second-secret',
      'kms-key customer-key',
      'cloudwatch-alarm cpu-high',
      'cloudwatch-alarm rolled-up',
      'cloudwatch-dashboard otel-demo-experiment',
      'ecs-service shop',
      'ecs-task task-1',
      'ec2-instance i-running',
      'ec2-instance i-stopped',
      'ebs-volume vol-1',
      'elastic-ip eipalloc-1',
      'nat-gateway nat-1',
      'load-balancer edge',
      'load-balancer classic-edge',
      'rds-instance shop-db',
      'rds-cluster shop-cluster',
      'rds-snapshot shop-snap',
      'rds-cluster-snapshot shop-cluster-snap',
      'elasticache cache-1',
      'elasticache rep-1',
      'elasticache serverless-1',
      'opensearch-domain logs-domain',
    ]);
    expect(text).toMatch(/WARN: region scan found 24 billable resource/);
    expect(text).not.toMatch(/vpce-gone|i-dead|vol-gone|nat-deleted|idle|aws-key/);
    expect(text).not.toContain(account);
    expect(text).not.toContain(publicIp);
    expect(text).not.toContain(task);
    expect(commandNames(aws.calls.s3)).toEqual([]);
  });

  it('does not change verify success when a list fails or an unrelated instance exists', async () => {
    const account = fakeAccount();
    const aws = mockAws(
      {
        kms: {
          ListKeysCommand: () => {
            throw new Error('access denied');
          },
        },
        ec2: {
          DescribeInstancesCommand: () => ({
            Reservations: [{ Instances: [{ InstanceId: 'i-live', State: { Name: 'running' } }] }],
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
    const text = report.lines.join('\n');
    expect(report.ok).toBe(true);
    expect(report.leftovers).toEqual([]);
    expect(text).toMatch(/VERIFY OK/);
    expect(text).toMatch(/WARN: region scan could not list kms-key: access denied/);
    expect(text).toMatch(/WARN: ec2-instance i-live/);
    expect(text.indexOf('VERIFY OK')).toBeLessThan(text.indexOf('WARN:'));

    const teardown = await runTeardown({
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
    expect(teardown.exitCode).toBe(0);
    expect(teardown.report).toMatch(/WARN: ec2-instance i-live/);
    expect(teardown.report).toMatch(/VERIFY OK/);
  });
});
