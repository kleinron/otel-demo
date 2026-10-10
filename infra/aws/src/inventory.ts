import { DescribeBudgetsCommand } from '@aws-sdk/client-budgets';
import { ListStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  DescribeAddressesCommand,
  DescribeNatGatewaysCommand,
  DescribeNetworkInterfacesCommand,
  DescribeSecurityGroupsCommand,
} from '@aws-sdk/client-ec2';
import { DescribeRepositoriesCommand } from '@aws-sdk/client-ecr';
import {
  DescribeClustersCommand,
  DescribeTasksCommand,
  ListClustersCommand,
  ListTasksCommand,
} from '@aws-sdk/client-ecs';
import {
  DescribeLoadBalancersCommand as DescribeClassicLoadBalancersCommand,
  DescribeTagsCommand as DescribeClassicTagsCommand,
} from '@aws-sdk/client-elastic-load-balancing';
import {
  DescribeLoadBalancersCommand,
  DescribeTagsCommand,
  DescribeTargetGroupsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import {
  DescribeDBClusterSnapshotsCommand,
  DescribeDBInstanceAutomatedBackupsCommand,
  DescribeDBInstancesCommand,
  DescribeDBSnapshotsCommand,
} from '@aws-sdk/client-rds';
import { GetResourcesCommand } from '@aws-sdk/client-resource-groups-tagging-api';
import { GetBucketLocationCommand, ListBucketsCommand } from '@aws-sdk/client-s3';
import { ListSecretsCommand } from '@aws-sdk/client-secrets-manager';
import { DescribeParametersCommand } from '@aws-sdk/client-ssm';
import { resourceFromArn } from './arn.js';
import { collectPages } from './paging.js';
import {
  EXPERIMENT_TAG_KEY,
  EXPERIMENT_TAG_VALUE,
  hasExperimentTag,
  nameMatchesExperiment,
} from './tags.js';
import { asArray, asRecord, asString } from './text.js';
import type { ExperimentResource, TeardownClients } from './types.js';

export interface Inventory {
  resources: ExperimentResource[];
  budgetNames: string[];
}

export async function listExperimentResources(input: {
  clients: TeardownClients;
  region: string;
  accountId: string;
}): Promise<Inventory> {
  const found = new Map<string, ExperimentResource>();
  const budgetNames: string[] = [];

  await Promise.all([
    addTagged(input.clients, found),
    addRds(input.clients, input.region, found),
    addLogGroups(input.clients, input.region, found),
    addNatAndEnis(input.clients, input.region, found),
    addLoadBalancers(input.clients, input.region, found),
    addEcr(input.clients, input.region, found),
    addEcs(input.clients, input.region, found),
    addSecurityGroups(input.clients, input.region, found),
    addSecrets(input.clients, input.region, found),
    addParameters(input.clients, input.region, found),
    addStacks(input.clients, input.region, found),
    addBuckets(input.clients, found),
    addBudgets(input.clients, input.accountId, found, budgetNames),
  ]);

  return { resources: [...found.values()], budgetNames };
}

function add(found: Map<string, ExperimentResource>, resource: ExperimentResource): void {
  const key = `${resource.kind}:${resource.api ?? ''}:${resource.name}`;
  const existing = found.get(key);
  if (!existing) {
    found.set(key, resource);
    return;
  }
  existing.tagged = existing.tagged || resource.tagged;
  existing.owned = existing.owned || resource.owned;
  existing.attached = existing.attached || resource.attached;
  if (!existing.region && resource.region) {
    existing.region = resource.region;
  }
  if (!existing.api && resource.api) {
    existing.api = resource.api;
  }
  if (!existing.status && resource.status) {
    existing.status = resource.status;
  }
  if (!existing.deleteRef) {
    existing.deleteRef = resource.deleteRef;
  }
}

function consider(
  found: Map<string, ExperimentResource>,
  resource: Omit<ExperimentResource, 'owned' | 'tagged'> & { owned?: boolean; tagged?: boolean },
  tags?: unknown,
): void {
  const tagged = resource.tagged ?? hasExperimentTag(tags);
  const owned = resource.owned ?? (tagged || nameMatchesExperiment(resource.name));
  if (!owned) {
    return;
  }
  add(found, { ...resource, tagged, owned });
}

async function addTagged(
  clients: TeardownClients,
  found: Map<string, ExperimentResource>,
): Promise<void> {
  const items = await collectPages(
    clients.tagging,
    (token) =>
      new GetResourcesCommand({
        PaginationToken: token,
        ResourcesPerPage: 100,
        TagFilters: [{ Key: EXPERIMENT_TAG_KEY, Values: [EXPERIMENT_TAG_VALUE] }],
      }),
    (page) => ({
      items: asArray(page.ResourceTagMappingList),
      token: asString(page.PaginationToken),
    }),
  );
  for (const item of items) {
    const record = asRecord(item);
    const arn = asString(record.ResourceARN);
    if (!arn || !hasExperimentTag(record.Tags)) {
      continue;
    }
    const resource = resourceFromArn(arn);
    if (resource) {
      add(found, resource);
    }
  }
}

async function addRds(
  clients: TeardownClients,
  region: string,
  found: Map<string, ExperimentResource>,
): Promise<void> {
  const instances = await collectPages(
    clients.rds,
    (token) => new DescribeDBInstancesCommand({ Marker: token, MaxRecords: 100 }),
    (page) => ({ items: asArray(page.DBInstances), token: asString(page.Marker) }),
  );
  for (const item of instances) {
    const record = asRecord(item);
    const name = asString(record.DBInstanceIdentifier);
    if (!name) {
      continue;
    }
    consider(found, {
      kind: 'rds-instance',
      name,
      deleteRef: name,
      region,
      tagged: hasExperimentTag(record.TagList),
    });
  }

  for (const snapshotType of ['manual', 'automated'] as const) {
    const snapshots = await collectPages(
      clients.rds,
      (token) =>
        new DescribeDBSnapshotsCommand({
          Marker: token,
          MaxRecords: 100,
          SnapshotType: snapshotType,
        }),
      (page) => ({ items: asArray(page.DBSnapshots), token: asString(page.Marker) }),
    );
    for (const item of snapshots) {
      const record = asRecord(item);
      const name = asString(record.DBSnapshotIdentifier);
      const instance = asString(record.DBInstanceIdentifier);
      if (!name) {
        continue;
      }
      const tagged = hasExperimentTag(record.TagList);
      const owned = tagged || nameMatchesExperiment(name) || nameMatchesExperiment(instance);
      if (!owned) {
        continue;
      }
      add(found, {
        kind: 'rds-snapshot',
        name,
        deleteRef: name,
        region,
        tagged,
        owned,
      });
    }
  }

  const backups = await collectPages(
    clients.rds,
    (token) => new DescribeDBInstanceAutomatedBackupsCommand({ Marker: token, MaxRecords: 100 }),
    (page) => ({
      items: asArray(page.DBInstanceAutomatedBackups),
      token: asString(page.Marker),
    }),
  );
  for (const item of backups) {
    const record = asRecord(item);
    const instance = asString(record.DBInstanceIdentifier);
    const arn = asString(record.DBInstanceAutomatedBackupsArn);
    if (!instance) {
      continue;
    }
    const owned = nameMatchesExperiment(instance);
    if (!owned) {
      continue;
    }
    add(found, {
      kind: 'rds-automated-backup',
      name: instance,
      deleteRef: arn ?? instance,
      region,
      tagged: false,
      owned,
    });
  }

  const clusterSnapshots = await collectPages(
    clients.rds,
    (token) => new DescribeDBClusterSnapshotsCommand({ Marker: token, MaxRecords: 100 }),
    (page) => ({
      items: asArray(page.DBClusterSnapshots),
      token: asString(page.Marker),
    }),
  );
  for (const item of clusterSnapshots) {
    const record = asRecord(item);
    const name = asString(record.DBClusterSnapshotIdentifier);
    const cluster = asString(record.DBClusterIdentifier);
    if (!name) {
      continue;
    }
    const tagged = hasExperimentTag(record.TagList);
    const owned = tagged || nameMatchesExperiment(name) || nameMatchesExperiment(cluster);
    if (!owned) {
      continue;
    }
    add(found, {
      kind: 'rds-cluster-snapshot',
      name,
      deleteRef: name,
      region,
      tagged,
      owned,
    });
  }
}

async function addLogGroups(
  clients: TeardownClients,
  region: string,
  found: Map<string, ExperimentResource>,
): Promise<void> {
  const groups = await collectPages(
    clients.logs,
    (token) => new DescribeLogGroupsCommand({ nextToken: token, limit: 50 }),
    (page) => ({ items: asArray(page.logGroups), token: asString(page.nextToken) }),
  );
  for (const item of groups) {
    const name = asString(asRecord(item).logGroupName);
    if (!name) {
      continue;
    }
    consider(found, { kind: 'log-group', name, deleteRef: name, region });
  }
}

async function addNatAndEnis(
  clients: TeardownClients,
  region: string,
  found: Map<string, ExperimentResource>,
): Promise<void> {
  const gateways = await collectPages(
    clients.ec2,
    (token) => new DescribeNatGatewaysCommand({ NextToken: token, MaxResults: 100 }),
    (page) => ({ items: asArray(page.NatGateways), token: asString(page.NextToken) }),
  );
  for (const item of gateways) {
    const record = asRecord(item);
    const id = asString(record.NatGatewayId);
    const state = asString(record.State);
    if (!id || state === 'deleted') {
      continue;
    }
    const name = nameTag(record.Tags) ?? id;
    const tagged = hasExperimentTag(record.Tags);
    const owned = tagged || nameMatchesExperiment(name);
    if (!owned) {
      continue;
    }
    add(found, {
      kind: 'nat-gateway',
      name,
      deleteRef: id,
      region,
      tagged,
      owned,
    });
    for (const address of asArray(record.NatGatewayAddresses)) {
      const allocation = asString(asRecord(address).AllocationId);
      if (!allocation) {
        continue;
      }
      add(found, {
        kind: 'elastic-ip',
        name: allocation,
        deleteRef: allocation,
        region,
        tagged: false,
        owned: true,
      });
    }
  }

  const addresses = asArray(
    asRecord(await clients.ec2.send(new DescribeAddressesCommand({}))).Addresses,
  );
  for (const item of addresses) {
    const record = asRecord(item);
    const allocation = asString(record.AllocationId);
    if (!allocation) {
      continue;
    }
    const name = nameTag(record.Tags) ?? allocation;
    const tagged = hasExperimentTag(record.Tags);
    const owned = tagged || nameMatchesExperiment(name);
    if (!owned) {
      continue;
    }
    add(found, {
      kind: 'elastic-ip',
      name,
      deleteRef: allocation,
      region,
      tagged,
      owned,
    });
  }

  const interfaces = await collectPages(
    clients.ec2,
    (token) => new DescribeNetworkInterfacesCommand({ NextToken: token, MaxResults: 100 }),
    (page) => ({
      items: asArray(page.NetworkInterfaces),
      token: asString(page.NextToken),
    }),
  );
  for (const item of interfaces) {
    const record = asRecord(item);
    const id = asString(record.NetworkInterfaceId);
    if (!id) {
      continue;
    }
    const description = asString(record.Description) ?? '';
    const tagged = hasExperimentTag(record.TagSet);
    const owned =
      tagged || nameMatchesExperiment(description) || nameMatchesExperiment(nameTag(record.TagSet));
    if (!owned) {
      continue;
    }
    const status = asString(record.Status);
    add(found, {
      kind: 'network-interface',
      name: id,
      deleteRef: id,
      region,
      tagged,
      owned,
      attached: status !== 'available',
    });
  }
}

function nameTag(tags: unknown): string | undefined {
  if (!Array.isArray(tags)) {
    return undefined;
  }
  for (const tag of tags) {
    const record = asRecord(tag);
    if (record.Key === 'Name') {
      return asString(record.Value);
    }
  }
  return undefined;
}

async function addLoadBalancers(
  clients: TeardownClients,
  region: string,
  found: Map<string, ExperimentResource>,
): Promise<void> {
  const loadBalancers = await collectPages(
    clients.elbv2,
    (token) => new DescribeLoadBalancersCommand({ Marker: token, PageSize: 100 }),
    (page) => ({ items: asArray(page.LoadBalancers), token: asString(page.NextMarker) }),
  );
  const arns: string[] = [];
  const byArn = new Map<string, { name: string; arn: string }>();
  for (const item of loadBalancers) {
    const record = asRecord(item);
    const name = asString(record.LoadBalancerName);
    const arn = asString(record.LoadBalancerArn);
    if (!name || !arn) {
      continue;
    }
    arns.push(arn);
    byArn.set(arn, { name, arn });
  }
  const tagsByArn = await loadBalancerTags(clients, arns);
  for (const item of byArn.values()) {
    const tags = tagsByArn.get(item.arn);
    consider(
      found,
      {
        kind: 'load-balancer',
        name: item.name,
        deleteRef: item.arn,
        region,
        api: 'elbv2',
        tagged: hasExperimentTag(tags),
      },
      tags,
    );
  }

  const targetGroups = await collectPages(
    clients.elbv2,
    (token) => new DescribeTargetGroupsCommand({ Marker: token, PageSize: 100 }),
    (page) => ({ items: asArray(page.TargetGroups), token: asString(page.NextMarker) }),
  );
  for (const item of targetGroups) {
    const record = asRecord(item);
    const name = asString(record.TargetGroupName);
    const arn = asString(record.TargetGroupArn);
    if (!name || !arn) {
      continue;
    }
    consider(found, {
      kind: 'target-group',
      name,
      deleteRef: arn,
      region,
    });
  }

  const classic = await collectPages(
    clients.elb,
    (token) => new DescribeClassicLoadBalancersCommand({ Marker: token, PageSize: 100 }),
    (page) => ({
      items: asArray(page.LoadBalancerDescriptions),
      token: asString(page.NextMarker),
    }),
  );
  const classicNames = classic
    .map((item) => asString(asRecord(item).LoadBalancerName))
    .filter((name): name is string => Boolean(name));
  const classicTags = await classicLoadBalancerTags(clients, classicNames);
  for (const name of classicNames) {
    const tags = classicTags.get(name);
    consider(
      found,
      {
        kind: 'load-balancer',
        name,
        deleteRef: name,
        region,
        api: 'classic',
        tagged: hasExperimentTag(tags),
      },
      tags,
    );
  }
}

async function loadBalancerTags(
  clients: TeardownClients,
  arns: string[],
): Promise<Map<string, unknown>> {
  const tags = new Map<string, unknown>();
  for (let index = 0; index < arns.length; index += 20) {
    const batch = arns.slice(index, index + 20);
    const page = asRecord(
      await clients.elbv2.send(new DescribeTagsCommand({ ResourceArns: batch })),
    );
    for (const item of asArray(page.TagDescriptions)) {
      const record = asRecord(item);
      const arn = asString(record.ResourceArn);
      if (arn) {
        tags.set(arn, record.Tags);
      }
    }
  }
  return tags;
}

async function classicLoadBalancerTags(
  clients: TeardownClients,
  names: string[],
): Promise<Map<string, unknown>> {
  const tags = new Map<string, unknown>();
  for (let index = 0; index < names.length; index += 20) {
    const batch = names.slice(index, index + 20);
    const page = asRecord(
      await clients.elb.send(new DescribeClassicTagsCommand({ LoadBalancerNames: batch })),
    );
    for (const item of asArray(page.TagDescriptions)) {
      const record = asRecord(item);
      const name = asString(record.LoadBalancerName);
      if (name) {
        tags.set(name, record.Tags);
      }
    }
  }
  return tags;
}

async function addEcr(
  clients: TeardownClients,
  region: string,
  found: Map<string, ExperimentResource>,
): Promise<void> {
  const repos = await collectPages(
    clients.ecr,
    (token) => new DescribeRepositoriesCommand({ nextToken: token, maxResults: 100 }),
    (page) => ({ items: asArray(page.repositories), token: asString(page.nextToken) }),
  );
  for (const item of repos) {
    const name = asString(asRecord(item).repositoryName);
    if (!name) {
      continue;
    }
    consider(found, { kind: 'ecr-repository', name, deleteRef: name, region });
  }
}

async function addEcs(
  clients: TeardownClients,
  region: string,
  found: Map<string, ExperimentResource>,
): Promise<void> {
  const arns = await collectPages(
    clients.ecs,
    (token) => new ListClustersCommand({ nextToken: token, maxResults: 100 }),
    (page) => ({ items: asArray(page.clusterArns), token: asString(page.nextToken) }),
  );
  const clusterArns = arns.filter((item): item is string => typeof item === 'string');
  for (let index = 0; index < clusterArns.length; index += 100) {
    const batch = clusterArns.slice(index, index + 100);
    const page = asRecord(
      await clients.ecs.send(new DescribeClustersCommand({ clusters: batch, include: ['TAGS'] })),
    );
    for (const item of asArray(page.clusters)) {
      const record = asRecord(item);
      const name = asString(record.clusterName);
      if (!name) {
        continue;
      }
      const tags = record.tags;
      consider(
        found,
        {
          kind: 'ecs-cluster',
          name,
          deleteRef: name,
          region,
          tagged: hasExperimentTag(tags),
        },
        tags,
      );
      if (hasExperimentTag(tags) || nameMatchesExperiment(name)) {
        await addTasks(clients, region, name, found);
      }
    }
  }
}

async function addTasks(
  clients: TeardownClients,
  region: string,
  cluster: string,
  found: Map<string, ExperimentResource>,
): Promise<void> {
  const taskArns = await collectPages(
    clients.ecs,
    (token) =>
      new ListTasksCommand({
        cluster,
        desiredStatus: 'RUNNING',
        nextToken: token,
        maxResults: 100,
      }),
    (page) => ({ items: asArray(page.taskArns), token: asString(page.nextToken) }),
  );
  const ids = taskArns.filter((item): item is string => typeof item === 'string');
  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100);
    const page = asRecord(
      await clients.ecs.send(new DescribeTasksCommand({ cluster, tasks: batch })),
    );
    for (const item of asArray(page.tasks)) {
      const record = asRecord(item);
      const taskArn = asString(record.taskArn);
      const taskId = taskArn?.split('/').pop();
      if (!taskId) {
        continue;
      }
      const group = asString(record.group) ?? '';
      const serviceName = group.startsWith('service:') ? group.slice('service:'.length) : '';
      const name = nameMatchesExperiment(serviceName) ? serviceName : `${cluster}/${taskId}`;
      const tags = record.tags;
      add(found, {
        kind: 'ecs-task',
        name,
        deleteRef: `${cluster}/${taskId}`,
        region,
        tagged: hasExperimentTag(tags),
        owned: true,
      });
    }
  }
}

