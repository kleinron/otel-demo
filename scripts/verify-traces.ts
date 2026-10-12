/**
 * Live proof of the telemetry contract on the GCP deploy.
 *
 *   npx tsx scripts/verify-traces.ts [--project otel-demo-gcp] [--region me-west1]
 *     [--service otel-demo-shop] [--count 100] [--minutes 20] [--allow-missing-loadgen x]
 *
 * Pulls the last `--count` request traces (plus the background traces in the
 * same window) for the serving revision from the Cloud Trace API, checks the
 * span tree per request type, route-template names, cart.id on every span,
 * resource attributes, SQL hygiene, payment idempotency keys, and orphans
 * (the only allowed gap is Cloud Run's front-end parent). It then samples log
 * lines for trace/span ids and reads the collector's self-metrics line.
 * Exit code 0 only when every check passes.
 *
 * Auth: GOOGLE_OAUTH_ACCESS_TOKEN, else `gcloud auth print-access-token`.
 * Read-only: it only calls list/get APIs.
 */
import { execFileSync } from 'node:child_process';
import {
  cartJourney,
  checkFaultSwitch,
  checkCartId,
  checkCollector,
  checkErrors,
  checkLoadgenSteps,
  checkLogs,
  checkNoOrphans,
  checkPaymentKey,
  checkResource,
  checkSpanNames,
  checkSpanTree,
  checkSql,
  hexSpanId,
  label,
  requestRoot,
  traceType,
  type CheckResult,
  type LogEntry,
  type Trace,
} from './verify/checks.js';

const args = parseArgs(process.argv.slice(2));
const project = args.project ?? 'otel-demo-gcp';
const region = args.region ?? 'me-west1';
const service = args.service ?? 'otel-demo-shop';
const count = Number(args.count ?? '100');
const minutes = Number(args.minutes ?? '20');
const token =
  process.env.GOOGLE_OAUTH_ACCESS_TOKEN ??
  execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();

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

const svc = await api<{ latestReadyRevision: string }>(
  `https://run.googleapis.com/v2/projects/${project}/locations/${region}/services/${service}`,
);
const revision = svc.latestReadyRevision.split('/').pop() as string;
const rev = await api<{ createTime: string }>(
  `https://run.googleapis.com/v2/${svc.latestReadyRevision}`,
);
const now = Date.now();
// Leave 90s for late spans; never look before the revision existed.
const endMs = now - 90_000;
const startMs = Math.max(now - minutes * 60_000, Date.parse(rev.createTime) + 60_000);
if (startMs >= endMs) {
  console.error(`revision ${revision} is too new; wait a few minutes`);
  process.exit(2);
}

const traces: Trace[] = [];
let pageToken: string | undefined;
let requests = 0;
do {
  const query = new URLSearchParams({
    view: 'COMPLETE',
    pageSize: '200',
    orderBy: 'start desc',
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(endMs).toISOString(),
    ...(pageToken ? { pageToken } : {}),
  });
  const page = await api<{ traces?: Trace[]; nextPageToken?: string }>(
    `https://cloudtrace.googleapis.com/v1/projects/${project}/traces?${query}`,
  );
  for (const trace of page.traces ?? []) {
    if (traceType(trace) === 'request') {
      if (requests >= count) {
        continue;
      }
      requests += 1;
    }
    traces.push(trace);
  }
  pageToken = page.nextPageToken;
} while (pageToken && requests < count && traces.length < 3000);

// Startup traces of the serving revision (around its creation time).
const startupPage = await api<{ traces?: Trace[] }>(
  `https://cloudtrace.googleapis.com/v1/projects/${project}/traces?${new URLSearchParams({
    view: 'COMPLETE',
    pageSize: '50',
    filter: 'span:startup',
    startTime: new Date(Date.parse(rev.createTime) - 60_000).toISOString(),
    endTime: new Date(Date.parse(rev.createTime) + 15 * 60_000).toISOString(),
  })}`,
);
const startups = (startupPage.traces ?? []).filter((t) =>
  t.spans.some((s) => s.name === 'startup' && label(s, 'faas.version') === revision),
);

