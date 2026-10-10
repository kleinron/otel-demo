import { join } from 'node:path';
import { defaultRunId, loadConfig, type SafetyConfig } from './config.js';
import { checkCredentials } from './credentials.js';
import { defaultRunProcess, destroyStacks, type RunProcess } from './destroy.js';
import {
  exportRehearsal,
  exportRun,
  readCompletedExport,
  writeExportMissing,
} from './export-run.js';
import { listExperimentResources } from './inventory.js';
import { deleteLeftovers } from './leftovers.js';
import { redactText } from './redact.js';
import { isLeftover } from './retention.js';
import type { SleepOptions, TeardownClients } from './types.js';
import { verifyAccount } from './verify.js';

export interface TeardownResult {
  exitCode: number;
  report: string;
}

export interface TeardownInput {
  env: NodeJS.ProcessEnv;
  region?: string;
  dryRun?: boolean;
  skipExport?: boolean;
  /** Required together with skipExport. A real run writes EXPORT_MISSING and continues. */
  acknowledgeNoExport?: boolean;
  /** Pre-deploy rehearsal exports only this log group, then runs the normal delete path. */
  rehearsal?: { logGroup: string };
  runId?: string;
  now?: Date;
  clients: TeardownClients;
  loadExpiration?: () => Promise<Date | undefined>;
  runProcess?: RunProcess;
  sleep?: (ms: number) => Promise<void>;
  waitAttempts?: number;
  waitIntervalMs?: number;
  repoRoot?: string;
  resultsRoot?: string;
  cdkAppPresent?: boolean;
}

export async function runTeardown(input: TeardownInput): Promise<TeardownResult> {
  const now = input.now ?? new Date();
  const config = loadConfig(input.env, {
    region: input.region,
    runId: input.runId,
    repoRoot: input.repoRoot,
    resultsRoot: input.resultsRoot,
  });
  if (input.cdkAppPresent !== undefined) {
    config.cdkAppPresent = input.cdkAppPresent;
  }
  const dryRun = input.dryRun ?? false;
  const skipExport = input.skipExport ?? false;
  const acknowledgeNoExport = input.acknowledgeNoExport ?? false;
  const wait: SleepOptions = {
    sleep: input.sleep ?? delay,
    waitAttempts: input.waitAttempts ?? 30,
    waitIntervalMs: input.waitIntervalMs ?? 5_000,
  };
  const runProcess = input.runProcess ?? defaultRunProcess;
  const lines: string[] = [dryRun ? 'Teardown dry-run.' : 'Teardown.', `Region: ${config.region}.`];

  const opened = await gate(input, config, now, lines);
  if (!opened.ok) {
    return finish(1, lines);
  }
  let accountId = opened.accountId;

  const runId = config.runId ?? defaultRunId(now);
  if (dryRun) {
    lines.push(
      'Export: skipped in dry-run. A real run exports first and aborts if that export fails.',
    );
  } else if (!(await ensureCredentials(input, config, now, lines))) {
    return finish(1, lines);
  } else if (skipExport !== acknowledgeNoExport) {
    lines.push(
      'Export: --skip-export and --i-understand-no-export must both be set to continue without an export. Nothing was destroyed.',
    );
    return finish(1, lines);
  } else {
    accountId = opened.accountId;
    const exported = await settleExport({
      input,
      config,
      runId,
      accountId,
      skipExport,
      wait,
      lines,
    });
    if (exported === 'abort') {
      return finish(1, lines);
    }
    if (!(await refreshAccount(input, config, now, lines))) {
      return finish(1, lines);
    }
  }

  const destroy = await destroyStacks({
    clients: input.clients,
    region: config.region,
    accountId,
    dryRun,
    cdkAppPresent: config.cdkAppPresent,
    infraDir: config.infraDir,
    runProcess,
    wait,
  });
  lines.push(...destroy.lines);
  if (!dryRun && destroy.stoppedBeforeSweep) {
    return finish(1, lines);
  }
  if (!dryRun && !(await refreshAccount(input, config, now, lines))) {
    return finish(1, lines);
  }

  const leftovers = await deleteLeftovers({
    clients: input.clients,
    region: config.region,
    accountId,
    dryRun,
    wait,
  });
  lines.push(...leftovers.lines);

  if (dryRun) {
    lines.push(
      'VERIFY: skipped in dry-run. A real run exits non-zero if anything tagged or named remains.',
    );
    return finish(0, lines);
  }

  if (!(await refreshAccount(input, config, now, lines))) {
    return finish(1, lines);
  }
  const verified = await verifyAccount({
    clients: input.clients,
    region: config.region,
    accountId,
  });
  lines.push(...verified.lines);
  const failed = !verified.ok || leftovers.errors.length > 0 || !destroy.ok;
  return finish(failed ? 1 : 0, lines);
}

