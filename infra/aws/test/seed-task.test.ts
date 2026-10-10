import { describe, expect, it } from 'vitest';
import { AWS_SEED_TARGETS, seedDeployedServices } from '../src/seed-task.js';
import { recordingClient } from './aws-mock.js';

const NETWORK = {
  subnets: ['subnet-public-a', 'subnet-public-b'],
  securityGroups: ['sg-workload'],
  assignPublicIp: 'ENABLED',
};

function servicePage(input: Record<string, unknown>) {
  const name = (input.services as string[])[0] ?? 'missing';
  return {
    services: [
      {
        serviceName: name,
        status: 'ACTIVE',
        taskDefinition: `family/${name}`,
        networkConfiguration: { awsvpcConfiguration: NETWORK },
      },
    ],
  };
}

function stoppedTask(exitCode: number | undefined) {
  return {
    tasks: [
      {
        lastStatus: 'STOPPED',
        stoppedReason: 'Essential container in task exited',
        containers: [
          { name: 'app', lastStatus: 'STOPPED', ...(exitCode === undefined ? {} : { exitCode }) },
        ],
      },
    ],
  };
}

describe('aws seed tasks', () => {
  it('seeds shop and inventory from the deployed task definitions', async () => {
    const ecs = recordingClient({
      DescribeServicesCommand: servicePage,
      RunTaskCommand: (input) => ({
        tasks: [{ taskArn: `task/otel-demo/${String(input.taskDefinition)}` }],
      }),
      DescribeTasksCommand: () => stoppedTask(0),
    });
    const seeded: string[] = [];
    await seedDeployedServices({
      ecs: ecs.client,
      sleep: async () => {},
      now: () => 0,
      onSeeded(serviceName) {
        seeded.push(serviceName);
      },
    });

    expect(seeded).toEqual(['otel-demo-shop', 'otel-demo-inventory']);
    expect(AWS_SEED_TARGETS.map((target) => target.serviceName)).toEqual(seeded);
    const runs = ecs.calls.filter((call) => call.name === 'RunTaskCommand');
    expect(runs.map((call) => call.input.taskDefinition)).toEqual([
      'family/otel-demo-shop',
      'family/otel-demo-inventory',
    ]);
    expect(runs.map((call) => call.input.overrides)).toEqual([
      {
        containerOverrides: [{ name: 'app', command: ['node', 'services/shop/dist/seed-main.js'] }],
      },
      {
        containerOverrides: [
          { name: 'app', command: ['node', 'services/inventory/dist/seed-main.js'] },
        ],
      },
    ]);
    for (const run of runs) {
      expect(run.input.cluster).toBe('otel-demo');
      expect(run.input.launchType).toBe('FARGATE');
      expect(run.input.networkConfiguration).toEqual({ awsvpcConfiguration: NETWORK });
    }
    const described = ecs.calls
      .filter((call) => call.name === 'DescribeServicesCommand')
      .map((call) => call.input.services);
    expect(described).toEqual([['otel-demo-shop'], ['otel-demo-inventory']]);
    expect(JSON.stringify(described)).not.toContain('payment');
    expect(JSON.stringify(described)).not.toContain('delivery');
    expect(ecs.calls.some((call) => call.name === 'StopTaskCommand')).toBe(false);
  });

  it('stops a task whose app container has exited while the sidecar is still up', async () => {
    let reads = 0;
    const ecs = recordingClient({
      DescribeServicesCommand: servicePage,
      RunTaskCommand: () => ({ tasks: [{ taskArn: 'task/otel-demo/seed-shop' }] }),
      DescribeTasksCommand: () => {
        reads += 1;
        if (reads === 1) {
          return {
            tasks: [
              {
                lastStatus: 'RUNNING',
                containers: [
                  { name: 'app', lastStatus: 'STOPPED', exitCode: 0 },
                  { name: 'adot', lastStatus: 'RUNNING' },
                ],
              },
            ],
          };
        }
        return stoppedTask(0);
      },
    });
    await seedDeployedServices({
      ecs: ecs.client,
      targets: AWS_SEED_TARGETS.slice(0, 1),
      sleep: async () => {},
      now: () => 0,
      timeoutMs: 1_000,
    });
    expect(ecs.calls.map((call) => call.name)).toContain('StopTaskCommand');
    const stop = ecs.calls.find((call) => call.name === 'StopTaskCommand');
    expect(stop?.input).toMatchObject({ cluster: 'otel-demo', task: 'task/otel-demo/seed-shop' });
  });

  it('reports a non-zero exit and a task that does not finish', async () => {
    const failed = recordingClient({
      DescribeServicesCommand: servicePage,
      RunTaskCommand: () => ({ tasks: [{ taskArn: 'task/otel-demo/seed-shop' }] }),
      DescribeTasksCommand: () => ({
        tasks: [
          {
            lastStatus: 'STOPPED',
            stoppedReason: `failed ${'4'.repeat(12)}`,
            containers: [{ name: 'app', lastStatus: 'STOPPED', exitCode: 1 }],
          },
        ],
      }),
    });
    await expect(
      seedDeployedServices({
        ecs: failed.client,
        targets: AWS_SEED_TARGETS.slice(0, 1),
        sleep: async () => {},
        now: () => 0,
      }),
    ).rejects.toThrow(/otel-demo-shop seed task exited 1: failed \[redacted-account\]/);

    let clock = 0;
    const hung = recordingClient({
      DescribeServicesCommand: servicePage,
      RunTaskCommand: () => ({ tasks: [{ taskArn: 'task/otel-demo/seed-shop' }] }),
      DescribeTasksCommand: () => ({
        tasks: [{ lastStatus: 'PENDING', containers: [] }],
      }),
    });
    await expect(
      seedDeployedServices({
        ecs: hung.client,
        targets: AWS_SEED_TARGETS.slice(0, 1),
        sleep: async () => {},
        now: () => {
          clock += 1;
          return clock;
        },
        timeoutMs: 2,
        pollMs: 1,
      }),
    ).rejects.toThrow(/did not finish/);
    expect(hung.calls.some((call) => call.name === 'StopTaskCommand')).toBe(true);
  });

  it('fails closed when the service has no network or task', async () => {
    const missing = recordingClient({
      DescribeServicesCommand: () => ({ services: [] }),
    });
    await expect(
      seedDeployedServices({
        ecs: missing.client,
        targets: AWS_SEED_TARGETS.slice(0, 1),
        sleep: async () => {},
        now: () => 0,
      }),
    ).rejects.toThrow(/otel-demo-shop is not active/);

    const noNetwork = recordingClient({
      DescribeServicesCommand: () => ({
        services: [
          { serviceName: 'otel-demo-shop', status: 'ACTIVE', taskDefinition: 'family/shop' },
        ],
      }),
    });
    await expect(
      seedDeployedServices({
        ecs: noNetwork.client,
        targets: AWS_SEED_TARGETS.slice(0, 1),
        sleep: async () => {},
        now: () => 0,
      }),
    ).rejects.toThrow(/no task network/);
    expect(noNetwork.calls.some((call) => call.name === 'RunTaskCommand')).toBe(false);
  });
});
