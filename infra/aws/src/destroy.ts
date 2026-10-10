import { spawn } from 'node:child_process';
import { DeleteStackCommand, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { isAlreadyGone } from './errors.js';
import { listExperimentResources } from './inventory.js';
import { safeError } from './redact.js';
import { isLeftover } from './retention.js';
import { asArray, asRecord, asString } from './text.js';
import type { SleepOptions, TeardownClients } from './types.js';
import { waitUntil } from './wait.js';

export type RunProcess = (command: string, args: string[], cwd: string) => Promise<number>;

export interface DestroyReport {
  ok: boolean;
  stoppedBeforeSweep: boolean;
  lines: string[];
  stackNames: string[];
}

const BUSY_STATUSES = new Set([
  'CREATE_IN_PROGRESS',
  'ROLLBACK_IN_PROGRESS',
  'UPDATE_IN_PROGRESS',
  'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS',
  'UPDATE_ROLLBACK_IN_PROGRESS',
  'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS',
  'REVIEW_IN_PROGRESS',
  'IMPORT_IN_PROGRESS',
  'IMPORT_ROLLBACK_IN_PROGRESS',
]);

export async function destroyStacks(input: {
  clients: TeardownClients;
  region: string;
  accountId: string;
  dryRun: boolean;
  cdkAppPresent: boolean;
  infraDir: string;
  runProcess: RunProcess;
  wait: SleepOptions;
}): Promise<DestroyReport> {
  const inventory = await listExperimentResources({
    clients: input.clients,
    region: input.region,
    accountId: input.accountId,
  });
  const stacks = inventory.resources.filter(
    (resource) => resource.kind === 'cloudformation-stack' && isLeftover(resource),
  );
  const names = stacks.map((stack) => stack.name);
  if (stacks.length === 0) {
    return {
      ok: true,
      stoppedBeforeSweep: false,
      stackNames: [],
      lines: ['cdk destroy: no experiment stacks.'],
    };
  }

  const busy = stacks.filter((stack) => stack.status && BUSY_STATUSES.has(stack.status));
  if (busy.length > 0) {
    return {
      ok: false,
      stoppedBeforeSweep: !input.dryRun,
      stackNames: names,
      lines: [
        `cdk destroy: stopped. Stack still in progress: ${busy.map((stack) => `${stack.name} ${stack.status}`).join(', ')}. Refresh credentials if needed and re-run. Leftover sweep was not started.`,
      ],
    };
  }

  if (input.dryRun) {
    return {
      ok: true,
      stoppedBeforeSweep: false,
      stackNames: names,
      lines: [`cdk destroy: dry-run would destroy ${names.join(', ')}.`],
    };
  }

  try {
    if (input.cdkAppPresent) {
      const code = await runCdkDestroy(input.runProcess, input.infraDir, input.region, names);
      if (code !== 0) {
        return {
          ok: false,
          stoppedBeforeSweep: true,
          stackNames: names,
          lines: [
            `cdk destroy: exited ${code}. Leftover sweep was not started. Re-run after the stack delete finishes.`,
          ],
        };
      }
    } else {
      for (const stack of stacks) {
        assertStackName(stack.name);
        await input.clients.cloudformation.send(new DeleteStackCommand({ StackName: stack.name }));
      }
    }
  } catch (error) {
    return {
      ok: false,
      stoppedBeforeSweep: true,
      stackNames: names,
      lines: [`cdk destroy: ${safeError(error)}. Leftover sweep was not started.`],
    };
  }

  const stillInProgress: string[] = [];
  const failed: string[] = [];
  for (const stack of stacks) {
    const gone = await waitUntil(() => stackIsGone(input.clients, stack.name), input.wait);
    if (gone) {
      continue;
    }
    const status = await stackStatus(input.clients, stack.name);
    if (status === 'DELETE_IN_PROGRESS' || (status !== 'absent' && BUSY_STATUSES.has(status))) {
      stillInProgress.push(`${stack.name} ${status}`);
    } else if (status !== 'absent') {
      failed.push(`${stack.name} ${status}`);
    }
  }

  if (stillInProgress.length > 0) {
    return {
      ok: false,
      stoppedBeforeSweep: true,
      stackNames: names,
      lines: [
        `cdk destroy: still in progress (${stillInProgress.join(', ')}). Re-run teardown. Leftover sweep was not started.`,
      ],
    };
  }

  if (failed.length > 0) {
    return {
      ok: false,
      stoppedBeforeSweep: false,
      stackNames: names,
      lines: [
        `cdk destroy: ${failed.join(', ')}. Continuing to the leftover sweep so blocked resources can be removed, then re-run teardown.`,
      ],
    };
  }

  return {
    ok: true,
    stoppedBeforeSweep: false,
    stackNames: names,
    lines: [`cdk destroy: delete complete for ${names.join(', ')}.`],
  };
}

async function runCdkDestroy(
  runProcess: RunProcess,
  cwd: string,
  region: string,
  names: string[],
): Promise<number> {
  const safeNames = names.map((name) => assertStackName(name));
  return runProcess('npx', ['cdk', 'destroy', ...safeNames, '--force', '--region', region], cwd);
}

function assertStackName(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) {
    throw new Error('refusing to destroy a stack whose name is not a safe token');
  }
  if (name === 'CDKToolkit') {
    throw new Error('refusing to destroy CDKToolkit');
  }
  return name;
}

async function stackIsGone(clients: TeardownClients, name: string): Promise<boolean> {
  const status = await stackStatus(clients, name);
  return status === 'absent' || status === 'DELETE_COMPLETE';
}

async function stackStatus(clients: TeardownClients, name: string): Promise<string> {
  try {
    const page = asRecord(
      await clients.cloudformation.send(new DescribeStacksCommand({ StackName: name })),
    );
    const status = asString(asRecord(asArray(page.Stacks)[0]).StackStatus);
    return status ?? 'absent';
  } catch (error) {
    if (isAlreadyGone(error)) {
      return 'absent';
    }
    throw error;
  }
}

export function defaultRunProcess(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}
