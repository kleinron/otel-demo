import { createClients } from '../infra/aws/src/clients.js';
import { resolveRegion } from '../infra/aws/src/config.js';
import { safeError } from '../infra/aws/src/redact.js';
import { restockDeployedInventory } from '../infra/aws/src/seed-task.js';

try {
  const region = resolveRegion(undefined, process.env);
  const clients = createClients(region, region);
  await restockDeployedInventory({
    ecs: clients.ecs,
    onSeeded(serviceName) {
      process.stdout.write(`restocked ${serviceName}\n`);
    },
  });
} catch (error) {
  process.stderr.write(`${safeError(error)}\n`);
  process.exit(1);
}
