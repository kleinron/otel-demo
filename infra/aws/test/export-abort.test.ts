import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readAlarmNames } from '../src/catalog.js';
import { redactText } from '../src/redact.js';
import { BUDGET_CATALOG_NAME } from '../src/tags.js';
import { runTeardown } from '../src/teardown.js';
import {
  commandNames,
  exportEnv,
  fakeAccount,
  fakeArn,
  happyExportHandlers,
  mockAws,
  type Handler,
} from './aws-mock.js';

const REGION = 'eu-central-1';
const NOW = new Date('2026-10-10T00:00:00.000Z');
const ALERTS = new URL('../../../observability/alerts.yml', import.meta.url);

function resultsDir(): string {
  return mkdtempSync(join(tmpdir(), 'otel-demo-results-'));
}

function stackHandler(): Record<string, Handler> {
  return {
    ListStacksCommand: () => ({
      StackSummaries: [{ StackName: 'otel-demo-services', StackStatus: 'CREATE_COMPLETE' }],
    }),
  };
}

async function teardown(
  aws: ReturnType<typeof mockAws>,
  extra: Partial<Parameters<typeof runTeardown>[0]> = {},
) {
  const resultsRoot = extra.resultsRoot ?? resultsDir();
  const result = await runTeardown({
    env: exportEnv(),
    region: REGION,
    now: NOW,
    clients: aws.clients,
    resultsRoot,
    waitAttempts: 1,
    waitIntervalMs: 0,
    sleep: async () => undefined,
    loadExpiration: async () => undefined,
    runProcess: async () => 0,
    ...extra,
    resultsRoot,
  });
  return { result, resultsRoot };
}

