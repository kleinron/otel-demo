import { DescribeAlarmsCommand, ListDashboardsCommand } from '@aws-sdk/client-cloudwatch';
import {
  DescribeAddressesCommand,
  DescribeInstancesCommand,
  DescribeNatGatewaysCommand,
  DescribeVolumesCommand,
  DescribeVpcEndpointsCommand,
} from '@aws-sdk/client-ec2';
import {
  DescribeServicesCommand,
  ListClustersCommand,
  ListServicesCommand,
  ListTasksCommand,
} from '@aws-sdk/client-ecs';
import { DescribeLoadBalancersCommand as DescribeClassicLoadBalancersCommand } from '@aws-sdk/client-elastic-load-balancing';
import { DescribeLoadBalancersCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  DescribeCacheClustersCommand,
  DescribeReplicationGroupsCommand,
  DescribeServerlessCachesCommand,
} from '@aws-sdk/client-elasticache';
import { DescribeKeyCommand, ListKeysCommand } from '@aws-sdk/client-kms';
import { ListDomainNamesCommand } from '@aws-sdk/client-opensearch';
import {
  DescribeDBClusterSnapshotsCommand,
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  DescribeDBSnapshotsCommand,
} from '@aws-sdk/client-rds';
import { ListSecretsCommand } from '@aws-sdk/client-secrets-manager';
import { collectPages } from './paging.js';
import { safeError, redactText } from './redact.js';
import { RETAINED_BUDGET_NAME } from './tags.js';
import { asArray, asRecord, asString } from './text.js';
import type { SdkClient, SdkCommand, TeardownClients } from './types.js';

export interface RegionFinding {
  kind: string;
  name: string;
}

export interface RegionScan {
  findings: RegionFinding[];
  lines: string[];
}

interface Part {
  findings: RegionFinding[];
  warning?: string;
}

/**
 * Billable resources in the workload region, ignoring tags and names.
 * The retained budget is not part of this scan. Warnings never change verify's exit code.
 */
export async function scanRegion(clients: TeardownClients): Promise<RegionScan> {
  const parts = await Promise.all([
    guard('vpc-endpoint', () => listVpcEndpoints(clients.ec2)),
    guard('secret', () => listSecrets(clients.secretsManager)),
    guard('kms-key', () => listCustomerKeys(clients.kms)),
    guard('cloudwatch-alarm', () => listAlarms(clients.cloudwatch)),
    guard('cloudwatch-dashboard', () => listDashboards(clients.cloudwatch)),
    guard('ecs', () => listRunningEcs(clients.ecs)),
    guard('ec2-instance', () => listInstances(clients.ec2)),
    guard('ebs-volume', () => listVolumes(clients.ec2)),
    guard('elastic-ip', () => listAddresses(clients.ec2)),
    guard('nat-gateway', () => listNatGateways(clients.ec2)),
    guard('load-balancer', () => listLoadBalancers(clients.elbv2, clients.elb)),
    guard('rds', () => listRds(clients.rds)),
    guard('elasticache', () => listElastiCache(clients.elasticache)),
    guard('opensearch-domain', () => listDomains(clients.opensearch)),
  ]);
  const findings = parts.flatMap((part) => part.findings);
  const warnings = parts.flatMap((part) => (part.warning ? [part.warning] : []));
  return { findings, lines: formatRegionScan(findings, warnings) };
}

export function formatRegionScan(
  findings: readonly RegionFinding[],
  warnings: readonly string[],
): string[] {
  const visible = findings.filter(
    (finding) => !(finding.kind === 'budget' && finding.name === RETAINED_BUDGET_NAME),
  );
  const lines = [...warnings];
  if (visible.length === 0) {
    if (warnings.length === 0) {
      lines.push('Region scan: no extra billable resources in this region.');
    }
    return lines;
  }
  lines.push(
    `WARN: region scan found ${visible.length} billable resource(s) regardless of tag or name. This does not change the exit code.`,
  );
  for (const finding of visible) {
    lines.push(`WARN: ${finding.kind} ${finding.name}`);
  }
  return lines;
}

