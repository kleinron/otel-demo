/**
 * Pure checks for scripts/verify-traces.ts, over Cloud Trace v1 traces
 * (`view=COMPLETE`) and Cloud Logging entries. No network here, so tests can
 * feed fixtures.
 */
export interface TraceSpan {
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: string;
  startTime?: string;
  endTime?: string;
  labels?: Record<string, string>;
}

export interface Trace {
  traceId: string;
  spans: TraceSpan[];
}

export interface LogEntry {
  trace?: string;
  spanId?: string;
  labels?: Record<string, string>;
  timestamp?: string;
  resource?: { labels?: Record<string, string> };
  jsonPayload?: Record<string, unknown>;
  textPayload?: string;
}

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
  failures: string[];
}

const HEALTH_ROUTES = new Set(['/health', '/ready']);
const TEMPLATE_NAME = /^(GET|POST|PUT|PATCH|DELETE) (\/[A-Za-z0-9_\-/:.]*)$/;
const RAW_SEGMENT = /\/(?:[0-9a-f]{8}-[0-9a-f]{4}-|lg-|\d+(?:\/|$))/i;
const CART_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TX_CONTROL = new Set(['BEGIN', 'COMMIT', 'ROLLBACK']);

/** Cloud Run front-end / load balancer spans, written by Google, not by our SDK. */
export function isInfraSpan(span: TraceSpan): boolean {
  const labels = span.labels ?? {};
  return labels['/component'] !== undefined || labels['service.name'] === undefined;
}

export function label(span: TraceSpan, key: string): string | undefined {
  return span.labels?.[key];
}

const isServer = (s: TraceSpan) => s.kind === 'RPC_SERVER';
const isHttpClient = (s: TraceSpan) =>
  s.kind === 'RPC_CLIENT' && label(s, 'url.template') !== undefined;
const isDbQuery = (s: TraceSpan) =>
  label(s, 'db.system.name') !== undefined && label(s, 'db.query.text') !== undefined;

export function appSpans(trace: Trace): TraceSpan[] {
  return trace.spans.filter((s) => !isInfraSpan(s));
}

/** The shop's inbound SERVER span: the request type of a trace. */
export function requestRoot(trace: Trace): TraceSpan | undefined {
  return trace.spans.find(
    (s) => !isInfraSpan(s) && isServer(s) && label(s, 'service.name') === 'shop',
  );
}

export type TraceType = 'request' | 'health' | 'background' | 'loadgen' | 'infra-only';

export function traceType(trace: Trace): TraceType {
  const app = appSpans(trace);
  if (app.length === 0) {
    return 'infra-only';
  }
  const root = requestRoot(trace);
  if (root) {
    return HEALTH_ROUTES.has(label(root, 'http.route') ?? '') ? 'health' : 'request';
  }
  if (app.some((s) => label(s, 'service.name') === 'loadgen')) {
    return 'loadgen';
  }
  const server = app.find(isServer);
  if (server && HEALTH_ROUTES.has(label(server, 'http.route') ?? '')) {
    return 'health';
  }
  return 'background';
}

function children(trace: Trace, span: TraceSpan): TraceSpan[] {
  return trace.spans.filter((s) => s.parentSpanId === span.spanId);
}