async function addSecurityGroups(
  clients: TeardownClients,
  region: string,
  found: Map<string, ExperimentResource>,
): Promise<void> {
  const groups = await collectPages(
    clients.ec2,
    (token) => new DescribeSecurityGroupsCommand({ NextToken: token, MaxResults: 100 }),
    (page) => ({ items: asArray(page.SecurityGroups), token: asString(page.NextToken) }),
  );
  for (const item of groups) {
    const record = asRecord(item);
    const id = asString(record.GroupId);
    const name = asString(record.GroupName);
    if (!id) {
      continue;
    }
    const tagged = hasExperimentTag(record.Tags);
    const owned = tagged || nameMatchesExperiment(name) || nameMatchesExperiment(id);
    consider(found, {
      kind: 'security-group',
      name: name && nameMatchesExperiment(name) ? name : id,
      deleteRef: id,
      region,
      tagged,
      owned,
    });
  }
}

async function addSecrets(
  clients: TeardownClients,
  region: string,
  found: Map<string, ExperimentResource>,
): Promise<void> {
  const secrets = await collectPages(
    clients.secretsManager,
    (token) =>
      new ListSecretsCommand({
        NextToken: token,
        MaxResults: 100,
        IncludePlannedDeletion: true,
      }),
    (page) => ({ items: asArray(page.SecretList), token: asString(page.NextToken) }),
  );
  for (const item of secrets) {
    const record = asRecord(item);
    const name = asString(record.Name);
    if (!name) {
      continue;
    }
    consider(
      found,
      { kind: 'secret', name, deleteRef: name, region, tagged: hasExperimentTag(record.Tags) },
      record.Tags,
    );
  }
}