async function guard(kind: string, run: () => Promise<RegionFinding[]>): Promise<Part> {
  try {
    return { findings: await run() };
  } catch (error) {
    return {
      findings: [],
      warning: `WARN: region scan could not list ${kind}: ${safeError(error)}`,
    };
  }
}

async function items(
  client: SdkClient,
  make: (token: string | undefined) => SdkCommand,
  listKey: string,
  tokenKey: string,
): Promise<unknown[]> {
  return collectPages(client, make, (page) => ({
    items: asArray(page[listKey]),
    token: asString(page[tokenKey]),
  }));
}

function add(findings: RegionFinding[], kind: string, name: string | undefined): void {
  const label = safeLabel(name);
  if (label) {
    findings.push({ kind, name: label });
  }
}

function safeLabel(value: string | undefined): string | undefined {
  if (!value || value.includes('arn:')) {
    return undefined;
  }
  const redacted = redactText(value);
  return redacted === value ? value : undefined;
}

function tail(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const slash = value.lastIndexOf('/');
  const colon = value.lastIndexOf(':');
  const cut = Math.max(slash, colon);
  return safeLabel(cut >= 0 ? value.slice(cut + 1) : value);
}

function textState(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.toLowerCase();
  }
  return asString(asRecord(value).Name)?.toLowerCase();
}

async function listVpcEndpoints(client: SdkClient): Promise<RegionFinding[]> {
  const endpoints = await items(
    client,
    (token) => new DescribeVpcEndpointsCommand({ NextToken: token, MaxResults: 100 }),
    'VpcEndpoints',
    'NextToken',
  );
  const findings: RegionFinding[] = [];
  for (const item of endpoints) {
    const record = asRecord(item);
    if (textState(record.State) === 'deleted') {
      continue;
    }
    add(findings, 'vpc-endpoint', asString(record.VpcEndpointId));
  }
  return findings;
}

async function listSecrets(client: SdkClient): Promise<RegionFinding[]> {
  const secrets = await items(
    client,
    (token) =>
      new ListSecretsCommand({ NextToken: token, MaxResults: 100, IncludePlannedDeletion: true }),
    'SecretList',
    'NextToken',
  );
  const findings: RegionFinding[] = [];
  for (const item of secrets) {
    add(findings, 'secret', asString(asRecord(item).Name));
  }
  return findings;
}

async function listCustomerKeys(client: SdkClient): Promise<RegionFinding[]> {
  const keys = await collectPages(
    client,
    (token) => new ListKeysCommand({ Marker: token, Limit: 100 }),
    (page) => ({
      items: asArray(page.Keys),
      token: page.Truncated === true ? asString(page.NextMarker) : undefined,
    }),
  );
  const findings: RegionFinding[] = [];
  for (const item of keys) {
    const listed = asRecord(item);
    const keyId = asString(listed.KeyId) ?? asString(listed.KeyArn);
    if (!keyId) {
      continue;
    }
    const described = asRecord(await client.send(new DescribeKeyCommand({ KeyId: keyId })));
    const meta = asRecord(described.KeyMetadata);
    if (asString(meta.KeyManager) !== 'CUSTOMER') {
      continue;
    }
    add(findings, 'kms-key', asString(meta.KeyId) ?? tail(keyId));
  }
  return findings;
}

async function listAlarms(client: SdkClient): Promise<RegionFinding[]> {
  const alarms = await collectPages(
    client,
    (token) => new DescribeAlarmsCommand({ NextToken: token, MaxRecords: 100 }),
    (page) => ({
      items: [...asArray(page.MetricAlarms), ...asArray(page.CompositeAlarms)],
      token: asString(page.NextToken),
    }),
  );
  const findings: RegionFinding[] = [];
  for (const item of alarms) {
    add(findings, 'cloudwatch-alarm', asString(asRecord(item).AlarmName));
  }
  return findings;
}

