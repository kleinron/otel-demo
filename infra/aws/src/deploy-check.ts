import { DescribeBudgetsCommand } from '@aws-sdk/client-budgets';
import { DescribeVpcsCommand } from '@aws-sdk/client-ec2';
import {
  DescribeDBInstancesCommand,
  DescribeOrderableDBInstanceOptionsCommand,
} from '@aws-sdk/client-rds';
import { GetServiceQuotaCommand } from '@aws-sdk/client-service-quotas';
import { CredentialError, getCallerAccount } from './credentials.js';
import { collectPages } from './paging.js';
import { redactText, safeError } from './redact.js';
import { RETAINED_BUDGET_NAME } from './tags.js';
import { asArray, asRecord, asString } from './text.js';
import type { TeardownClients } from './types.js';
import { assessHardStop, formatDuration } from './window.js';

/** Public Service Quotas code for RDS DB instances. */
export const RDS_DB_INSTANCE_QUOTA = 'L-7B6409FD';
/** Public Service Quotas code for VPCs per Region. */
export const VPC_PER_REGION_QUOTA = 'L-F678F1CE';

export const REQUIRED_DB_INSTANCES = 4;
export const REQUIRED_VPCS = 1;
export const DB_INSTANCE_CLASS = 'db.t4g.micro';

export function quotaCovers(limit: number, used: number, needed: number): boolean {
  return limit - used >= needed;
}

export interface DeployCheckResult {
  ok: boolean;
  report: string;
}

export async function deployCheck(input: {
  clients: TeardownClients;
  region: string;
  now: Date;
  hardStopUtc: string | undefined;
  dbEngine: string;
  accountId?: string;
}): Promise<DeployCheckResult> {
  const lines: string[] = [`Region: ${input.region}.`];
  let accountId: string;
  try {
    accountId = (await getCallerAccount(input.clients.sts)).accountId;
    lines.push('Credentials: valid.');
  } catch (error) {
    lines.push(error instanceof CredentialError ? error.message : safeError(error));
    return { ok: false, report: redactText(lines.join('\n')) };
  }

  const failures: string[] = [];
  const window = assessHardStop(input.hardStopUtc, input.now);
  if (!window.ok) {
    failures.push(window.reason ?? 'IAM deny-after is not far enough away');
  } else {
    lines.push(
      `IAM deny-after: ${window.hardStop?.toISOString()} (${formatDuration(window.remainingMs)} remaining, minimum 5 days for a 72-hour run plus export and teardown).`,
    );
  }

  try {
    const present = await budgetExists(input.clients, accountId);
    if (!present) {
      failures.push(`Budgets alert ${RETAINED_BUDGET_NAME} was not found`);
    } else {
      lines.push(`Budgets alert ${RETAINED_BUDGET_NAME}: present.`);
    }
  } catch (error) {
    failures.push(`Budgets alert could not be read: ${safeError(error)}`);
  }

  try {
    const quota = await quotaFindings(input.clients, input.dbEngine);
    lines.push(...quota.lines);
    failures.push(...quota.failures);
  } catch (error) {
    failures.push(`quota check failed: ${safeError(error)}`);
  }

  if (failures.length > 0) {
    lines.push('Deploy check failed:');
    for (const failure of failures) {
      lines.push(`- ${failure}`);
    }
    return { ok: false, report: redactText(lines.join('\n')) };
  }
  lines.push('Deploy check passed.');
  return { ok: true, report: redactText(lines.join('\n')) };
}

async function budgetExists(clients: TeardownClients, accountId: string): Promise<boolean> {
  const budgets = await collectPages(
    clients.budgets,
    (token) =>
      new DescribeBudgetsCommand({ AccountId: accountId, NextToken: token, MaxResults: 100 }),
    (page) => ({ items: asArray(page.Budgets), token: asString(page.NextToken) }),
  );
  return budgets.some((item) => asString(asRecord(item).BudgetName) === RETAINED_BUDGET_NAME);
}

async function quotaFindings(
  clients: TeardownClients,
  engine: string,
): Promise<{ lines: string[]; failures: string[] }> {
  const lines: string[] = [];
  const failures: string[] = [];
  const dbLimit = await quotaValue(clients, 'rds', RDS_DB_INSTANCE_QUOTA);
  const dbUsed = (
    await collectPages(
      clients.rds,
      (token) => new DescribeDBInstancesCommand({ Marker: token, MaxRecords: 100 }),
      (page) => ({ items: asArray(page.DBInstances), token: asString(page.Marker) }),
    )
  ).length;
  if (!quotaCovers(dbLimit, dbUsed, REQUIRED_DB_INSTANCES)) {
    failures.push(
      `RDS DB instance quota has ${dbLimit - dbUsed} free, which is below the ${REQUIRED_DB_INSTANCES} ${DB_INSTANCE_CLASS} instances required`,
    );
  } else {
    lines.push(
      `RDS quota: ${dbLimit - dbUsed} DB instances free, need ${REQUIRED_DB_INSTANCES} ${DB_INSTANCE_CLASS}.`,
    );
  }

  const orderable = await collectPages(
    clients.rds,
    (token) =>
      new DescribeOrderableDBInstanceOptionsCommand({
        Engine: engine,
        DBInstanceClass: DB_INSTANCE_CLASS,
        Marker: token,
        MaxRecords: 20,
      }),
    (page) => ({
      items: asArray(page.OrderableDBInstanceOptions),
      token: asString(page.Marker),
    }),
  );
  if (orderable.length === 0) {
    failures.push(`${DB_INSTANCE_CLASS} is not orderable for engine ${engine} in this region`);
  } else {
    lines.push(`${DB_INSTANCE_CLASS} is orderable for engine ${engine}.`);
  }

  const vpcLimit = await quotaValue(clients, 'vpc', VPC_PER_REGION_QUOTA);
  const vpcUsed = (
    await collectPages(
      clients.ec2,
      (token) => new DescribeVpcsCommand({ NextToken: token, MaxResults: 100 }),
      (page) => ({ items: asArray(page.Vpcs), token: asString(page.NextToken) }),
    )
  ).length;
  if (!quotaCovers(vpcLimit, vpcUsed, REQUIRED_VPCS)) {
    failures.push(
      `VPC quota has ${vpcLimit - vpcUsed} free, which is below the ${REQUIRED_VPCS} VPC required`,
    );
  } else {
    lines.push(`VPC quota: ${vpcLimit - vpcUsed} free, need ${REQUIRED_VPCS}.`);
  }
  return { lines, failures };
}

async function quotaValue(
  clients: TeardownClients,
  service: string,
  code: string,
): Promise<number> {
  const page = asRecord(
    await clients.serviceQuotas.send(
      new GetServiceQuotaCommand({ ServiceCode: service, QuotaCode: code }),
    ),
  );
  const value = asRecord(page.Quota).Value;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`quota ${service} ${code} has no value`);
  }
  return value;
}
