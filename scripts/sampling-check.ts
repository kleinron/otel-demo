/**
 * 20-of-20 sampling check on the live shop.
 *
 *   npx tsx scripts/sampling-check.ts [--project otel-demo-gcp] [--region me-west1] [--count 20]
 *
 * For each probe: write a parent `cart browse` span (Cloud Trace v2
 * batchWrite), call GET /carts/:cartId with that span in `x-otel-demo-parent`
 * and `traceparent`, both flagged UNSAMPLED (-00), plus cart.id baggage. Then
 * fetch each trace and require the shop's inbound span, parented on the probe
 * span. AlwaysOn means every probe must be recorded despite the flag.
 *
 * Auth: gcloud (access token for Cloud Trace / Run, identity token for the shop).
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((v, i, a) => (v.startsWith('--') ? [[v.slice(2), a[i + 1] ?? '']] : [])),
) as Record<string, string>;
const project = args.project ?? 'otel-demo-gcp';
const region = args.region ?? 'me-west1';
const count = Number(args.count ?? '20');
const gcloud = (...a: string[]) => execFileSync('gcloud', a, { encoding: 'utf8' }).trim();
const token = gcloud('auth', 'print-access-token');
const hex = (bytes: number) => randomBytes(bytes).toString('hex');

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`${response.status} from ${url.split('?')[0]}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

const service = await api<{ uri: string }>(
  `https://run.googleapis.com/v2/projects/${project}/locations/${region}/services/otel-demo-shop`,
);
const idToken = gcloud('auth', 'print-identity-token', `--audiences=${service.uri}`);
const str = (value: string) => ({ stringValue: { value } });

const probes: { traceId: string; spanId: string; status: number }[] = [];
for (let i = 0; i < count; i += 1) {
  const traceId = hex(16);
  const spanId = hex(8);
  const cartId = randomUUID();
  const start = new Date();
  const parent = `00-${traceId}-${spanId}-00`;
  const response = await fetch(`${service.uri}/carts/${randomUUID()}`, {
    headers: {
      authorization: `Bearer ${idToken}`,
      accept: 'application/json',
      traceparent: parent,
      'x-otel-demo-parent': parent,
      baggage: `cart.id=${cartId}`,
    },
  });
  await response.text();
  await api(`https://cloudtrace.googleapis.com/v2/projects/${project}/traces:batchWrite`, {
    method: 'POST',
    body: JSON.stringify({
      spans: [
        {
          name: `projects/${project}/traces/${traceId}/spans/${spanId}`,
          spanId,
          displayName: { value: 'cart browse', truncatedByteCount: 0 },
          startTime: start.toISOString(),
          endTime: new Date().toISOString(),
          spanKind: 'CLIENT',
          attributes: {
            attributeMap: {
              'service.name': str('loadgen'),
              'service.version': str('sampling-check'),
              'cart.id': str(cartId),
              'cart.step': str('browse'),
              'loadgen.probe': str('sampling-check'),
            },
          },
        },
      ],
    }),
  });
  probes.push({ traceId, spanId, status: response.status });
}

await new Promise((resolve) => setTimeout(resolve, 60_000));
let recorded = 0;
for (const probe of probes) {
  const trace = await api<{ spans?: { spanId: string; parentSpanId?: string; name: string }[] }>(
    `https://cloudtrace.googleapis.com/v1/projects/${project}/traces/${probe.traceId}`,
  ).catch(() => ({ spans: [] }));
  const parentDecimal = BigInt(`0x${probe.spanId}`).toString();
  const shop = trace.spans?.find(
    (s) => s.name === 'GET /carts/:cartId' && s.parentSpanId === parentDecimal,
  );
  console.log(`${shop ? 'OK  ' : 'MISS'} ${probe.traceId} HTTP ${probe.status}`);
  if (shop) {
    recorded += 1;
  }
}
console.log(`${recorded}/${probes.length} unsampled-flag probes recorded`);
process.exit(recorded === probes.length ? 0 : 1);