async function listDashboards(client: SdkClient): Promise<RegionFinding[]> {
  const dashboards = await items(
    client,
    (token) => new ListDashboardsCommand({ NextToken: token }),
    'DashboardEntries',
    'NextToken',
  );
  const findings: RegionFinding[] = [];
  for (const item of dashboards) {
    add(findings, 'cloudwatch-dashboard', asString(asRecord(item).DashboardName));
  }
  return findings;
}

async function listRunningEcs(client: SdkClient): Promise<RegionFinding[]> {
  const clusters = await items(
    client,
    (token) => new ListClustersCommand({ nextToken: token, maxResults: 100 }),
    'clusterArns',
    'nextToken',
  );
  const findings: RegionFinding[] = [];
  for (const cluster of clusters) {
    if (typeof cluster !== 'string') {
      continue;
    }
    const clusterName = tail(cluster);
    if (!clusterName) {
      continue;
    }
    findings.push(...(await listEcsServices(client, clusterName)));
    findings.push(...(await listEcsTasks(client, clusterName)));
  }
  return findings;
}

async function listEcsServices(client: SdkClient, cluster: string): Promise<RegionFinding[]> {
  const serviceArns = await items(
    client,
    (token) => new ListServicesCommand({ cluster, nextToken: token, maxResults: 100 }),
    'serviceArns',
    'nextToken',
  );
  const names = serviceArns.filter((item): item is string => typeof item === 'string');
  const findings: RegionFinding[] = [];
  for (let index = 0; index < names.length; index += 10) {
    const services = names.slice(index, index + 10);
    const page = asRecord(await client.send(new DescribeServicesCommand({ cluster, services })));
    for (const item of asArray(page.services)) {
      const record = asRecord(item);
      const running = count(record.runningCount);
      const desired = count(record.desiredCount);
      if (running <= 0 && desired <= 0) {
        continue;
      }
      add(findings, 'ecs-service', asString(record.serviceName));
    }
  }
  return findings;
}

