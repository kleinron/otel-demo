import { createClients } from './clients.js';
import { loadConfig, resolveRegion } from './config.js';
import { readExpiration } from './credentials.js';
import { deployCheck } from './deploy-check.js';
import { safeError } from './redact.js';
import { runRehearsal } from './rehearsal.js';
import { runTeardown } from './teardown.js';

const TEARDOWN_HELP = `Usage: npm run teardown -- [options]

Options:
  --dry-run                  List every resource that would be deleted. Do not delete or export.
  --region <region>          AWS region. Default: eu-central-1, or EXPERIMENT_REGION, or AWS_REGION.
  --skip-export              Continue without an export. Requires --i-understand-no-export.
  --i-understand-no-export   Acknowledge that this run writes EXPORT_MISSING and is not an archive.
  --run-id <id>              results/<id> directory. Defaults to EXPERIMENT_RUN_ID or a timestamp.
  --help                     Show this help.

The command exports first, then destroys experiment stacks, deletes leftovers, and
verifies the account. It keeps the Budgets alert named otel-demo-experiment.
Verify also prints a warn-only region scan. Those lines do not change the exit code.
`;

const REHEARSAL_HELP = `Usage: npm run teardown:rehearsal -- [options]

Options:
  --region <region> AWS region. Default: eu-central-1, or EXPERIMENT_REGION, or AWS_REGION.
  --help            Show this help.

Creates one tagged S3 bucket and one tagged CloudWatch log group, then runs export,
destroy, leftover deletion, and verify against them. Exits non-zero if anything
remains. Run this before the first full deploy.
`;

const DEPLOY_HELP = `Usage: npm run deploy:check -- [options]

Options:
  --region <region> AWS region. Default: eu-central-1, or EXPERIMENT_REGION, or AWS_REGION.
  --help            Show this help.

Refuses a deploy unless credentials are valid, EXPERIMENT_HARD_STOP_UTC is at
least 5 days away, the otel-demo-experiment budget exists, and RDS and VPC
quotas cover 4 db.t4g.micro instances and 1 VPC.
`;

export async function teardownMain(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  try {
    const args = parseArgs(argv, 'teardown');
    if (args.help) {
      process.stdout.write(TEARDOWN_HELP);
      return 0;
    }
    const region = resolveRegion(args.region, env);
    const config = loadConfig(env, { region, runId: args.runId });
    const result = await runTeardown({
      env,
      region,
      dryRun: args.dryRun,
      skipExport: args.skipExport,
      acknowledgeNoExport: args.acknowledgeNoExport,
      runId: args.runId,
      clients: createClients(region, config.budgetsRegion),
      loadExpiration: () => readExpiration(env),
    });
    process.stdout.write(`${result.report}\n`);
    return result.exitCode;
  } catch (error) {
    process.stderr.write(`teardown failed: ${safeError(error)}\n`);
    return 1;
  }
}

export async function rehearsalMain(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  try {
    const args = parseArgs(argv, 'rehearsal');
    if (args.help) {
      process.stdout.write(REHEARSAL_HELP);
      return 0;
    }
    const region = resolveRegion(args.region, env);
    const config = loadConfig(env, { region });
    const result = await runRehearsal({
      env,
      region,
      clients: createClients(region, config.budgetsRegion),
      loadExpiration: () => readExpiration(env),
    });
    process.stdout.write(`${result.report}\n`);
    return result.exitCode;
  } catch (error) {
    process.stderr.write(`rehearsal failed: ${safeError(error)}\n`);
    return 1;
  }
}

export async function deployCheckMain(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  try {
    const args = parseArgs(argv, 'deploy-check');
    if (args.help) {
      process.stdout.write(DEPLOY_HELP);
      return 0;
    }
    const region = resolveRegion(args.region, env);
    const config = loadConfig(env, { region });
    const result = await deployCheck({
      clients: createClients(region, config.budgetsRegion),
      region,
      now: new Date(),
      hardStopUtc: config.hardStopUtc,
      dbEngine: config.dbEngine,
    });
    process.stdout.write(`${result.report}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`deploy check failed: ${safeError(error)}\n`);
    return 1;
  }
}

interface ParsedArgs {
  dryRun: boolean;
  skipExport: boolean;
  acknowledgeNoExport: boolean;
  help: boolean;
  region?: string;
  runId?: string;
}

export function parseArgs(
  argv: string[],
  command: 'teardown' | 'deploy-check' | 'rehearsal',
): ParsedArgs {
  const parsed: ParsedArgs = {
    dryRun: false,
    skipExport: false,
    acknowledgeNoExport: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--dry-run') {
      rejectUnlessTeardown(command, arg);
      parsed.dryRun = true;
    } else if (arg === '--skip-export') {
      rejectUnlessTeardown(command, arg);
      parsed.skipExport = true;
    } else if (arg === '--i-understand-no-export') {
      rejectUnlessTeardown(command, arg);
      parsed.acknowledgeNoExport = true;
    } else if (arg === '--region') {
      parsed.region = readValue(argv, index, arg);
      index += 1;
    } else if (arg?.startsWith('--region=')) {
      parsed.region = arg.slice('--region='.length);
    } else if (arg === '--run-id') {
      rejectUnlessTeardown(command, arg);
      parsed.runId = readValue(argv, index, arg);
      index += 1;
    } else if (arg?.startsWith('--run-id=')) {
      rejectUnlessTeardown(command, arg);
      parsed.runId = arg.slice('--run-id='.length);
    } else {
      throw new Error(`unknown argument ${arg ?? ''}`);
    }
  }
  return parsed;
}

function rejectUnlessTeardown(
  command: 'teardown' | 'deploy-check' | 'rehearsal',
  arg: string,
): void {
  if (command === 'teardown') {
    return;
  }
  const name = command === 'deploy-check' ? 'deploy:check' : 'teardown:rehearsal';
  throw new Error(`${arg} is not valid for ${name}`);
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
}
