import { UpdateServiceCommand } from '@aws-sdk/client-ecs';
import { CLUSTER_NAME } from './names.js';
import type { SdkClient } from './types.js';

/** Set an ECS service desired count to 0 or 1. The service is named, never an account id. */
export async function setServiceDesiredCount(input: {
  ecs: SdkClient;
  serviceName: string;
  desiredCount: number;
  cluster?: string;
}): Promise<void> {
  if (input.desiredCount !== 0 && input.desiredCount !== 1) {
    throw new Error('desired count must be 0 or 1');
  }
  await input.ecs.send(
    new UpdateServiceCommand({
      cluster: input.cluster ?? CLUSTER_NAME,
      service: input.serviceName,
      desiredCount: input.desiredCount,
    }),
  );
}