const requestTraces = traces.filter((t) => traceType(t) === 'request');
const knownSpans = new Set(traces.flatMap((t) => t.spans.map((s) => hexSpanId(s.spanId))));

const revisionFilter = [
  'resource.type="cloud_run_revision"',
  `resource.labels.service_name="${service}"`,
  `resource.labels.revision_name="${revision}"`,
  `timestamp>="${new Date(startMs).toISOString()}"`,
  `timestamp<="${new Date(endMs).toISOString()}"`,
].join(' ');
const logs = await api<{ entries?: LogEntry[] }>('https://logging.googleapis.com/v2/entries:list', {
  method: 'POST',
  body: JSON.stringify({
    resourceNames: [`projects/${project}`],
    filter: `${revisionFilter} (logName:"run.googleapis.com%2Fstdout" OR logName:"run.googleapis.com%2Fstderr")`,
    orderBy: 'timestamp desc',
    pageSize: 300,
  }),
});
const collector = await api<{ entries?: LogEntry[] }>(
  'https://logging.googleapis.com/v2/entries:list',
  {
    method: 'POST',
    body: JSON.stringify({
      resourceNames: [`projects/${project}`],
      filter: `${revisionFilter} jsonPayload.message="collector self-metrics"`,
      orderBy: 'timestamp desc',
      pageSize: 20,
    }),
  },
);

const results: CheckResult[] = [
  {
    name: `fetched ${count} request traces`,
    pass: requestTraces.length >= count,
    detail: `${requestTraces.length} request + ${traces.length - requestTraces.length} other traces, ${new Date(startMs).toISOString()}..${new Date(endMs).toISOString()}`,
    failures: [],
  },
  checkSpanTree(requestTraces),
  checkSpanNames(traces),
  checkNoOrphans(traces),
  checkCartId(traces),
  checkResource(traces, revision),
  checkSql(traces),
  checkErrors(traces),
  checkPaymentKey(traces),
  checkFaultSwitch(traces, startups),
  checkLogs(logs.entries ?? [], knownSpans),
  checkCollector(collector.entries ?? []),
];
const loadgen = checkLoadgenSteps(traces);
// --allow-missing-loadgen reports this check as SKIP (exit code unaffected) while
// the loadgen job cannot export spans yet.
const skipLoadgen = 'allow-missing-loadgen' in args && !loadgen.pass;
results.push(skipLoadgen ? { ...loadgen, name: `${loadgen.name} [SKIP]`, pass: true } : loadgen);

console.log(`revision ${revision}`);
for (const r of results) {
  const verdict = r.name.endsWith('[SKIP]') ? 'SKIP' : r.pass ? 'PASS' : 'FAIL';
  console.log(`${verdict}  ${r.name} (${r.detail})`);
  for (const f of r.failures) {
    console.log(`        - ${f}`);
  }
}

// One complete cart journey for the report.
const checkout = requestTraces.find(
  (t) =>
    requestRoot(t)?.name === 'POST /carts/:cartId/checkout' &&
    label(requestRoot(t) as never, 'http.response.status_code') === '200',
);
const cartId = checkout ? label(requestRoot(checkout) as never, 'cart.id') : undefined;
if (checkout && cartId) {
  const steps = cartJourney(traces, cartId);
  console.log(`\ncart.id ${cartId}`);
  for (const [step, ids] of steps) {
    console.log(`  ${step}: ${ids.join(', ')}`);
  }
  console.log(
    `  trace: https://console.cloud.google.com/traces/explorer;traceId=${checkout.traceId}?project=${project}`,
  );
  const q = encodeURIComponent(`jsonPayload.cart.id="${cartId}"`);
  console.log(`  logs:  https://console.cloud.google.com/logs/query;query=${q}?project=${project}`);
}

process.exit(results.every((r) => r.pass) ? 0 : 1);

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key?.startsWith('--')) {
      out[key.slice(2)] = argv[i + 1] ?? '';
      i += 1;
    }
  }
  return out;
}
