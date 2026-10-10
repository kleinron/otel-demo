import { isRetainedBudgetName } from './tags.js';
import type { ExperimentResource, ResourceKind } from './types.js';

const DELETABLE: Record<ResourceKind, boolean> = {
  budget: false,
  'rds-instance': true,
  'rds-snapshot': true,
  'rds-automated-backup': true,
  'rds-cluster-snapshot': true,
  'log-group': true,
  'nat-gateway': true,
  'elastic-ip': true,
  'network-interface': true,
  'load-balancer': true,
  'target-group': true,
  'ecr-repository': true,
  'ecs-cluster': true,
  'ecs-service': true,
  'cloudformation-stack': true,
  's3-bucket': true,
  other: false,
};

export function isRetainedBudget(resource: ExperimentResource): boolean {
  return resource.kind === 'budget' && isRetainedBudgetName(resource.name);
}

export function isBootstrapResource(resource: ExperimentResource): boolean {
  if (resource.kind === 'cloudformation-stack' && resource.name === 'CDKToolkit') {
    return true;
  }
  if (resource.kind === 's3-bucket' && resource.name.toLowerCase().startsWith('cdk-')) {
    return true;
  }
  return false;
}

/** Resources that count against a clean account. The named budget never does. */
export function isLeftover(resource: ExperimentResource): boolean {
  if (!resource.owned) {
    return false;
  }
  if (isRetainedBudget(resource) || isBootstrapResource(resource)) {
    return false;
  }
  return true;
}

/**
 * Why a candidate is not deleted. The named budget is skipped even when it
 * carries the experiment tag or its name matches the experiment prefix.
 */
export function deleteSkipReason(resource: ExperimentResource, region: string): string | undefined {
  if (isRetainedBudget(resource)) {
    return 'allow-listed budget name';
  }
  if (resource.kind === 'budget') {
    return 'budgets are not deleted by teardown';
  }
  if (isBootstrapResource(resource)) {
    return 'bootstrap';
  }
  if (!resource.owned) {
    return 'not an experiment resource';
  }
  if (resource.attached) {
    return 'still attached';
  }
  if (resource.region && resource.region !== region) {
    return 'different region';
  }
  if (!DELETABLE[resource.kind]) {
    return 'no deleter for this type';
  }
  return undefined;
}

export function hasDeleter(kind: ResourceKind): boolean {
  return DELETABLE[kind];
}
