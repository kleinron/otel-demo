import { DescribeNetworkInterfacesCommand } from '@aws-sdk/client-ec2';
import { DescribeTasksCommand, ListTasksCommand } from '@aws-sdk/client-ecs';
import { CLUSTER_NAME, GRAFANA_PORT, GRAFANA_SERVICE_NAME } from './names.js';
import { asArray, asRecord, asString } from './text.js';
import type { SdkClient } from './types.js';

/** Current Grafana address. The task address changes on restart, so this is looked up, not stored. */
export function grafanaUrl(address: string): string {
  return `http://${address}:${GRAFANA_PORT}`;
}

export async function lookupGrafanaUrl(input: {
  ecs: SdkClient;
  ec2: SdkClient;
  cluster?: string;
  service?: string;
}): Promise<string> {
  const cluster = input.cluster ?? CLUSTER_NAME;
  const service = input.service ?? GRAFANA_SERVICE_NAME;
  const listed = asRecord(
    await input.ecs.send(
      new ListTasksCommand({ cluster, serviceName: service, desiredStatus: 'RUNNING' }),
    ),
  );
  const taskArns = asArray(listed.taskArns).filter(
    (item): item is string => typeof item === 'string',
  );
  if (taskArns.length === 0) {
    throw new Error('no running Grafana task');
  }
  const described = asRecord(
    await input.ecs.send(new DescribeTasksCommand({ cluster, tasks: taskArns.slice(0, 1) })),
  );
  const eni = networkInterfaceId(asArray(described.tasks)[0]);
  if (!eni) {
    throw new Error('Grafana task has no network interface');
  }
  const interfaces = asRecord(
    await input.ec2.send(new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [eni] })),
  );
  const address = publicAddress(asArray(interfaces.NetworkInterfaces)[0]);
  if (!address) {
    throw new Error('Grafana task has no public address');
  }
  return grafanaUrl(address);
}

function networkInterfaceId(task: unknown): string | undefined {
  for (const attachment of asArray(asRecord(task).attachments)) {
    for (const detail of asArray(asRecord(attachment).details)) {
      const record = asRecord(detail);
      if (asString(record.name) === 'networkInterfaceId') {
        return asString(record.value);
      }
    }
  }
  return undefined;
}

function publicAddress(nic: unknown): string | undefined {
  return asString(asRecord(asRecord(nic).Association).PublicIp);
}
