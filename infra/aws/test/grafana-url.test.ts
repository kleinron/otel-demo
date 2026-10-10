import { describe, expect, it } from 'vitest';
import { grafanaUrl, lookupGrafanaUrl } from '../src/grafana-url.js';
import { recordingClient } from './aws-mock.js';

const PUBLIC = ['203', '0', '113', '10'].join('.');
const PRIVATE = ['10', '1', '2', '3'].join('.');

describe('grafana url', () => {
  it('prints the running task public address on port 3000', async () => {
    const ecs = recordingClient({
      ListTasksCommand: () => ({ taskArns: ['task/otel-demo/task-grafana'] }),
      DescribeTasksCommand: (input) => {
        expect(input.cluster).toBe('otel-demo');
        expect(input.tasks).toEqual(['task/otel-demo/task-grafana']);
        return {
          tasks: [
            {
              attachments: [
                {
                  details: [
                    { name: 'privateIPv4Address', value: PRIVATE },
                    { name: 'networkInterfaceId', value: 'eni-grafana' },
                  ],
                },
              ],
            },
          ],
        };
      },
    });
    const ec2 = recordingClient({
      DescribeNetworkInterfacesCommand: (input) => {
        expect(input.NetworkInterfaceIds).toEqual(['eni-grafana']);
        return { NetworkInterfaces: [{ Association: { PublicIp: PUBLIC } }] };
      },
    });

    const url = await lookupGrafanaUrl({ ecs: ecs.client, ec2: ec2.client });
    expect(url).toBe(grafanaUrl(PUBLIC));
    expect(url.startsWith('http://')).toBe(true);
    expect(url.endsWith(':3000')).toBe(true);
    expect(url).not.toContain(PRIVATE);
    expect(ecs.calls.map((call) => call.name)).toEqual([
      'ListTasksCommand',
      'DescribeTasksCommand',
    ]);
  });

  it('fails when the task is not running or has no public address', async () => {
    const empty = recordingClient({ ListTasksCommand: () => ({ taskArns: [] }) });
    await expect(
      lookupGrafanaUrl({ ecs: empty.client, ec2: recordingClient().client }),
    ).rejects.toThrow(/no running Grafana task/);

    const ecs = recordingClient({
      ListTasksCommand: () => ({ taskArns: ['task/otel-demo/task-grafana'] }),
      DescribeTasksCommand: () => ({
        tasks: [
          {
            attachments: [{ details: [{ name: 'networkInterfaceId', value: 'eni-grafana' }] }],
          },
        ],
      }),
    });
    const ec2 = recordingClient({
      DescribeNetworkInterfacesCommand: () => ({ NetworkInterfaces: [{ Association: {} }] }),
    });
    await expect(lookupGrafanaUrl({ ecs: ecs.client, ec2: ec2.client })).rejects.toThrow(
      /no public address/,
    );
  });
});
