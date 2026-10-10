import { listExperimentResources } from './inventory.js';
import { scanRegion } from './region-scan.js';
import { isLeftover, isRetainedBudget } from './retention.js';
import { RETAINED_BUDGET_NAME } from './tags.js';
import type { ExperimentResource, TeardownClients } from './types.js';

export interface Leftover {
  kind: string;
  name: string;
  tagged: boolean;
}

export interface VerifyReport {
  ok: boolean;
  leftovers: Leftover[];
  retainedBudget: 'present' | 'absent';
  lines: string[];
}

export async function verifyAccount(input: {
  clients: TeardownClients;
  region: string;
  accountId: string;
}): Promise<VerifyReport> {
  const inventory = await listExperimentResources(input);
  const leftovers = inventory.resources.filter(isLeftover).map(toLeftover);
  const retained =
    inventory.budgetNames.includes(RETAINED_BUDGET_NAME) ||
    inventory.resources.some(isRetainedBudget);
  const scan = await scanRegion(input.clients);
  return {
    ok: leftovers.length === 0,
    leftovers,
    retainedBudget: retained ? 'present' : 'absent',
    lines: [...formatVerifyLines(leftovers, retained), ...scan.lines],
  };
}

function toLeftover(resource: ExperimentResource): Leftover {
  return { kind: resource.kind, name: resource.name, tagged: resource.tagged };
}

export function formatVerifyLines(
  leftovers: readonly Leftover[],
  budgetPresent: boolean,
): string[] {
  const lines: string[] = [];
  if (leftovers.length === 0) {
    lines.push('VERIFY OK: nothing remains.');
  } else {
    lines.push(`VERIFY FAILED: ${leftovers.length} resource(s) remain:`);
    for (const leftover of leftovers) {
      const why = leftover.tagged ? 'experiment tag' : 'name';
      lines.push(`- ${leftover.kind} ${leftover.name} (${why})`);
    }
  }
  lines.push(
    budgetPresent
      ? `Retained budget ${RETAINED_BUDGET_NAME}: present, skipped by name. Ron deletes it by hand after the experiment is finished.`
      : `Retained budget ${RETAINED_BUDGET_NAME}: not present. That is not a workload leftover. Ron deletes it by hand after the experiment is finished.`,
  );
  return lines;
}
