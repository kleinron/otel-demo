import {
  DescribeServicesCommand,
  DescribeTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';
import { CLUSTER_NAME } from './names.js';
import { redactText } from './redact.js';
import { asArray, asRecord, asString } from './text.js';
import type { SdkClient } from './types.js';

export interface SeedTarget {
  serviceName: string;
  command: readonly string[];
}

/**
 * Shop customers and inventory stock. Payment and delivery migrate when their
 * service tasks start, so this list does not include them.
 */
export const AWS_SEED_TARGETS: readonly SeedTarget[] = [
  {
    serviceName: 'otel-demo-shop',
    command: ['node', 'services/shop/dist/seed-main.js'],
  },
  {
    serviceName: 'otel-demo-inventory',
    command: ['node', 'services/inventory/dist/seed-main.js'],
  },
];

/**
 * Top up inventory on the deployed task definition. Shop is not included:
 * seeding shop drops orders.
 */
export const AWS_RESTOCK_TARGETS: readonly SeedTarget[] = [
  {
    serviceName: 'otel-demo-inventory',
    command: ['node', 'services/inventory/dist/restock-main.js'],
  },
];

const APP_CONTAINER = 'app';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS = 5_000;

export interface SeedRunOptions {
  ecs: SdkClient;
  cluster?: string;
  targets?: readonly SeedTarget[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  pollMs?: number;
  onSeeded?: (serviceName: string) => void;
  startedBy?: string;
}

/** Run shop and inventory seed as one-off tasks from the deployed task definitions. */
export async function seedDeployedServices(options: SeedRunOptions): Promise<void> {
  const cluster = options.cluster ?? CLUSTER_NAME;
  const targets = options.targets ?? AWS_SEED_TARGETS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const failures: string[] = [];
  for (const target of targets) {
    try {
      await runSeedTask({
        ecs: options.ecs,
        cluster,
        target,
        sleep,
        now,
        timeoutMs,
        pollMs,
        startedBy: options.startedBy ?? 'otel-demo-seed',
      });
      options.onSeeded?.(target.serviceName);
    } catch (error) {
      failures.push(redactText(error instanceof Error ? error.message : String(error)));
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join('\n'));
  }
}

/** One-off inventory restock. Does not run the shop seed, which drops orders. */
export async function restockDeployedInventory(options: SeedRunOptions): Promise<void> {
  await seedDeployedServices({
    ...options,
    targets: options.targets ?? AWS_RESTOCK_TARGETS,
    startedBy: options.startedBy ?? 'otel-demo-restock',
  });
}

async function runSeedTask(input: {
  ecs: SdkClient;
  cluster: string;
  target: SeedTarget;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  timeoutMs: number;
  pollMs: number;
  startedBy: string;
}): Promise<void> {
  const described = asRecord(
    await input.ecs.send(
      new DescribeServicesCommand({
        cluster: input.cluster,
        services: [input.target.serviceName],
      }),
    ),
  );
  const service = activeService(described, input.target.serviceName);
  const taskDefinition = asString(service.taskDefinition);
  if (!taskDefinition) {
    throw new Error(`ECS service ${input.target.serviceName} has no task definition`);
  }
  const network = awsvpc(service, input.target.serviceName);
  const started = asRecord(
    await input.ecs.send(
      new RunTaskCommand({
        cluster: input.cluster,
        taskDefinition,
        launchType: 'FARGATE',
        count: 1,
        startedBy: input.startedBy,
        propagateTags: 'TASK_DEFINITION',
        networkConfiguration: { awsvpcConfiguration: network },
        overrides: {
          containerOverrides: [{ name: APP_CONTAINER, command: [...input.target.command] }],
        },
      }),
    ),
  );
  const taskArn = asString(asRecord(asArray(started.tasks)[0]).taskArn);
  const failureReason = asArray(started.failures)
    .map((item) => asString(asRecord(item).reason))
    .filter((item): item is string => item !== undefined)
    .join('; ');
  if (!taskArn || failureReason) {
    throw new Error(
      `could not start ${input.target.serviceName} seed task${failureReason ? `: ${failureReason}` : ''}`,
    );
  }

  const deadline = input.now() + input.timeoutMs;
  let askedToStop = false;
  let stoppedTask: Record<string, unknown> | undefined;
  for (;;) {
    const page = asRecord(
      await input.ecs.send(new DescribeTasksCommand({ cluster: input.cluster, tasks: [taskArn] })),
    );
    const task = asRecord(asArray(page.tasks)[0]);
    if (asString(task.lastStatus) === 'STOPPED') {
      stoppedTask = task;
      break;
    }
    if (!askedToStop && containerExit(task, APP_CONTAINER) !== undefined) {
      askedToStop = true;
      await stopTask(input.ecs, input.cluster, taskArn, input.startedBy);
    }
    if (input.now() >= deadline) {
      await stopTask(input.ecs, input.cluster, taskArn, input.startedBy);
      throw new Error(`${input.target.serviceName} seed task did not finish`);
    }
    await input.sleep(input.pollMs);
  }

  if (!stoppedTask) {
    throw new Error(`${input.target.serviceName} seed task did not finish`);
  }
  const exitCode = containerExit(stoppedTask, APP_CONTAINER);
  if (exitCode !== 0) {
    const reason = asString(stoppedTask.stoppedReason) ?? 'seed task failed';
    throw new Error(
      `${input.target.serviceName} seed task exited ${exitCode ?? 'without a code'}: ${reason}`,
    );
  }
}

function activeService(
  payload: Record<string, unknown>,
  serviceName: string,
): Record<string, unknown> {
  const match = asArray(payload.services)
    .map((item) => asRecord(item))
    .find((item) => item.serviceName === serviceName && item.status === 'ACTIVE');
  if (!match) {
    throw new Error(`ECS service ${serviceName} is not active`);
  }
  return match;
}

function awsvpc(
  service: Record<string, unknown>,
  serviceName: string,
): { subnets: string[]; securityGroups: string[]; assignPublicIp: 'ENABLED' | 'DISABLED' } {
  const config = asRecord(asRecord(service.networkConfiguration).awsvpcConfiguration);
  const subnets = strings(config.subnets);
  const securityGroups = strings(config.securityGroups);
  const assignPublicIp = asString(config.assignPublicIp);
  if (
    subnets.length === 0 ||
    securityGroups.length === 0 ||
    (assignPublicIp !== 'ENABLED' && assignPublicIp !== 'DISABLED')
  ) {
    throw new Error(`ECS service ${serviceName} has no task network`);
  }
  return { subnets, securityGroups, assignPublicIp };
}

function strings(value: unknown): string[] {
  return asArray(value).filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  );
}

function containerExit(task: Record<string, unknown>, name: string): number | undefined {
  const container = asArray(task.containers)
    .map((item) => asRecord(item))
    .find((item) => item.name === name);
  return typeof container?.exitCode === 'number' ? container.exitCode : undefined;
}

async function stopTask(
  ecs: SdkClient,
  cluster: string,
  task: string,
  startedBy: string,
): Promise<void> {
  try {
    await ecs.send(new StopTaskCommand({ cluster, task, reason: `${startedBy} finished` }));
  } catch {
    // The task may already be stopped. The app exit code is the result that matters.
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
