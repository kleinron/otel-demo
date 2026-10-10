import { DeleteStackCommand } from '@aws-sdk/client-cloudformation';
import {
  DeleteNatGatewayCommand,
  DeleteNetworkInterfaceCommand,
  DescribeNatGatewaysCommand,
  ReleaseAddressCommand,
} from '@aws-sdk/client-ec2';
import { DeleteRepositoryCommand } from '@aws-sdk/client-ecr';
import {
  DeleteClusterCommand,
  DeleteServiceCommand,
  ListServicesCommand,
} from '@aws-sdk/client-ecs';
import { DeleteLoadBalancerCommand as DeleteClassicLoadBalancerCommand } from '@aws-sdk/client-elastic-load-balancing';
import {
  DeleteLoadBalancerCommand,
  DeleteTargetGroupCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { DeleteLogGroupCommand } from '@aws-sdk/client-cloudwatch-logs';
import {
  DeleteDBClusterSnapshotCommand,
  DeleteDBInstanceAutomatedBackupCommand,
  DeleteDBInstanceCommand,
  DeleteDBSnapshotCommand,
  DescribeDBInstancesCommand,
} from '@aws-sdk/client-rds';
import {
  AbortMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import { isAlreadyGone } from './errors.js';
import { listExperimentResources } from './inventory.js';
import { collectPages } from './paging.js';
import { safeError } from './redact.js';
import { deleteSkipReason } from './retention.js';
import { asArray, asRecord, asString } from './text.js';
import type { ExperimentResource, ResourceKind, SleepOptions, TeardownClients } from './types.js';
import { waitUntil } from './wait.js';

export interface DeleteReport {
  planned: string[];
  deleted: string[];
  skipped: string[];
  errors: string[];
  lines: string[];
}

const ORDER: ResourceKind[] = [
  'load-balancer',
  'target-group',
  'ecs-service',
  'ecs-cluster',
  'nat-gateway',
  'network-interface',
  'elastic-ip',
  'rds-instance',
  'rds-snapshot',
  'rds-cluster-snapshot',
  'rds-automated-backup',
  'log-group',
  'ecr-repository',
  's3-bucket',
  'cloudformation-stack',
  'other',
  'budget',
];

export function resourceLabel(resource: ExperimentResource): string {
  return `${resource.kind} ${resource.name}`;
}

export async function deleteLeftovers(input: {
  clients: TeardownClients;
  region: string;
  accountId: string;
  dryRun: boolean;
  wait: SleepOptions;
}): Promise<DeleteReport> {
  const inventory = await listExperimentResources({
    clients: input.clients,
    region: input.region,
    accountId: input.accountId,
  });
  const skipped: string[] = [];
  const deletable: ExperimentResource[] = [];
  for (const resource of inventory.resources) {
    const reason = deleteSkipReason(resource, input.region);
    if (reason) {
      skipped.push(`${resourceLabel(resource)} (${reason})`);
      continue;
    }
    deletable.push(resource);
  }
  deletable.sort((left, right) => ORDER.indexOf(left.kind) - ORDER.indexOf(right.kind));
  const planned = deletable.map(resourceLabel);

  if (input.dryRun) {
    return {
      planned,
      deleted: [],
      skipped,
      errors: [],
      lines: dryRunLines(planned, skipped),
    };
  }

  const deleted: string[] = [];
  const errors: string[] = [];
  for (const resource of deletable) {
    try {
      await deleteResource(input.clients, resource, input.wait);
      deleted.push(resourceLabel(resource));
    } catch (error) {
      if (isAlreadyGone(error)) {
        deleted.push(resourceLabel(resource));
      } else {
        errors.push(`${resourceLabel(resource)}: ${safeError(error)}`);
      }
    }
  }

  return {
    planned,
    deleted,
    skipped,
    errors,
    lines: realLines(deleted, skipped, errors),
  };
}

function dryRunLines(planned: string[], skipped: string[]): string[] {
  const lines = [
    planned.length === 0
      ? 'Leftovers: dry-run found nothing to delete.'
      : `Leftovers: dry-run would delete ${planned.length}: ${planned.join(', ')}.`,
  ];
  const retained = skipped.filter((line) => line.includes('allow-listed budget name'));
  if (retained.length > 0) {
    lines.push(`Leftovers: skipped ${retained.join(', ')}.`);
  }
  return lines;
}

function realLines(deleted: string[], skipped: string[], errors: string[]): string[] {
  const lines = [
    deleted.length === 0
      ? 'Leftovers: nothing to delete.'
      : `Leftovers: deleted ${deleted.length}: ${deleted.join(', ')}.`,
  ];
  const retained = skipped.filter((line) => line.includes('allow-listed budget name'));
  if (retained.length > 0) {
    lines.push(`Leftovers: skipped ${retained.join(', ')}.`);
  }
  for (const error of errors) {
    lines.push(`Leftovers: error ${error}`);
  }
  return lines;
}

async function deleteResource(
  clients: TeardownClients,
  resource: ExperimentResource,
  wait: SleepOptions,
): Promise<void> {
  switch (resource.kind) {
    case 'load-balancer':
      if (resource.api === 'classic') {
        await clients.elb.send(
          new DeleteClassicLoadBalancerCommand({ LoadBalancerName: resource.deleteRef }),
        );
      } else {
        await clients.elbv2.send(
          new DeleteLoadBalancerCommand({ LoadBalancerArn: resource.deleteRef }),
        );
      }
      return;
    case 'target-group':
      await clients.elbv2.send(
        new DeleteTargetGroupCommand({ TargetGroupArn: resource.deleteRef }),
      );
      return;
    case 'ecs-service': {
      const [cluster, service] = resource.deleteRef.split('/');
      if (!cluster || !service) {
        throw new Error('ecs service is missing a cluster name');
      }
      await clients.ecs.send(new DeleteServiceCommand({ cluster, service, force: true }));
      return;
    }
    case 'ecs-cluster':
      await deleteCluster(clients, resource.deleteRef);
      return;
    case 'nat-gateway':
      await clients.ec2.send(new DeleteNatGatewayCommand({ NatGatewayId: resource.deleteRef }));
      await waitUntil(async () => {
        const page = asRecord(
          await clients.ec2.send(
            new DescribeNatGatewaysCommand({ NatGatewayIds: [resource.deleteRef] }),
          ),
        );
        const state = asString(asRecord(asArray(page.NatGateways)[0]).State);
        return !state || state === 'deleted';
      }, wait);
      return;
    case 'network-interface':
      await clients.ec2.send(
        new DeleteNetworkInterfaceCommand({ NetworkInterfaceId: resource.deleteRef }),
      );
      return;
    case 'elastic-ip':
      await clients.ec2.send(new ReleaseAddressCommand({ AllocationId: resource.deleteRef }));
      return;
    case 'rds-instance':
      await clients.rds.send(
        new DeleteDBInstanceCommand({
          DBInstanceIdentifier: resource.deleteRef,
          SkipFinalSnapshot: true,
          DeleteAutomatedBackups: true,
        }),
      );
      await waitUntil(async () => {
        try {
          const page = asRecord(
            await clients.rds.send(
              new DescribeDBInstancesCommand({ DBInstanceIdentifier: resource.deleteRef }),
            ),
          );
          return asArray(page.DBInstances).length === 0;
        } catch (error) {
          if (isAlreadyGone(error)) {
            return true;
          }
          throw error;
        }
      }, wait);
      return;
    case 'rds-snapshot':
      await clients.rds.send(
        new DeleteDBSnapshotCommand({ DBSnapshotIdentifier: resource.deleteRef }),
      );
      return;
    case 'rds-cluster-snapshot':
      await clients.rds.send(
        new DeleteDBClusterSnapshotCommand({ DBClusterSnapshotIdentifier: resource.deleteRef }),
      );
      return;
    case 'rds-automated-backup':
      await clients.rds.send(
        new DeleteDBInstanceAutomatedBackupCommand({
          DBInstanceAutomatedBackupsArn: resource.deleteRef,
        }),
      );
      return;
    case 'log-group':
      await clients.logs.send(new DeleteLogGroupCommand({ logGroupName: resource.deleteRef }));
      return;
    case 'ecr-repository':
      await clients.ecr.send(
        new DeleteRepositoryCommand({ repositoryName: resource.deleteRef, force: true }),
      );
      return;
    case 's3-bucket':
      await emptyBucket(clients, resource.deleteRef);
      await clients.s3.send(new DeleteBucketCommand({ Bucket: resource.deleteRef }));
      return;
    case 'cloudformation-stack':
      await clients.cloudformation.send(new DeleteStackCommand({ StackName: resource.deleteRef }));
      return;
    case 'budget':
    case 'other':
      return;
    default: {
      const unreachable: never = resource.kind;
      throw new Error(`no deleter for ${String(unreachable)}`);
    }
  }
}

async function deleteCluster(clients: TeardownClients, cluster: string): Promise<void> {
  const services = await collectPages(
    clients.ecs,
    (token) => new ListServicesCommand({ cluster, nextToken: token, maxResults: 100 }),
    (page) => ({ items: asArray(page.serviceArns), token: asString(page.nextToken) }),
  );
  for (const service of services) {
    if (typeof service !== 'string') {
      continue;
    }
    await clients.ecs.send(new DeleteServiceCommand({ cluster, service, force: true }));
  }
  await clients.ecs.send(new DeleteClusterCommand({ cluster }));
}

async function emptyBucket(clients: TeardownClients, bucket: string): Promise<void> {
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    const page = asRecord(
      await clients.s3.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          KeyMarker: keyMarker,
          VersionIdMarker: versionMarker,
        }),
      ),
    );
    const objects = [...asArray(page.Versions), ...asArray(page.DeleteMarkers)]
      .map((item) => {
        const record = asRecord(item);
        const key = asString(record.Key);
        const versionId = asString(record.VersionId);
        return key ? { Key: key, VersionId: versionId } : undefined;
      })
      .filter((item): item is { Key: string; VersionId: string | undefined } => Boolean(item));
    for (let index = 0; index < objects.length; index += 1000) {
      const batch = objects.slice(index, index + 1000);
      await clients.s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch, Quiet: true },
        }),
      );
    }
    if (page.IsTruncated !== true) {
      break;
    }
    const nextKey = asString(page.NextKeyMarker);
    const nextVersion = asString(page.NextVersionIdMarker);
    const token = `${nextKey ?? ''}:${nextVersion ?? ''}`;
    if (!nextKey || seen.has(token)) {
      break;
    }
    seen.add(token);
    keyMarker = nextKey;
    versionMarker = nextVersion;
  }

  const uploads = asArray(
    asRecord(await clients.s3.send(new ListMultipartUploadsCommand({ Bucket: bucket }))).Uploads,
  );
  for (const upload of uploads) {
    const record = asRecord(upload);
    const key = asString(record.Key);
    const uploadId = asString(record.UploadId);
    if (!key || !uploadId) {
      continue;
    }
    await clients.s3.send(
      new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
    );
  }
}
