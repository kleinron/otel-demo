import { createClients } from '../infra/aws/src/clients.js';
import { resolveRegion } from '../infra/aws/src/config.js';
import { safeError } from '../infra/aws/src/redact.js';
import { seedDeployedServices } from '../infra/aws/src/seed-task.js';

try {
  const region = resolveRegion(undefined, process.env);
  const clients = createClients(region, region);
  process.stdout.write('payment and delivery migrate when their tasks start\n');
  await seedDeployedServices({
    ecs: clients.ecs,
    onSeeded(serviceName) {
      process.stdout.write(`seeded ${serviceName}\n`);
    },
  });
} catch (error) {
  process.stderr.write(`${safeError(error)}\n`);
  process.exit(1);
}
