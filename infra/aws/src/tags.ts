/**
 * Experiment tagging contract.
 *
 * Every AWS resource created for this experiment carries exactly one
 * ownership tag. Teardown and the deploy guard read this pair; they do not
 * accept a different tag at runtime.
 *
 *   experiment = otel-demo
 *
 * Future CDK stacks must apply {@link experimentTagList} to every construct,
 * including children that CloudFormation would otherwise leave untagged
 * (snapshots, log groups, ENIs). The AWS Budgets alert named
 * `otel-demo-experiment` is the one exception: it may carry the tag, and
 * teardown still retains it by name.
 */
export const EXPERIMENT_TAG_KEY = 'experiment';
export const EXPERIMENT_TAG_VALUE = 'otel-demo';
export const EXPERIMENT_NAME = 'otel-demo';

/**
 * Name of the long-lived AWS Budgets alert already created in the account.
 * Allow-listed by this exact name. Ron deletes it by hand after the experiment
 * is fully finished.
 */
export const RETAINED_BUDGET_NAME = 'otel-demo-experiment';

/** Catalog id in observability/alerts.yml. Not the AWS Budgets resource name. */
export const BUDGET_CATALOG_NAME = 'experiment-budget';

export const DEFAULT_REGION = 'eu-central-1';
export const DEFAULT_BUDGETS_REGION = 'us-east-1';

export interface TagPair {
  Key: string;
  Value: string;
}

export function experimentTagList(): TagPair[] {
  return [{ Key: EXPERIMENT_TAG_KEY, Value: EXPERIMENT_TAG_VALUE }];
}

export function hasExperimentTag(tags: unknown): boolean {
  if (!Array.isArray(tags)) {
    return false;
  }
  return tags.some((tag) => {
    if (tag === null || typeof tag !== 'object') {
      return false;
    }
    const record = tag as Record<string, unknown>;
    const key = record.Key ?? record.key;
    const value = record.Value ?? record.value;
    return key === EXPERIMENT_TAG_KEY && value === EXPERIMENT_TAG_VALUE;
  });
}

/**
 * True when `name` contains the experiment name as a whole token.
 * `otel-demo` and `otel-demo-shop` match. `otel-demonstration` does not.
 * `CDKToolkit` and `cdk-*` bootstrap names never match.
 */
export function nameMatchesExperiment(name: string | undefined): boolean {
  if (!name) {
    return false;
  }
  const normalized = name.toLowerCase();
  if (normalized === 'cdktoolkit' || normalized.startsWith('cdk-')) {
    return false;
  }
  const prefix = EXPERIMENT_NAME;
  let from = 0;
  while (from <= normalized.length - prefix.length) {
    const at = normalized.indexOf(prefix, from);
    if (at < 0) {
      return false;
    }
    const before = at === 0 ? '' : (normalized[at - 1] ?? '');
    const after = normalized[at + prefix.length] ?? '';
    const boundaryBefore = before === '' || before === '/' || before === '-' || before === '.';
    const boundaryAfter = after === '' || after === '/' || after === '-' || after === '.';
    if (boundaryBefore && boundaryAfter) {
      return true;
    }
    from = at + prefix.length;
  }
  return false;
}

export function isRetainedBudgetName(name: string | undefined): boolean {
  return name === RETAINED_BUDGET_NAME;
}
