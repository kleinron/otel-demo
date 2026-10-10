import { describe, expect, it } from 'vitest';
import { deleteLeftovers } from '../src/leftovers.js';
import { nameMatchesExperiment, RETAINED_BUDGET_NAME } from '../src/tags.js';
import { verifyAccount } from '../src/verify.js';
import {
  commandNames,
  experimentTag,
  fakeAccount,
  fakeArn,
  mockAws,
  type Handler,
} from './aws-mock.js';

const REGION = 'eu-central-1';
const WAIT = { sleep: async () => undefined, waitAttempts: 1, waitIntervalMs: 0 };

function budgetClient(account: string): Record<string, Handler> {
  return {
    DescribeBudgetsCommand: (input) => {
      if (input.AccountId !== account) {
        throw new Error('budget lookup used an unexpected account');
      }
      return { Budgets: [{ BudgetName: RETAINED_BUDGET_NAME }] };
    },
  };
}

describe('budget allow-list', () => {
  it('matches the budget name as an experiment name, so the allow-list has to be explicit', () => {
    expect(nameMatchesExperiment(RETAINED_BUDGET_NAME)).toBe(true);
    expect(nameMatchesExperiment('otel-demonstration')).toBe(false);
    expect(nameMatchesExperiment('CDKToolkit')).toBe(false);
    expect(nameMatchesExperiment('cdk-hnb659fds-assets-bucket')).toBe(false);
  });

  it('skips a tagged budget named otel-demo-experiment and still deletes other tagged resources', async () => {
    const account = fakeAccount();
    const aws = mockAws(
      {
        budgets: budgetClient(account),
        tagging: {
          GetResourcesCommand: () => ({
            ResourceTagMappingList: [
              {
                ResourceARN: fakeArn('budgets', '', account, `budget/${RETAINED_BUDGET_NAME}`),
                Tags: experimentTag(),
              },
              {
                ResourceARN: fakeArn('rds', REGION, account, 'db:otel-demo-shop'),
                Tags: experimentTag(),
              },
            ],
          }),
        },
        rds: {
          DescribeDBInstancesCommand: () => ({
            DBInstances: [{ DBInstanceIdentifier: 'otel-demo-shop' }],
          }),
        },
      },
      { accountId: account },
    );
    aws.clients.budgets = {
      async send(command) {
        if (command.constructor.name !== 'DescribeBudgetsCommand') {
          throw new Error(`budget mutation ${command.constructor.name}`);
        }
        return budgetClient(account).DescribeBudgetsCommand?.(
          (command.input ?? {}) as Record<string, unknown>,
        );
      },
    };

    const deleted = await deleteLeftovers({
      clients: aws.clients,
      region: REGION,
      accountId: account,
      dryRun: false,
      wait: WAIT,
    });
    const verified = await verifyAccount({
      clients: aws.clients,
      region: REGION,
      accountId: account,
    });
    const text = [...deleted.lines, ...verified.lines].join('\n');

    expect(deleted.skipped.join('\n')).toMatch(
      /budget otel-demo-experiment \(allow-listed budget name\)/,
    );
    expect(commandNames(aws.calls.rds)).toContain('DeleteDBInstanceCommand');
    expect(deleted.planned.join('\n')).not.toMatch(/budget /);
    expect(verified.leftovers.map((item) => item.kind)).not.toContain('budget');
    expect(verified.leftovers.map((item) => item.name)).toContain('otel-demo-shop');
    expect(verified.retainedBudget).toBe('present');
    expect(text).toMatch(/Ron deletes it by hand/);
    expect(text).not.toContain(account);
  });

  it('ignores an untagged budget with that name during delete and verify', async () => {
    const account = fakeAccount();
    const aws = mockAws({ budgets: budgetClient(account) }, { accountId: account });
    aws.clients.budgets = {
      async send(command) {
        if (command.constructor.name !== 'DescribeBudgetsCommand') {
          throw new Error(`budget mutation ${command.constructor.name}`);
        }
        aws.calls.budgets.push({
          name: command.constructor.name,
          input: (command.input ?? {}) as Record<string, unknown>,
        });
        return budgetClient(account).DescribeBudgetsCommand?.(
          (command.input ?? {}) as Record<string, unknown>,
        );
      },
    };

    const deleted = await deleteLeftovers({
      clients: aws.clients,
      region: REGION,
      accountId: account,
      dryRun: false,
      wait: WAIT,
    });
    const verified = await verifyAccount({
      clients: aws.clients,
      region: REGION,
      accountId: account,
    });

    expect(deleted.deleted).toEqual([]);
    expect(deleted.skipped.join('\n')).toMatch(
      /budget otel-demo-experiment \(allow-listed budget name\)/,
    );
    expect(verified.ok).toBe(true);
    expect(verified.leftovers).toEqual([]);
    expect(verified.retainedBudget).toBe('present');
    expect(verified.lines.join('\n')).toMatch(/skipped by name/);
    expect(verified.lines.join('\n')).not.toContain(account);
  });
});
