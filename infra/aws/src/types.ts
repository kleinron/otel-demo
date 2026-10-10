export const RESOURCE_KINDS = [
  'budget',
  'rds-instance',
  'rds-snapshot',
  'rds-automated-backup',
  'rds-cluster-snapshot',
  'log-group',
  'nat-gateway',
  'elastic-ip',
  'network-interface',
  'security-group',
  'load-balancer',
  'target-group',
  'ecr-repository',
  'ecs-cluster',
  'ecs-service',
  'ecs-task',
  'secret',
  'ssm-parameter',
  'cloudformation-stack',
  's3-bucket',
  'other',
] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export type LoadBalancerApi = 'classic' | 'elbv2';

/**
 * A resource the safety tools may print, delete, or retain.
 * `deleteRef` is an API identifier and may be sensitive. Never print it.
 * `name` is the operator-facing identifier and must stay free of account ids.
 */
export interface ExperimentResource {
  kind: ResourceKind;
  name: string;
  deleteRef: string;
  region?: string;
  tagged: boolean;
  owned: boolean;
  api?: LoadBalancerApi;
  attached?: boolean;
  /** CloudFormation stack status, when known. Safe to print. */
  status?: string;
}

export interface SdkCommand {
  readonly input?: unknown;
}

export interface SdkClient {
  send(command: SdkCommand): Promise<unknown>;
}

export interface TeardownClients {
  sts: SdkClient;
  tagging: SdkClient;
  cloudwatch: SdkClient;
  logs: SdkClient;
  rds: SdkClient;
  ec2: SdkClient;
  elbv2: SdkClient;
  elb: SdkClient;
  ecr: SdkClient;
  ecs: SdkClient;
  s3: SdkClient;
  cloudformation: SdkClient;
  budgets: SdkClient;
  serviceQuotas: SdkClient;
  secretsManager: SdkClient;
  ssm: SdkClient;
  xray: SdkClient;
  kms: SdkClient;
  elasticache: SdkClient;
  opensearch: SdkClient;
}

export interface SleepOptions {
  sleep: (ms: number) => Promise<void>;
  waitAttempts: number;
  waitIntervalMs: number;
}
