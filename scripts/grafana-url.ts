import { createClients } from '../infra/aws/src/clients.js';
import { resolveRegion } from '../infra/aws/src/config.js';
import { lookupGrafanaUrl } from '../infra/aws/src/grafana-url.js';
import { safeError } from '../infra/aws/src/redact.js';

try {
  const region = resolveRegion(undefined, process.env);
  const clients = createClients(region, region);
  const url = await lookupGrafanaUrl(clients);
  process.stdout.write(`${url}\n`);
} catch (error) {
  process.stderr.write(`${safeError(error)}\n`);
  process.exit(1);
}