async function settleExport(input: {
  input: TeardownInput;
  config: SafetyConfig;
  runId: string;
  accountId: string;
  skipExport: boolean;
  wait: SleepOptions;
  lines: string[];
}): Promise<'ok' | 'abort'> {
  const directory = join(input.config.resultsRoot, input.runId);
  if (input.input.rehearsal) {
    const exported = await exportRehearsal({
      logs: input.input.clients.logs,
      directory,
      runId: input.runId,
      logGroup: input.input.rehearsal.logGroup,
    });
    if (exported.ok) {
      input.lines.push(
        `Export: EXPORT_OK rehearsal (${exported.files.length} files) for ${input.runId}.`,
      );
      return 'ok';
    }
    input.lines.push(`Export: ABORT. ${exported.reason ?? 'Rehearsal export failed.'}`);
    input.lines.push('cdk destroy was not started.');
    return 'abort';
  }
  if (input.skipExport) {
    await writeExportMissing(
      directory,
      'Export skipped because --skip-export and --i-understand-no-export were both set. This is not a successful export.',
    );
    input.lines.push(
      'Export: skipped by --skip-export and --i-understand-no-export. EXPORT_MISSING written. This is not a successful export.',
    );
    return 'ok';
  }
  if (await readCompletedExport(directory)) {
    input.lines.push(`Export: existing EXPORT_OK for ${input.runId} is complete.`);
    return 'ok';
  }
  const exported = await exportRun({
    clients: input.input.clients,
    config: input.config,
    runId: input.runId,
    sleep: input.wait.sleep,
  });
  if (exported.ok) {
    input.lines.push(`Export: EXPORT_OK (${exported.files.length} files) for ${input.runId}.`);
    return 'ok';
  }
  const stacks = await experimentStacks(input.input.clients, input.config.region, input.accountId);
  if (stacks.length === 0) {
    await writeExportMissing(
      directory,
      'Experiment stacks are already gone and EXPORT_OK was not on disk. Cleanup continues so leftovers do not keep billing. This is not a successful export.',
    );
    input.lines.push(
      `Export: EXPORT_MISSING for ${input.runId}. ${exported.reason ?? 'Export failed.'} Stacks are already gone, so leftover cleanup continues.`,
    );
    return 'ok';
  }
  input.lines.push(`Export: ABORT. ${exported.reason ?? 'Export failed.'}`);
  input.lines.push('cdk destroy was not started.');
  return 'abort';
}

async function experimentStacks(
  clients: TeardownClients,
  region: string,
  accountId: string,
): Promise<string[]> {
  const inventory = await listExperimentResources({ clients, region, accountId });
  return inventory.resources
    .filter((resource) => resource.kind === 'cloudformation-stack' && isLeftover(resource))
    .map((resource) => resource.name);
}

async function gate(
  input: TeardownInput,
  config: SafetyConfig,
  now: Date,
  lines: string[],
): Promise<{ ok: true; accountId: string } | { ok: false }> {
  const expiration = input.loadExpiration ? await input.loadExpiration() : undefined;
  const check = await checkCredentials({
    sts: input.clients.sts,
    now,
    expiration,
    hardStopUtc: config.hardStopUtc,
  });
  lines.push(...check.lines);
  if (!check.ok || !check.accountId) {
    return { ok: false };
  }
  return { ok: true, accountId: check.accountId };
}

async function ensureCredentials(
  input: TeardownInput,
  config: SafetyConfig,
  now: Date,
  lines: string[],
): Promise<boolean> {
  return refreshAccount(input, config, now, lines);
}

async function refreshAccount(
  input: TeardownInput,
  config: SafetyConfig,
  now: Date,
  lines: string[],
): Promise<boolean> {
  const checked = await gate(input, config, now, lines);
  return checked.ok;
}

function finish(exitCode: number, lines: string[]): TeardownResult {
  return { exitCode, report: redactText(lines.join('\n')) };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export { defaultRunProcess };