async function addParameters(
  clients: TeardownClients,
  region: string,
  found: Map<string, ExperimentResource>,
): Promise<void> {
  const parameters = await collectPages(
    clients.ssm,
    (token) => new DescribeParametersCommand({ NextToken: token, MaxResults: 50 }),
    (page) => ({ items: asArray(page.Parameters), token: asString(page.NextToken) }),
  );
  for (const item of parameters) {
    const name = asString(asRecord(item).Name);
    if (!name) {
      continue;
    }
    consider(found, { kind: 'ssm-parameter', name, deleteRef: name, region });
  }
}

async function addStacks(
  clients: TeardownClients,
  region: string,
  found: Map<string, ExperimentResource>,
): Promise<void> {
  const stacks = await listStackSummaries(clients);
  for (const item of stacks) {
    const record = asRecord(item);
    const name = asString(record.StackName);
    const status = asString(record.StackStatus);
    if (!name || status === 'DELETE_COMPLETE') {
      continue;
    }
    consider(found, {
      kind: 'cloudformation-stack',
      name,
      deleteRef: name,
      region,
      status,
    });
  }
}

export async function listStackSummaries(clients: TeardownClients): Promise<unknown[]> {
  return collectPages(
    clients.cloudformation,
    (token) => new ListStacksCommand({ NextToken: token }),
    (page) => ({ items: asArray(page.StackSummaries), token: asString(page.NextToken) }),
  );
}

