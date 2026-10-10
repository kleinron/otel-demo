import { hasExperimentTag, nameMatchesExperiment } from './tags.js';
import type { ExperimentResource, ResourceKind } from './types.js';

export interface ParsedArn {
  service: string;
  region: string;
  resource: string;
}

export function parseArn(value: string): ParsedArn | null {
  const parts = value.split(':');
  if (parts[0] !== 'arn' || parts.length < 6) {
    return null;
  }
  return {
    service: parts[2] ?? '',
    region: parts[3] ?? '',
    resource: parts.slice(5).join(':'),
  };
}

function regionOrUndefined(region: string): string | undefined {
  return region.length > 0 ? region : undefined;
}

/**
 * Map a tagged resource name into the inventory. The caller has already
 * decided the resource carries the experiment tag.
 */
export function resourceFromArn(value: string): ExperimentResource | null {
  const parsed = parseArn(value);
  if (!parsed) {
    return null;
  }
  const mapped = mapResource(parsed.service, parsed.resource, value);
  if (!mapped) {
    return null;
  }
  return {
    ...mapped,
    region: mapped.region ?? regionOrUndefined(parsed.region),
    tagged: true,
    owned: true,
  };
}

function mapResource(
  service: string,
  resource: string,
  arn: string,
): Pick<ExperimentResource, 'kind' | 'name' | 'deleteRef' | 'region' | 'api'> | null {
  if (service === 'budgets') {
    const name = resource.split('/')[1] ?? resource;
    return { kind: 'budget', name, deleteRef: name };
  }
  if (service === 'rds') {
    return mapRds(resource, arn);
  }
  if (service === 'logs') {
    const raw = resource.startsWith('log-group:') ? resource.slice('log-group:'.length) : resource;
    const name = raw.replace(/:\*$/, '');
    return { kind: 'log-group', name, deleteRef: name };
  }
  if (service === 'ec2') {
    return mapEc2(resource, arn);
  }
  if (service === 'elasticloadbalancing') {
    return mapLoadBalancer(resource, arn);
  }
  if (service === 'ecs') {
    return mapEcs(resource);
  }
  if (service === 'ecr') {
    const name = resource.replace(/^repository\//, '');
    return { kind: 'ecr-repository', name, deleteRef: name };
  }
  if (service === 's3') {
    return { kind: 's3-bucket', name: resource, deleteRef: resource };
  }
  if (service === 'cloudformation') {
    const name = resource.replace(/^stack\//, '').split('/')[0] ?? resource;
    return { kind: 'cloudformation-stack', name, deleteRef: name };
  }
  const slash = resource.includes('/') ? resource : resource;
  return { kind: 'other', name: `${service}/${slash}`, deleteRef: arn };
}

function mapRds(
  resource: string,
  arn: string,
): Pick<ExperimentResource, 'kind' | 'name' | 'deleteRef'> | null {
  const [kind, name] = resource.split(':');
  if (!kind || !name) {
    return { kind: 'other', name: `rds/${resource}`, deleteRef: arn };
  }
  const mapped: Record<string, ResourceKind> = {
    db: 'rds-instance',
    snapshot: 'rds-snapshot',
    'cluster-snapshot': 'rds-cluster-snapshot',
    'auto-backup': 'rds-automated-backup',
  };
  const resourceKind = mapped[kind] ?? 'other';
  if (resourceKind === 'rds-automated-backup') {
    return { kind: resourceKind, name, deleteRef: arn };
  }
  if (resourceKind === 'other') {
    return { kind: 'other', name: `rds/${resource}`, deleteRef: name };
  }
  return { kind: resourceKind, name, deleteRef: name };
}

function mapEc2(
  resource: string,
  arn: string,
): Pick<ExperimentResource, 'kind' | 'name' | 'deleteRef'> {
  const [kind, id] = resource.split('/');
  const name = id ?? resource;
  if (kind === 'natgateway') {
    return { kind: 'nat-gateway', name, deleteRef: name };
  }
  if (kind === 'elastic-ip') {
    return { kind: 'elastic-ip', name, deleteRef: name };
  }
  if (kind === 'network-interface') {
    return { kind: 'network-interface', name, deleteRef: name };
  }
  return { kind: 'other', name: `ec2/${resource}`, deleteRef: arn };
}

function mapLoadBalancer(
  resource: string,
  arn: string,
): Pick<ExperimentResource, 'kind' | 'name' | 'deleteRef' | 'api'> {
  const bits = resource.split('/');
  if (bits[0] === 'loadbalancer') {
    return {
      kind: 'load-balancer',
      name: bits[2] ?? resource,
      deleteRef: arn,
      api: 'elbv2',
    };
  }
  if (bits[0] === 'targetgroup') {
    return { kind: 'target-group', name: bits[1] ?? resource, deleteRef: arn };
  }
  return { kind: 'other', name: `elasticloadbalancing/${resource}`, deleteRef: arn };
}

function mapEcs(resource: string): Pick<ExperimentResource, 'kind' | 'name' | 'deleteRef'> {
  const bits = resource.split('/');
  if (bits[0] === 'cluster') {
    const name = bits[1] ?? resource;
    return { kind: 'ecs-cluster', name, deleteRef: name };
  }
  if (bits[0] === 'service') {
    const cluster = bits[1] ?? '';
    const service = bits[2] ?? resource;
    const name = cluster ? `${cluster}/${service}` : service;
    return { kind: 'ecs-service', name, deleteRef: name };
  }
  return { kind: 'other', name: `ecs/${resource}`, deleteRef: resource };
}

export function ownedByNameOrTag(name: string, tags: unknown): { owned: boolean; tagged: boolean } {
  const tagged = hasExperimentTag(tags);
  return { tagged, owned: tagged || nameMatchesExperiment(name) };
}