function descendants(trace: Trace, span: TraceSpan): TraceSpan[] {
  const out: TraceSpan[] = [];
  const queue = [span];
  while (queue.length > 0) {
    const next = queue.shift() as TraceSpan;
    for (const child of children(trace, next)) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

function ancestors(trace: Trace, span: TraceSpan): TraceSpan[] {
  const byId = new Map(trace.spans.map((s) => [s.spanId, s]));
  const out: TraceSpan[] = [];
  let parent = span.parentSpanId ? byId.get(span.parentSpanId) : undefined;
  while (parent && out.length < 100) {
    out.push(parent);
    parent = parent.parentSpanId ? byId.get(parent.parentSpanId) : undefined;
  }
  return out;
}

function result(name: string, failures: string[], detail: string): CheckResult {
  return { name, pass: failures.length === 0, detail, failures: failures.slice(0, 10) };
}

function where(trace: Trace, span?: TraceSpan): string {
  return span ? `${trace.traceId}/${span.spanId} "${span.name}"` : trace.traceId;
}

/** Expected client hops per shop route (on a 2xx response). */
const EXPECTED_HOPS: Record<string, string[]> = {
  'POST /carts': [],
  'GET /carts/:cartId': [],
  'POST /carts/:cartId/items': ['GET /skus/:sku'],
  'DELETE /carts/:cartId/items/:sku': [],
  'POST /carts/:cartId/checkout': [
    'POST /reservations',
    'POST /charges',
    'POST /charges/:orderId/capture',
    'POST /handoffs',
  ],
  'GET /orders/:orderId': [],
};

export function checkSpanTree(traces: Trace[]): CheckResult {
  const failures: string[] = [];
  const seen = new Map<string, number>();
  for (const trace of traces) {
    const root = requestRoot(trace);
    if (!root) {
      continue;
    }
    seen.set(root.name, (seen.get(root.name) ?? 0) + 1);
    const status = Number(label(root, 'http.response.status_code') ?? '0');
    const expected = EXPECTED_HOPS[root.name];
    if (expected === undefined) {
      failures.push(`${where(trace, root)}: unexpected shop route`);
      continue;
    }
    const hops = descendants(trace, root).filter(isHttpClient);
    if (status >= 200 && status < 300) {
      for (const hop of expected) {
        if (!hops.some((h) => h.name === hop)) {
          failures.push(`${where(trace, root)}: missing outbound "${hop}"`);
        }
      }
    }
    // Every outbound hop has exactly one matching inbound span in the target service.
    for (const hop of hops) {
      const servers = children(trace, hop).filter(isServer);
      if (servers.length !== 1) {
        failures.push(`${where(trace, hop)}: ${servers.length} inbound spans (want 1)`);
        continue;
      }
      const server = servers[0] as TraceSpan;
      if (
        server.name !== hop.name ||
        label(server, 'service.name') !== label(hop, 'peer.service')
      ) {
        failures.push(`${where(trace, server)}: does not match outbound ${hop.name}`);
      }
    }
    // Every inbound span reaches its database.
    for (const server of [root, ...hops.flatMap((h) => children(trace, h).filter(isServer))]) {
      if (!descendants(trace, server).some(isDbQuery)) {
        failures.push(`${where(trace, server)}: no database span`);
      }
    }
    failures.push(...dbShape(trace));
  }
  const kinds = [...seen.entries()].map(([k, v]) => `${k}=${v}`).join(', ');
  return result('span tree per request type', failures, kinds || 'no request traces');
}

/** Each query outside a transaction has its own pool connect; each transaction is BEGIN..COMMIT/ROLLBACK. */
function dbShape(trace: Trace): string[] {
  const failures: string[] = [];
  for (const span of trace.spans) {
    if (span.name === 'db transaction') {
      const kids = children(trace, span).map((c) => c.name);
      if (!kids.includes('db pool connect') || !kids.includes('BEGIN')) {
        failures.push(`${where(trace, span)}: transaction without connect/BEGIN`);
      }
      if (!kids.includes('COMMIT') && !kids.includes('ROLLBACK')) {
        failures.push(`${where(trace, span)}: transaction without COMMIT/ROLLBACK`);
      }
      continue;
    }
    if (!isDbQuery(span) || TX_CONTROL.has(span.name)) {
      continue;
    }
    const inTx = ancestors(trace, span).some((a) => a.name === 'db transaction');
    if (!inTx && !children(trace, span).some((c) => c.name === 'db pool connect')) {
      failures.push(`${where(trace, span)}: query without its own pool connect span`);
    }
  }
  return failures;
}

export function checkSpanNames(traces: Trace[]): CheckResult {
  const failures: string[] = [];
  let count = 0;
  for (const trace of traces) {
    for (const span of appSpans(trace)) {
      if (!isServer(span) && !isHttpClient(span)) {
        continue;
      }
      count += 1;
      const match = TEMPLATE_NAME.exec(span.name);
      if (!match || RAW_SEGMENT.test(match[2] ?? '')) {
        failures.push(`${where(trace, span)}: not "METHOD /route/template"`);
      }
    }
  }
  return result('HTTP spans named by route template', failures, `${count} http spans`);
}

export function checkNoOrphans(traces: Trace[]): CheckResult {
  const failures: string[] = [];
  let spans = 0;
  for (const trace of traces) {
    const ids = new Set(trace.spans.map((s) => s.spanId));
    for (const span of trace.spans) {
      spans += 1;
      if (span.parentSpanId && !ids.has(span.parentSpanId)) {
        failures.push(`${where(trace, span)}: parent ${span.parentSpanId} missing`);
      }
    }
  }
  return result('zero orphan spans', failures, `${spans} spans, no allowed gaps`);
}

export function checkCartId(traces: Trace[]): CheckResult {
  const failures: string[] = [];
  let spans = 0;
  for (const trace of traces) {
    if (traceType(trace) !== 'request' && traceType(trace) !== 'loadgen') {
      continue;
    }
    const values = new Set<string>();
    for (const span of appSpans(trace)) {
      spans += 1;
      const value = label(span, 'cart.id');
      if (!value || !CART_UUID.test(value)) {
        failures.push(`${where(trace, span)}: cart.id missing`);
      } else {
        values.add(value);
      }
    }
    if (values.size > 1) {
      failures.push(`${trace.traceId}: ${values.size} different cart.id values`);
    }
  }
  return result('cart.id on every span', failures, `${spans} request spans`);
}

export function checkResource(traces: Trace[], revision?: string): CheckResult {
  const failures: string[] = [];
  let spans = 0;
  for (const trace of traces) {
    for (const span of appSpans(trace)) {
      spans += 1;
      // The loadgen is a Cloud Run job, not a revision: no faas.version / faas.instance.
      const keys =
        label(span, 'service.name') === 'loadgen'
          ? ['service.name', 'service.version']
          : ['service.name', 'service.version', 'faas.version', 'faas.instance'];
      for (const key of keys) {
        if (!label(span, key)) {
          failures.push(`${where(trace, span)}: ${key} missing`);
        }
      }
      const spanRevision = label(span, 'faas.version');
      if (
        revision &&
        spanRevision &&
        spanRevision !== revision &&
        label(span, 'service.name') !== 'loadgen'
      ) {
        failures.push(`${where(trace, span)}: revision ${spanRevision} != ${revision}`);
      }
    }
  }
  return result('resource attributes', failures, `${spans} spans`);
}

export function checkSql(traces: Trace[]): CheckResult {
  const failures: string[] = [];
  let queries = 0;
  for (const trace of traces) {
    for (const span of trace.spans) {
      for (const key of Object.keys(span.labels ?? {})) {
        if (/^db\.(query\.parameter|statement\.param)/.test(key)) {
          failures.push(`${where(trace, span)}: records ${key}`);
        }
      }
      const text = label(span, 'db.query.text');
      if (text === undefined) {
        continue;
      }
      queries += 1;
      if (/'(?!\?')[^']*'/.test(text)) {
        failures.push(`${where(trace, span)}: literal value in db.query.text`);
      }
    }
  }
  return result('one span per query, no SQL parameter values', failures, `${queries} query spans`);
}

export function checkErrors(traces: Trace[]): CheckResult {
  const failures: string[] = [];
  let errors = 0;
  for (const trace of traces) {
    for (const span of appSpans(trace)) {
      const status = Number(label(span, 'http.response.status_code') ?? '0');
      if (status >= 500) {
        errors += 1;
        if (!label(span, 'error.type')) {
          failures.push(`${where(trace, span)}: HTTP ${status} without error.type`);
        }
      }
    }
  }
  return result('5xx spans marked as errors', failures, `${errors} 5xx spans`);
}

export function checkPaymentKey(traces: Trace[]): CheckResult {
  const failures: string[] = [];
  let spans = 0;
  for (const trace of traces) {
    if (traceType(trace) !== 'request') {
      continue;
    }
    for (const span of appSpans(trace)) {
      const toPayment = label(span, 'peer.service') === 'payment';
      if (label(span, 'service.name') !== 'payment' && !toPayment) {
        continue;
      }
      spans += 1;
      if (!label(span, 'payment.idempotency_key')) {
        failures.push(`${where(trace, span)}: payment.idempotency_key missing`);
      }
    }
  }
  return result('payment spans carry the idempotency key', failures, `${spans} payment spans`);
}

/**
 * The fault switch is traced only at startup: each service's `startup` trace
 * holds a `fault-switch read` with its Secret Manager read. Background polls
 * export nothing (a `fault-switch change` root appears only when the value flips).
 */
export function checkFaultSwitch(traces: Trace[], startups: Trace[]): CheckResult {
  const failures: string[] = [];
  for (const trace of traces) {
    for (const span of trace.spans) {
      if (span.name === 'fault-switch poll') {
        failures.push(`${where(trace, span)}: background poll span exported`);
      }
      if (
        (span.name === 'fault-switch read' || span.name === 'secretmanager AccessSecretVersion') &&
        !trace.spans.some((s) => s.name === 'startup')
      ) {
        failures.push(`${where(trace, span)}: switch read traced outside startup`);
      }
    }
  }
  const services = new Set<string>();
  for (const trace of startups) {
    const startup = trace.spans.find((s) => s.name === 'startup');
    if (!startup) {
      continue;
    }
    const names = descendants(trace, startup).map((s) => s.name);
    if (
      !names.includes('fault-switch read') ||
      !names.includes('secretmanager AccessSecretVersion')
    ) {
      failures.push(`${where(trace, startup)}: startup without switch / Secret Manager read`);
    }
    services.add(label(startup, 'service.name') ?? '?');
  }
  for (const service of ['shop', 'inventory', 'payment', 'delivery']) {
    if (!services.has(service)) {
      failures.push(`no startup trace for ${service}`);
    }
  }
  return result(
    'fault switch: startup read traced, polls untraced',
    failures,
    `startup traces: ${[...services].sort().join(', ') || 'none'}`,
  );
}

export function checkLogs(entries: LogEntry[], knownSpans?: Set<string>): CheckResult {
  const failures: string[] = [];
  let linked = 0;
  for (const entry of entries) {
    const message = String(entry.jsonPayload?.message ?? entry.textPayload ?? '').slice(0, 60);
    const container = entry.labels?.container_name ?? '?';
    if (!entry.trace || !/^projects\/[^/]+\/traces\/[0-9a-f]{32}$/.test(entry.trace)) {
      failures.push(`${container} "${message}": no logging.googleapis.com/trace`);
      continue;
    }
    if (!entry.spanId || !/^[0-9a-f]{16}$/.test(entry.spanId)) {
      failures.push(`${container} "${message}": no logging.googleapis.com/spanId`);
      continue;
    }
    if (knownSpans?.has(entry.spanId)) {
      linked += 1;
    }
  }
  if (knownSpans && entries.length > 0 && linked === 0) {
    failures.push('no log spanId matched a fetched span');
  }
  return result(
    'log lines carry trace and span ids',
    failures,
    `${entries.length} lines${knownSpans ? `, ${linked} matched to a fetched span` : ''}`,
  );
}

const COLLECTOR_FAIL_KEYS = [
  'sendFailedSpans',
  'enqueueFailedSpans',
  'refusedSpans',
  'failedSpans',
  'droppedSpans',
] as const;

/**
 * Collector failure counters are cumulative per collector process, so a
 * lifetime value > 0 says nothing about the checked window. Per instance, take
 * the counter at the window start (last line at or before `startMs`, else the
 * first line in the window) and at the window end (last line), and fail only
 * if it increased. A drop in value means the process restarted, so the end
 * value itself is the increase. `entries` must be sorted by timestamp asc.
 */
export function checkCollector(entries: LogEntry[], startMs?: number): CheckResult {
  const failures: string[] = [];
  const lines: string[] = [];
  if (entries.length === 0) {
    failures.push('no "collector self-metrics" log line');
  }
  const byInstance = new Map<string, LogEntry[]>();
  for (const entry of entries) {
    const id = entry.labels?.instanceId ?? entry.resource?.labels?.instance_id ?? 'default';
    byInstance.set(id, [...(byInstance.get(id) ?? []), entry]);
  }
  for (const [id, list] of byInstance) {
    const atOrBefore =
      startMs === undefined
        ? []
        : list.filter((e) => e.timestamp && Date.parse(e.timestamp) <= startMs);
    const first = atOrBefore.at(-1) ?? list[0];
    const last = list.at(-1);
    const from = first?.jsonPayload?.collector as Record<string, number> | undefined;
    const to = last?.jsonPayload?.collector as Record<string, number> | undefined;
    const short = id.slice(-8);
    for (const key of COLLECTOR_FAIL_KEYS) {
      const a = Number(from?.[key] ?? 0);
      const b = Number(to?.[key] ?? 0);
      const increase = b >= a ? b - a : b;
      lines.push(`${short} ${key} start=${a} end=${b} increase=${increase}`);
      if (increase > 0) {
        failures.push(`instance ${short}: ${key} start=${a} end=${b} increase=${increase}`);
      }
    }
  }
  return result(
    'collector dropped/failed counters did not increase in window',
    [...new Set(failures)],
    lines.length
      ? `${byInstance.size} instance(s), ${entries.length} lines; ${lines.join('; ')}`
      : 'none',
  );
}

/** Steps of one cart journey found across traces, keyed by shop route. */
export function cartJourney(traces: Trace[], cartId: string): Map<string, string[]> {
  const steps = new Map<string, string[]>();
  for (const trace of traces) {
    const root = requestRoot(trace);
    if (root && label(root, 'cart.id') === cartId) {
      steps.set(root.name, [...(steps.get(root.name) ?? []), trace.traceId]);
    }
  }
  return steps;
}

/** Cloud Trace v1 span ids are decimal; Cloud Logging uses 16 hex chars. */
export function hexSpanId(decimal: string): string {
  return BigInt(decimal).toString(16).padStart(16, '0');
}

const LOADGEN_STEPS = ['open-cart', 'browse', 'add-to-cart', 'checkout', 'close'];
const isLoadgenStep = (s: TraceSpan) =>
  label(s, 'service.name') === 'loadgen' && s.name.startsWith('cart ');

/**
 * Each request trace is rooted either at a loadgen step span (`cart <step>`,
 * itself a root) that parents the shop's inbound span, or at a fresh shop
 * root (non-loadgen traffic). Its root carries cart.id. All five steps appear.
 */
export function checkRequestRoots(traces: Trace[]): CheckResult {
  const failures: string[] = [];
  const steps = new Set<string>();
  let loadgenRooted = 0;
  let freshRoots = 0;
  const byId = (trace: Trace) => new Map(trace.spans.map((s) => [s.spanId, s]));
  let retries = 0;
  const allById = new Map(traces.map((t) => [t.traceId, t]));
  for (const trace of traces) {
    const stepSpans = trace.spans.filter(isLoadgenStep);
    if (stepSpans.length > 1) {
      failures.push(`${trace.traceId}: ${stepSpans.length} shopper steps in one trace (want 1)`);
    }
    for (const span of stepSpans) {
      if (
        span.name !== 'cart checkout' ||
        Number(label(span, 'cart.checkout_attempt') ?? '1') <= 1
      ) {
        continue;
      }
      // Retry: own trace, linked to the failed attempt. The v1 read API does not
      // return links, so the link target is mirrored in retry.previous_* attributes.
      retries += 1;
      const previousTrace = label(span, 'retry.previous_trace_id');
      const previousSpan = label(span, 'retry.previous_span_id');
      if (!previousTrace || !previousSpan) {
        failures.push(`${where(trace, span)}: checkout retry without a link to the failed attempt`);
        continue;
      }
      if (previousTrace === trace.traceId) {
        failures.push(`${where(trace, span)}: checkout retry shares the failed attempt's trace`);
      }
      const prior = allById.get(previousTrace);
      if (
        prior &&
        !prior.spans.some((s) => s.name === 'cart checkout' && hexSpanId(s.spanId) === previousSpan)
      ) {
        failures.push(`${where(trace, span)}: linked failed attempt not found in ${previousTrace}`);
      }
    }
    for (const span of trace.spans) {
      if (isLoadgenStep(span)) {
        steps.add(label(span, 'cart.step') ?? span.name.slice(5));
        if (span.parentSpanId) {
          failures.push(`${where(trace, span)}: loadgen step span is not a root`);
        }
      }
    }
    const root = requestRoot(trace);
    if (!root) {
      continue;
    }
    const parent = root.parentSpanId ? byId(trace).get(root.parentSpanId) : undefined;
    let top: TraceSpan | undefined;
    if (!root.parentSpanId) {
      freshRoots += 1;
      top = root;
    } else if (parent && isLoadgenStep(parent) && !parent.parentSpanId) {
      loadgenRooted += 1;
      top = parent;
    } else {
      failures.push(`${where(trace, root)}: not rooted at a loadgen step or a fresh shop root`);
      continue;
    }
    if (!CART_UUID.test(label(top, 'cart.id') ?? '')) {
      failures.push(`${where(trace, top)}: root without cart.id`);
    }
  }
  if (loadgenRooted === 0) {
    failures.push('no request trace rooted at a loadgen step');
  }
  for (const step of LOADGEN_STEPS) {
    if (!steps.has(step)) {
      failures.push(`no "cart ${step}" span`);
    }
  }
  return result(
    'one shopper step per trace, rooted at it (or a fresh shop root), cart.id, retry links',
    failures,
    `${loadgenRooted} loadgen-rooted, ${freshRoots} fresh roots, ${retries} checkout retries; steps: ${[...steps].sort().join(', ')}`,
  );
}
