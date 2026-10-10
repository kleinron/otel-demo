import { describe, expect, it } from 'vitest';
import { CLUSTER_NAME, LOADGEN_SERVICE_NAME } from '../src/names.js';
import { setServiceDesiredCount } from '../src/scale-service.js';
import { recordingClient } from './aws-mock.js';

describe('service desired count', () => {
  it('sets the load generator to 1 or 0 by service name', async () => {
    for (const desiredCount of [1, 0]) {
      const ecs = recordingClient({ UpdateServiceCommand: () => ({}) });
      await setServiceDesiredCount({
        ecs: ecs.client,
        serviceName: LOADGEN_SERVICE_NAME,
        desiredCount,
      });
      expect(ecs.calls).toEqual([
        {
          name: 'UpdateServiceCommand',
          input: { cluster: CLUSTER_NAME, service: 'otel-demo-loadgen', desiredCount },
        },
      ]);
    }
  });

  it('rejects a count other than 0 or 1 before calling AWS', async () => {
    const ecs = recordingClient();
    await expect(
      setServiceDesiredCount({
        ecs: ecs.client,
        serviceName: LOADGEN_SERVICE_NAME,
        desiredCount: 2,
      }),
    ).rejects.toThrow(/0 or 1/);
    expect(ecs.calls).toEqual([]);
  });
});
