import { createClients } from '../infra/aws/src/clients.js';
import { resolveRegion } from '../infra/aws/src/config.js';
import { LOADGEN_SERVICE_NAME } from '../infra/aws/src/names.js';
import { safeError } from '../infra/aws/src/redact.js';
import { setServiceDesiredCount } from '../infra/aws/src/scale-service.js';

const raw = process.argv[2];
if (raw !== '0' && raw !== '1') {
  process.stderr.write('usage: loadgen-scale.ts 0|1\n');
  process.exit(1);
}

try {
  const region = resolveRegion(undefined, process.env);
  const clients = createClients(region, region);
  const desiredCount = raw === '1' ? 1 : 0;
  await setServiceDesiredCount({
    ecs: clients.ecs,
    serviceName: LOADGEN_SERVICE_NAME,
    desiredCount,
  });
  process.stdout.write(`${LOADGEN_SERVICE_NAME} desired count ${desiredCount}\n`);
} catch (error) {
  process.stderr.write(`${safeError(error)}\n`);
  process.exit(1);
}
