import { DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { describe, expect, it } from 'vitest';
import { deployCheck, quotaCovers } from '../src/deploy-check.js';
import { fakeAccount, mockAws, type Handler } from './aws-mock.js';
import { MINIMUM_LEAD_TIME_MS, RUN_DURATION_MS, assessHardStop } from '../src/window.js';

const NOW = new Date('2026-10-10T00:00:00.000Z');

function iso(ms: number): string {
  return new Date(NOW.getTime() + ms).toISOString();
}

describe('date window', () => {
  it('requires at least five days, which covers a 72-hour run', () => {
    expect(MINIMUM_LEAD_TIME_MS).toBeGreaterThanOrEqual(RUN_DURATION_MS);
    expect(assessHardStop(iso(MINIMUM_LEAD_TIME_MS), NOW).ok).toBe(true);
    expect(assessHardStop(iso(RUN_DURATION_MS), NOW).ok).toBe(false);
    expect(assessHardStop(iso(MINIMUM_LEAD_TIME_MS - 1), NOW).ok).toBe(false);
  });

  it('rejects a missing, invalid, or past deny-after instant', () => {
    expect(assessHardStop(undefined, NOW).reason).toMatch(/not set/);
    expect(assessHardStop('tomorrow', NOW).reason).toMatch(/not a valid/);
    expect(assessHardStop(iso(-1), NOW).ok).toBe(false);
  });

  it('passes when the deny-after instant is more than five days away', () => {
    const assessment = assessHardStop('2026-10-17T00:00:00Z', NOW);
    expect(assessment.ok).toBe(true);
    expect(assessment.remainingMs).toBeGreaterThan(MINIMUM_LEAD_TIME_MS);
  });
});

describe('deploy check', () => {
  it('refuses to deploy when credentials are not valid and does not read quotas', async () => {
    const aws = mockAws({
      sts: {
        GetCallerIdentityCommand: () => {
          throw new Error('denied');
        },
      },
    });
    const result = await deployCheck({
      clients: aws.clients,
      region: 'eu-central-1',
      now: NOW,
      hardStopUtc: iso(MINIMUM_LEAD_TIME_MS),
      dbEngine: 'postgres',
    });
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(/credentials are not valid/);
    expect(aws.calls.budgets).toHaveLength(0);
    expect(aws.calls.serviceQuotas).toHaveLength(0);
    expect(new GetCallerIdentityCommand({}).constructor.name).toBe('GetCallerIdentityCommand');
  });

  it('refuses to deploy when the deny-after window is under five days', async () => {
    const aws = readyAccount();
    const result = await deployCheck({
      clients: aws.clients,
      region: 'eu-central-1',
      now: NOW,
      hardStopUtc: iso(RUN_DURATION_MS),
      dbEngine: 'postgres',
    });
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(/under 5 days/);
    expect(result.report).toMatch(/72-hour/);
  });

  it('passes when credentials, the window, the budget, and quotas are sufficient', async () => {
    const account = fakeAccount();
    const aws = readyAccount(account);
    const result = await deployCheck({
      clients: aws.clients,
      region: 'eu-central-1',
      now: NOW,
      hardStopUtc: iso(MINIMUM_LEAD_TIME_MS),
      dbEngine: 'postgres',
    });
    expect(result.ok).toBe(true);
    expect(result.report).toMatch(/Deploy check passed/);
    expect(result.report).toMatch(/otel-demo-experiment: present/);
    expect(result.report).not.toContain(account);
    expect(quotaCovers(40, 0, 4)).toBe(true);
    expect(quotaCovers(4, 1, 4)).toBe(false);
  });

  it('refuses to deploy when fewer than four DB instance slots remain', async () => {
    const aws = readyAccount(fakeAccount(), {
      serviceQuotas: {
        GetServiceQuotaCommand: (input) => ({
          Quota: { Value: input.ServiceCode === 'rds' ? 4 : 5 },
        }),
      },
      rds: {
        DescribeDBInstancesCommand: () => ({
          DBInstances: [{ DBInstanceIdentifier: 'other-db' }],
        }),
        DescribeOrderableDBInstanceOptionsCommand: () => ({
          OrderableDBInstanceOptions: [{ DBInstanceClass: 'db.t4g.micro' }],
        }),
      },
    });
    const result = await deployCheck({
      clients: aws.clients,
      region: 'eu-central-1',
      now: NOW,
      hardStopUtc: iso(MINIMUM_LEAD_TIME_MS),
      dbEngine: 'postgres',
    });
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(/db\.t4g\.micro/);
    expect(new DescribeDBInstancesCommand({}).constructor.name).toBe('DescribeDBInstancesCommand');
  });

  it('refuses to deploy when the named budget is missing', async () => {
    const aws = readyAccount(fakeAccount(), {
      budgets: { DescribeBudgetsCommand: () => ({ Budgets: [] }) },
    });
    const result = await deployCheck({
      clients: aws.clients,
      region: 'eu-central-1',
      now: NOW,
      hardStopUtc: iso(MINIMUM_LEAD_TIME_MS),
      dbEngine: 'postgres',
    });
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(/otel-demo-experiment was not found/);
  });
});

function readyAccount(account = fakeAccount(), handlers: Parameters<typeof mockAws>[0] = {}) {
  const quotas: Record<string, Handler> = {
    GetServiceQuotaCommand: (input) => ({
      Quota: { Value: input.ServiceCode === 'rds' ? 40 : 5 },
    }),
    ...(handlers.serviceQuotas ?? {}),
  };
  const rds: Record<string, Handler> = {
    DescribeOrderableDBInstanceOptionsCommand: () => ({
      OrderableDBInstanceOptions: [{ DBInstanceClass: 'db.t4g.micro' }],
    }),
    ...(handlers.rds ?? {}),
  };
  const budgets: Record<string, Handler> = {
    DescribeBudgetsCommand: () => ({ Budgets: [{ BudgetName: 'otel-demo-experiment' }] }),
    ...(handlers.budgets ?? {}),
  };
  return mockAws({ ...handlers, serviceQuotas: quotas, rds, budgets }, { accountId: account });
}