async function addBuckets(
  clients: TeardownClients,
  found: Map<string, ExperimentResource>,
): Promise<void> {
  const page = asRecord(await clients.s3.send(new ListBucketsCommand({})));
  for (const item of asArray(page.Buckets)) {
    const name = asString(asRecord(item).Name);
    if (!name || !nameMatchesExperiment(name)) {
      continue;
    }
    const location = asRecord(
      await clients.s3.send(new GetBucketLocationCommand({ Bucket: name })),
    );
    add(found, {
      kind: 's3-bucket',
      name,
      deleteRef: name,
      region: bucketRegion(location.LocationConstraint),
      tagged: false,
      owned: true,
    });
  }
}

function bucketRegion(constraint: unknown): string {
  if (constraint === null || constraint === undefined || constraint === '') {
    return 'us-east-1';
  }
  if (constraint === 'EU') {
    return 'eu-west-1';
  }
  return typeof constraint === 'string' ? constraint : 'us-east-1';
}

async function addBudgets(
  clients: TeardownClients,
  accountId: string,
  found: Map<string, ExperimentResource>,
  budgetNames: string[],
): Promise<void> {
  const budgets = await collectPages(
    clients.budgets,
    (token) =>
      new DescribeBudgetsCommand({ AccountId: accountId, NextToken: token, MaxResults: 100 }),
    (page) => ({ items: asArray(page.Budgets), token: asString(page.NextToken) }),
  );
  for (const item of budgets) {
    const name = asString(asRecord(item).BudgetName);
    if (!name) {
      continue;
    }
    budgetNames.push(name);
    if (!nameMatchesExperiment(name)) {
      continue;
    }
    add(found, {
      kind: 'budget',
      name,
      deleteRef: name,
      tagged: false,
      owned: true,
    });
  }
}