async function listEcsTasks(client: SdkClient, cluster: string): Promise<RegionFinding[]> {
  const tasks = await items(
    client,
    (token) =>
      new ListTasksCommand({
        cluster,
        desiredStatus: 'RUNNING',
        nextToken: token,
        maxResults: 100,
      }),
    'taskArns',
    'nextToken',
  );
  const findings: RegionFinding[] = [];
  for (const task of tasks) {
    if (typeof task === 'string') {
      add(findings, 'ecs-task', tail(task));
    }
  }
  return findings;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

async function listInstances(client: SdkClient): Promise<RegionFinding[]> {
  const reservations = await items(
    client,
    (token) => new DescribeInstancesCommand({ NextToken: token, MaxResults: 100 }),
    'Reservations',
    'NextToken',
  );
  const findings: RegionFinding[] = [];
  for (const reservation of reservations) {
    for (const instance of asArray(asRecord(reservation).Instances)) {
      const record = asRecord(instance);
      if (textState(record.State) === 'terminated') {
        continue;
      }
      add(findings, 'ec2-instance', asString(record.InstanceId));
    }
  }
  return findings;
}

async function listVolumes(client: SdkClient): Promise<RegionFinding[]> {
  const volumes = await items(
    client,
    (token) => new DescribeVolumesCommand({ NextToken: token, MaxResults: 100 }),
    'Volumes',
    'NextToken',
  );
  const findings: RegionFinding[] = [];
  for (const item of volumes) {
    const record = asRecord(item);
    const state = textState(record.State);
    if (state === 'deleting' || state === 'deleted') {
      continue;
    }
    add(findings, 'ebs-volume', asString(record.VolumeId));
  }
  return findings;
}

async function listAddresses(client: SdkClient): Promise<RegionFinding[]> {
  const addresses = asArray(
    asRecord(await client.send(new DescribeAddressesCommand({}))).Addresses,
  );
  const findings: RegionFinding[] = [];
  for (const item of addresses) {
    add(findings, 'elastic-ip', asString(asRecord(item).AllocationId));
  }
  return findings;
}

async function listNatGateways(client: SdkClient): Promise<RegionFinding[]> {
  const gateways = await items(
    client,
    (token) => new DescribeNatGatewaysCommand({ NextToken: token, MaxResults: 100 }),
    'NatGateways',
    'NextToken',
  );
  const findings: RegionFinding[] = [];
  for (const item of gateways) {
    const record = asRecord(item);
    if (textState(record.State) === 'deleted') {
      continue;
    }
    add(findings, 'nat-gateway', asString(record.NatGatewayId));
  }
  return findings;
}

async function listLoadBalancers(elbv2: SdkClient, elb: SdkClient): Promise<RegionFinding[]> {
  const modern = await items(
    elbv2,
    (token) => new DescribeLoadBalancersCommand({ Marker: token, PageSize: 100 }),
    'LoadBalancers',
    'NextMarker',
  );
  const classic = await items(
    elb,
    (token) => new DescribeClassicLoadBalancersCommand({ Marker: token, PageSize: 100 }),
    'LoadBalancerDescriptions',
    'NextMarker',
  );
  const findings: RegionFinding[] = [];
  for (const item of modern) {
    add(findings, 'load-balancer', asString(asRecord(item).LoadBalancerName));
  }
  for (const item of classic) {
    add(findings, 'load-balancer', asString(asRecord(item).LoadBalancerName));
  }
  return findings;
}

async function listRds(client: SdkClient): Promise<RegionFinding[]> {
  const findings: RegionFinding[] = [];
  const instances = await items(
    client,
    (token) => new DescribeDBInstancesCommand({ Marker: token, MaxRecords: 100 }),
    'DBInstances',
    'Marker',
  );
  for (const item of instances) {
    add(findings, 'rds-instance', asString(asRecord(item).DBInstanceIdentifier));
  }
  const clusters = await items(
    client,
    (token) => new DescribeDBClustersCommand({ Marker: token, MaxRecords: 100 }),
    'DBClusters',
    'Marker',
  );
  for (const item of clusters) {
    add(findings, 'rds-cluster', asString(asRecord(item).DBClusterIdentifier));
  }
  const snapshots = await items(
    client,
    (token) => new DescribeDBSnapshotsCommand({ Marker: token, MaxRecords: 100 }),
    'DBSnapshots',
    'Marker',
  );
  for (const item of snapshots) {
    add(findings, 'rds-snapshot', asString(asRecord(item).DBSnapshotIdentifier));
  }
  const clusterSnapshots = await items(
    client,
    (token) => new DescribeDBClusterSnapshotsCommand({ Marker: token, MaxRecords: 100 }),
    'DBClusterSnapshots',
    'Marker',
  );
  for (const item of clusterSnapshots) {
    add(findings, 'rds-cluster-snapshot', asString(asRecord(item).DBClusterSnapshotIdentifier));
  }
  return findings;
}

async function listElastiCache(client: SdkClient): Promise<RegionFinding[]> {
  const findings: RegionFinding[] = [];
  const clusters = await items(
    client,
    (token) => new DescribeCacheClustersCommand({ Marker: token, MaxRecords: 100 }),
    'CacheClusters',
    'Marker',
  );
  for (const item of clusters) {
    add(findings, 'elasticache', asString(asRecord(item).CacheClusterId));
  }
  const groups = await items(
    client,
    (token) => new DescribeReplicationGroupsCommand({ Marker: token, MaxRecords: 100 }),
    'ReplicationGroups',
    'Marker',
  );
  for (const item of groups) {
    add(findings, 'elasticache', asString(asRecord(item).ReplicationGroupId));
  }
  const serverless = await items(
    client,
    (token) => new DescribeServerlessCachesCommand({ NextToken: token, MaxResults: 50 }),
    'ServerlessCaches',
    'NextToken',
  );
  for (const item of serverless) {
    add(findings, 'elasticache', asString(asRecord(item).ServerlessCacheName));
  }
  return findings;
}

async function listDomains(client: SdkClient): Promise<RegionFinding[]> {
  const page = asRecord(await client.send(new ListDomainNamesCommand({})));
  const findings: RegionFinding[] = [];
  for (const item of asArray(page.DomainNames)) {
    add(findings, 'opensearch-domain', asString(asRecord(item).DomainName));
  }
  return findings;
}
