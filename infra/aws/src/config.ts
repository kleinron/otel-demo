import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BUDGETS_REGION, DEFAULT_REGION, EXPERIMENT_NAME } from './tags.js';

export const DEFAULT_LOG_GROUPS = [
  `/otel-demo/shop`,
  `/otel-demo/inventory`,
  `/otel-demo/payment`,
  `/otel-demo/delivery`,
  `/otel-demo/loadgen`,
  `/otel-demo/alerts`,
  `/otel-demo/grafana`,
] as const;

const REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d+$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

export interface SafetyConfig {
  region: string;
  budgetsRegion: string;
  hardStopUtc?: string;
  runId?: string;
  loadProfile?: string;
  startedAt?: string;
  endedAt?: string;
  databaseTimeouts: 'on' | 'off';
  paymentDelays: 'on' | 'off';
  logGroups: string[];
  /** Set to 0 only when the run recorded zero checkouts. */
  checkoutCount?: number;
  dbEngine: string;
  dbInstanceClass: string;
  requiredDbInstances: number;
  requiredVpcs: number;
  resultsRoot: string;
  repoRoot: string;
  alertsPath: string;
  cdkAppPresent: boolean;
  infraDir: string;
}

export function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'observability', 'alerts.yml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error('repo root not found from ' + start);
}

export function defaultRepoRoot(): string {
  return findRepoRoot(dirname(fileURLToPath(import.meta.url)));
}

export function assertRegion(region: string): string {
  if (!REGION_PATTERN.test(region)) {
    throw new Error(`region must look like ${DEFAULT_REGION}`);
  }
  return region;
}

export function resolveRegion(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  const selected = flag ?? env.EXPERIMENT_REGION ?? env.AWS_REGION ?? DEFAULT_REGION;
  return assertRegion(selected.trim());
}

export function assertSafeRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error('run id must be a short safe token');
  }
  return runId;
}

export function defaultRunId(now: Date): string {
  return `run-${now.toISOString().replace(/[:.]/g, '')}`;
}

function checkoutCount(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('EXPERIMENT_CHECKOUT_COUNT must be a non-negative integer');
  }
  return parsed;
}

function onOff(value: string | undefined, name: string): 'on' | 'off' {
  if (value === undefined || value.trim() === '') {
    return 'off';
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'on' || normalized === 'true') {
    return 'on';
  }
  if (normalized === 'off' || normalized === 'false') {
    return 'off';
  }
  throw new Error(`${name} must be on or off`);
}

export function loadConfig(
  env: NodeJS.ProcessEnv,
  options: { region?: string; runId?: string; repoRoot?: string; resultsRoot?: string } = {},
): SafetyConfig {
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const region = resolveRegion(options.region, env);
  const budgetsRegion = assertRegion((env.BUDGETS_REGION ?? DEFAULT_BUDGETS_REGION).trim());
  const logGroups = (env.EXPERIMENT_LOG_GROUPS ?? '')
    .split(',')
    .map((group) => group.trim())
    .filter((group) => group.length > 0);
  const runIdRaw = options.runId ?? env.EXPERIMENT_RUN_ID;
  return {
    region,
    budgetsRegion,
    hardStopUtc: env.EXPERIMENT_HARD_STOP_UTC,
    runId: runIdRaw ? assertSafeRunId(runIdRaw.trim()) : undefined,
    loadProfile: env.EXPERIMENT_LOAD_PROFILE?.trim() || undefined,
    startedAt: env.EXPERIMENT_STARTED_AT?.trim() || undefined,
    endedAt: env.EXPERIMENT_ENDED_AT?.trim() || undefined,
    databaseTimeouts: onOff(env.EXPERIMENT_DATABASE_TIMEOUTS, 'EXPERIMENT_DATABASE_TIMEOUTS'),
    paymentDelays: onOff(env.EXPERIMENT_PAYMENT_DELAYS, 'EXPERIMENT_PAYMENT_DELAYS'),
    logGroups: logGroups.length > 0 ? logGroups : [...DEFAULT_LOG_GROUPS],
    checkoutCount: checkoutCount(env.EXPERIMENT_CHECKOUT_COUNT),
    dbEngine: env.EXPERIMENT_DB_ENGINE?.trim() || 'postgres',
    dbInstanceClass: 'db.t4g.micro',
    requiredDbInstances: 4,
    requiredVpcs: 1,
    resultsRoot: options.resultsRoot ?? env.EXPERIMENT_RESULTS_DIR ?? join(repoRoot, 'results'),
    repoRoot,
    alertsPath: join(repoRoot, 'observability', 'alerts.yml'),
    cdkAppPresent: existsSync(join(repoRoot, 'infra', 'aws', 'cdk.json')),
    infraDir: join(repoRoot, 'infra', 'aws'),
  };
}

export function experimentLabel(): string {
  return EXPERIMENT_NAME;
}