describe('export abort', () => {
  it('aborts before destroy when saved Logs Insights queries are missing', async () => {
    const handlers = happyExportHandlers();
    const aws = mockAws({
      cloudwatch: handlers.cloudwatch,
      logs: {
        ...handlers.logs,
        DescribeQueryDefinitionsCommand: () => ({ queryDefinitions: [] }),
      },
      cloudformation: stackHandler(),
    });
    const { result, resultsRoot } = await teardown(aws);
    expect(result.exitCode).toBe(1);
    expect(result.report).toMatch(/ABORT/);
    expect(result.report).toMatch(/No saved Logs Insights queries/);
    expect(result.report).toMatch(/cdk destroy was not started/);
    expect(commandNames(aws.calls.cloudformation)).not.toContain('DeleteStackCommand');
    expect(existsSync(join(resultsRoot, 'run-test', 'EXPORT_OK'))).toBe(false);
    expect(existsSync(join(resultsRoot, 'run-test', 'EXPORT_MISSING'))).toBe(false);
  });

  it('aborts before destroy when an export API call fails', async () => {
    const aws = mockAws({
      cloudwatch: {
        DescribeAlarmsCommand: () => {
          throw new Error('access denied');
        },
      },
      cloudformation: stackHandler(),
    });
    const { result, resultsRoot } = await teardown(aws);
    expect(result.exitCode).toBe(1);
    expect(result.report).toMatch(/ABORT/);
    expect(result.report).toMatch(/access denied/);
    expect(commandNames(aws.calls.cloudformation)).not.toContain('DeleteStackCommand');
    expect(existsSync(join(resultsRoot, 'run-test', 'EXPORT_OK'))).toBe(false);
  });

  it('does not write EXPORT_OK after a partial export', async () => {
    const handlers = happyExportHandlers();
    const aws = mockAws({
      cloudwatch: handlers.cloudwatch,
      logs: {
        ...handlers.logs,
        StartQueryCommand: () => {
          throw new Error('query failed');
        },
      },
      cloudformation: stackHandler(),
    });
    const { result, resultsRoot } = await teardown(aws);
    const directory = join(resultsRoot, 'run-test');
    expect(result.exitCode).toBe(1);
    expect(existsSync(join(directory, 'alarms', 'shop-add-to-cart-5xx-rate.json'))).toBe(true);
    expect(existsSync(join(directory, 'EXPORT_OK'))).toBe(false);
    expect(commandNames(aws.calls.cloudformation)).not.toContain('DeleteStackCommand');
  });

  it('continues only when --skip-export is set', async () => {
    const aws = mockAws({
      cloudwatch: {
        DescribeAlarmsCommand: () => {
          throw new Error('should not be called');
        },
      },
      cloudformation: stackHandler(),
    });
    const { result, resultsRoot } = await teardown(aws, {
      skipExport: true,
      acknowledgeNoExport: true,
    });
    expect(result.report).toMatch(/skipped by --skip-export/);
    expect(result.report).toMatch(/EXPORT_MISSING/);
    expect(existsSync(join(resultsRoot, 'run-test', 'EXPORT_MISSING'))).toBe(true);
    expect(existsSync(join(resultsRoot, 'run-test', 'EXPORT_OK'))).toBe(false);
    expect(commandNames(aws.calls.logs)).not.toContain('DescribeQueryDefinitionsCommand');
    expect(commandNames(aws.calls.cloudformation)).toContain('DeleteStackCommand');
  });

  it('refuses --skip-export unless --i-understand-no-export is also set', async () => {
    const aws = mockAws({ cloudformation: stackHandler() });
    const { result, resultsRoot } = await teardown(aws, { skipExport: true });
    expect(result.exitCode).toBe(1);
    expect(result.report).toMatch(/--i-understand-no-export/);
    expect(result.report).toMatch(/Nothing was destroyed/);
    expect(commandNames(aws.calls.cloudformation)).not.toContain('DeleteStackCommand');
    expect(existsSync(join(resultsRoot, 'run-test', 'EXPORT_MISSING'))).toBe(false);
    expect(existsSync(join(resultsRoot, 'run-test', 'EXPORT_OK'))).toBe(false);
  });

  it('refuses --i-understand-no-export without --skip-export', async () => {
    const aws = mockAws({ cloudformation: stackHandler() });
    const { result } = await teardown(aws, { acknowledgeNoExport: true });
    expect(result.exitCode).toBe(1);
    expect(result.report).toMatch(/must both be set/);
    expect(commandNames(aws.calls.cloudformation)).not.toContain('DeleteStackCommand');
  });

  it('writes EXPORT_MISSING and continues cleanup when the stacks are already gone', async () => {
    const handlers = happyExportHandlers();
    const aws = mockAws({
      cloudwatch: handlers.cloudwatch,
      logs: {
        ...handlers.logs,
        DescribeQueryDefinitionsCommand: () => ({ queryDefinitions: [] }),
      },
    });
    const { result, resultsRoot } = await teardown(aws);
    expect(result.exitCode).toBe(0);
    expect(result.report).toMatch(/EXPORT_MISSING/);
    expect(existsSync(join(resultsRoot, 'run-test', 'EXPORT_MISSING'))).toBe(true);
    expect(existsSync(join(resultsRoot, 'run-test', 'EXPORT_OK'))).toBe(false);
    expect(result.report).toMatch(/VERIFY OK/);
  });

  it('writes EXPORT_OK and redacts identifiers when the export succeeds', async () => {
    const account = fakeAccount();
    const planted = fakeArn('rds', REGION, account, 'db:otel-demo-shop');
    const handlers = happyExportHandlers(planted);
    const aws = mockAws(
      { cloudwatch: handlers.cloudwatch, logs: handlers.logs, xray: handlers.xray },
      { accountId: account },
    );
    const { result, resultsRoot } = await teardown(aws);
    const directory = join(resultsRoot, 'run-test');
    const marker = JSON.parse(readFileSync(join(directory, 'EXPORT_OK'), 'utf8')) as {
      files: string[];
    };
    const alarm = readFileSync(join(directory, 'alarms', 'shop-checkout-5xx-rate.json'), 'utf8');
    const names = await readAlarmNames(fileURLToPath(ALERTS));
    const alarmFiles = marker.files.filter((file) => file.startsWith('alarms/'));

    expect(result.exitCode).toBe(0);
    expect(result.report).toMatch(/EXPORT_OK/);
    expect(alarmFiles).toEqual(names.map((name) => `alarms/${name}.json`));
    expect(names).not.toContain(BUDGET_CATALOG_NAME);
    expect(marker.files).toEqual(
      expect.arrayContaining(['run-record.json', 'insights/otel-demo-errors.json']),
    );
    for (const file of marker.files) {
      expect(existsSync(join(directory, file))).toBe(true);
    }
    expect(alarm).toContain('[redacted-arn]');
    expect(alarm).not.toContain(account);
    expect(alarm).not.toContain(planted);
    const trace = readFileSync(join(directory, 'traces', 'trace-checkout-1.json'), 'utf8');
    expect(trace).toContain('[redacted-arn]');
    expect(trace).not.toContain(account);
    expect(trace).not.toContain(planted);
    expect(trace).toContain('"missingHops": []');
    expect(existsSync(join(directory, 'alerts', 'state-changes.json'))).toBe(true);
    expect(existsSync(join(directory, 'alerts', 'rules', 'rules.yml'))).toBe(true);
    expect(redactText(['10', '1', '2', '3'].join('.'))).toBe('[redacted-ip]');
  });

  it('writes alarms/not-used.json when CloudWatch has no alarms', async () => {
    const handlers = happyExportHandlers();
    const aws = mockAws({
      cloudwatch: {
        DescribeAlarmsCommand: () => ({ MetricAlarms: [] }),
      },
      logs: handlers.logs,
      xray: handlers.xray,
    });
    const { result, resultsRoot } = await teardown(aws);
    const directory = join(resultsRoot, 'run-test');
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(directory, 'alarms', 'not-used.json'))).toBe(true);
    expect(existsSync(join(directory, 'alarms', 'shop-checkout-5xx-rate.json'))).toBe(false);
    expect(existsSync(join(directory, 'alerts', 'state-changes.json'))).toBe(true);
    expect(existsSync(join(directory, 'traces', 'trace-checkout-1.json'))).toBe(true);
  });

  it('aborts when no traces were exported and the checkout count is not zero', async () => {
    const handlers = happyExportHandlers();
    const aws = mockAws({
      cloudwatch: handlers.cloudwatch,
      logs: handlers.logs,
      xray: {
        GetTraceSummariesCommand: () => ({ TraceSummaries: [] }),
      },
      cloudformation: stackHandler(),
    });
    const { result, resultsRoot } = await teardown(aws);
    expect(result.exitCode).toBe(1);
    expect(result.report).toMatch(/No traces exported/);
    expect(result.report).toMatch(/EXPERIMENT_CHECKOUT_COUNT=0/);
    expect(result.report).toMatch(/cdk destroy was not started/);
    expect(existsSync(join(resultsRoot, 'run-test', 'EXPORT_OK'))).toBe(false);
    expect(commandNames(aws.calls.cloudformation)).not.toContain('DeleteStackCommand');
  });

  it('writes traces/none.json when the run recorded zero checkouts', async () => {
    const handlers = happyExportHandlers();
    const aws = mockAws({
      cloudwatch: handlers.cloudwatch,
      logs: handlers.logs,
      xray: {
        GetTraceSummariesCommand: () => ({ TraceSummaries: [] }),
      },
    });
    const { result, resultsRoot } = await teardown(aws, {
      env: exportEnv({ EXPERIMENT_CHECKOUT_COUNT: '0' }),
    });
    const directory = join(resultsRoot, 'run-test');
    expect(result.exitCode).toBe(0);
    const none = JSON.parse(readFileSync(join(directory, 'traces', 'none.json'), 'utf8')) as {
      checkouts: number;
      traces: unknown[];
    };
    expect(none).toEqual({ checkouts: 0, traces: [], missingHops: [] });
    expect(existsSync(join(directory, 'EXPORT_OK'))).toBe(true);
  });

  it('reuses a complete EXPORT_OK instead of calling CloudWatch again', async () => {
    const aws = mockAws({
      cloudwatch: {
        DescribeAlarmsCommand: () => {
          throw new Error('should not be called');
        },
      },
    });
    const resultsRoot = resultsDir();
    const directory = join(resultsRoot, 'run-test');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'run-record.json'), '{}\n');
    writeFileSync(
      join(directory, 'EXPORT_OK'),
      `${JSON.stringify({ runId: 'run-test', files: ['run-record.json'] }, null, 2)}\n`,
    );
    const { result } = await teardown(aws, { resultsRoot });
    expect(result.exitCode).toBe(0);
    expect(result.report).toMatch(/existing EXPORT_OK/);
    expect(commandNames(aws.calls.cloudwatch)).not.toContain('DescribeAlarmHistoryCommand');
    const alarmReads = aws.calls.cloudwatch.filter((call) => call.name === 'DescribeAlarmsCommand');
    expect(alarmReads.length).toBeGreaterThan(0);
    for (const call of alarmReads) {
      expect(call.input.AlarmNames).toBeUndefined();
    }
    expect(result.report).toMatch(/WARN: region scan could not list cloudwatch-alarm/);
  });
});
