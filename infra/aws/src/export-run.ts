import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DescribeAlarmHistoryCommand, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import {
  DescribeQueryDefinitionsCommand,
  FilterLogEventsCommand,
  GetQueryResultsCommand,
  StartQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { BatchGetTracesCommand, GetTraceSummariesCommand } from '@aws-sdk/client-xray';
import { readAlarmNames } from './catalog.js';
import type { SafetyConfig } from './config.js';
import { readCatalog } from './grafana/catalog.js';
import { buildProvisioningFiles } from './grafana/provision.js';
import { ALERT_LOG_GROUP } from './names.js';
import { safeError, redactText } from './redact.js';
import { asArray, asRecord, asString } from './text.js';
import { CHECKOUT_TRACE_FILTERS, shapeTrace } from './traces.js';
import type { SdkClient, TeardownClients } from './types.js';

const MAX_LOG_EVENTS = 20_000;
const MAX_QUERY_POLLS = 20;

export interface ExportResult {
  ok: boolean;
  directory: string;
  files: string[];
  reason?: string;
}

export async function readCompletedExport(directory: string): Promise<boolean> {
  try {
    const raw = await readFile(join(directory, 'EXPORT_OK'), 'utf8');
    const parsed = JSON.parse(raw) as { files?: unknown };
    if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
      return false;
    }
    for (const file of parsed.files) {
      if (typeof file !== 'string' || file.includes('..') || file.startsWith('/')) {
        return false;
      }
      const info = await stat(join(directory, file));
      if (info.size === 0) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function writeExportMissing(directory: string, reason: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const body = `${JSON.stringify({ reason }, null, 2)}\n`;
  await writeFile(join(directory, 'EXPORT_MISSING'), body, 'utf8');
}

/**
 * Archive the rehearsal log group only. A pre-deploy account has no alarms or
 * saved queries, so this does not use the full experiment export.
 */
export async function exportRehearsal(input: {
  logs: SdkClient;
  directory: string;
  runId: string;
  logGroup: string;
}): Promise<ExportResult> {
  const files: string[] = [];
  try {
    await writeJson(
      input.directory,
      'run-record.json',
      {
        runId: input.runId,
        loadProfile: 'rehearsal',
        note: 'Pre-deploy rehearsal. This is not an experiment archive.',
        logGroup: input.logGroup,
      },
      files,
    );
    const events = await fetchLogEvents(input.logs, input.logGroup, 0, Date.now());
    await writeJson(
      input.directory,
      join('logs', `${safeStem(input.logGroup)}.json`),
      events,
      files,
    );
    await writeFile(
      join(input.directory, 'EXPORT_OK'),
      `${JSON.stringify({ runId: input.runId, files }, null, 2)}\n`,
      'utf8',
    );
    return { ok: true, directory: input.directory, files };
  } catch (error) {
    return { ok: false, directory: input.directory, files, reason: safeError(error) };
  }
}

export async function exportRun(input: {
  clients: TeardownClients;
  config: SafetyConfig;
  runId: string;
  sleep: (ms: number) => Promise<void>;
}): Promise<ExportResult> {
  const directory = join(input.config.resultsRoot, input.runId);
  const files: string[] = [];
  try {
    const record = runRecord(input.config, input.runId);
    const names = await readAlarmNames(input.config.alertsPath);
    const alarms = await fetchAlarms(input.clients.cloudwatch, names);
    await writeJson(directory, 'run-record.json', record, files);
    if (alarms.length === 0) {
      await writeJson(
        directory,
        join('alarms', 'not-used.json'),
        {
          note: 'CloudWatch alarms are not generated. Alert evidence is grafana_alert_state_change log lines.',
        },
        files,
      );
    }
    for (const alarm of alarms) {
      await writeJson(directory, join('alarms', `${safeStem(alarm.alarmName)}.json`), alarm, files);
    }
    const definitions = await fetchQueryDefinitions(input.clients.logs);
    if (definitions.length === 0) {
      return {
        ok: false,
        directory,
        files,
        reason:
          'No saved Logs Insights queries to archive. Export failed. Create the saved queries before destroying anything.',
      };
    }
    await writeJson(directory, join('insights', 'definitions.json'), definitions, files);
    for (const definition of definitions) {
      const results = await runSavedQuery(
        input.clients.logs,
        definition,
        record.startedAt,
        record.endedAt,
        input.sleep,
      );
      await writeJson(
        directory,
        join('insights', `${safeStem(definition.name)}.json`),
        results,
        files,
      );
    }
    for (const logGroup of input.config.logGroups) {
      const events = await fetchLogEvents(
        input.clients.logs,
        logGroup,
        Date.parse(record.startedAt),
        Date.parse(record.endedAt),
      );
      await writeJson(directory, join('logs', `${safeStem(logGroup)}.json`), events, files);
    }
    await exportAlertEvidence(input, directory, record, files);
    await exportTraces(input, directory, record, files);
    for (const file of files) {
      const info = await stat(join(directory, file));
      if (info.size === 0) {
        throw new Error(`empty export file ${file}`);
      }
    }
    await writeFile(
      join(directory, 'EXPORT_OK'),
      `${JSON.stringify({ runId: input.runId, files }, null, 2)}\n`,
      'utf8',
    );
    return { ok: true, directory, files };
  } catch (error) {
    return { ok: false, directory, files, reason: safeError(error) };
  }
}

interface RunRecord {
  runId: string;
  loadProfile: string;
  startedAt: string;
  endedAt: string;
  faultInjection: { databaseTimeouts: 'on' | 'off'; paymentDelays: 'on' | 'off' };
  services: string[];
  loadGenerator: string;
}

function runRecord(config: SafetyConfig, runId: string): RunRecord {
  if (!config.loadProfile) {
    throw new Error('EXPERIMENT_LOAD_PROFILE is not set');
  }
  if (!config.startedAt || !config.endedAt) {
    throw new Error('EXPERIMENT_STARTED_AT and EXPERIMENT_ENDED_AT are required');
  }
  const started = Date.parse(config.startedAt);
  const ended = Date.parse(config.endedAt);
  if (Number.isNaN(started) || Number.isNaN(ended)) {
    throw new Error('EXPERIMENT_STARTED_AT and EXPERIMENT_ENDED_AT must be UTC timestamps');
  }
  if (ended <= started) {
    throw new Error('EXPERIMENT_ENDED_AT must be after EXPERIMENT_STARTED_AT');
  }
  return {
    runId,
    loadProfile: config.loadProfile,
    startedAt: new Date(started).toISOString(),
    endedAt: new Date(ended).toISOString(),
    faultInjection: {
      databaseTimeouts: config.databaseTimeouts,
      paymentDelays: config.paymentDelays,
    },
    services: ['shop', 'inventory', 'payment', 'delivery'],
    loadGenerator: 'loadgen',
  };
}

interface AlarmExport {
  alarmName: string;
  state?: string;
  threshold?: unknown;
  comparisonOperator?: string;
  evaluationPeriods?: unknown;
  period?: unknown;
  metricName?: string;
  namespace?: string;
  description?: string;
  history: unknown[];
}

async function fetchAlarms(cloudwatch: SdkClient, names: string[]): Promise<AlarmExport[]> {
  const found = new Map<string, AlarmExport>();
  let token: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    const page = asRecord(
      await cloudwatch.send(
        new DescribeAlarmsCommand({
          AlarmNames: token ? undefined : names,
          NextToken: token,
          MaxRecords: 100,
        }),
      ),
    );
    for (const item of asArray(page.MetricAlarms)) {
      const record = asRecord(item);
      const alarmName = asString(record.AlarmName);
      if (!alarmName) {
        continue;
      }
      found.set(alarmName, {
        alarmName,
        state: asString(record.StateValue),
        threshold: record.Threshold,
        comparisonOperator: asString(record.ComparisonOperator),
        evaluationPeriods: record.EvaluationPeriods,
        period: record.Period,
        metricName: asString(record.MetricName),
        namespace: asString(record.Namespace),
        description: asString(record.AlarmDescription),
        history: [],
      });
    }
    const next = asString(page.NextToken);
    if (!next) {
      break;
    }
    if (seen.has(next)) {
      throw new Error('pagination token repeated');
    }
    seen.add(next);
    token = next;
  }

  if (found.size === 0) {
    return [];
  }

  for (const name of names) {
    const alarm = found.get(name);
    if (!alarm) {
      continue;
    }
    alarm.history = await alarmHistory(cloudwatch, name);
  }
  return names
    .map((name) => found.get(name))
    .filter((alarm): alarm is AlarmExport => Boolean(alarm));
}

async function alarmHistory(cloudwatch: SdkClient, alarmName: string): Promise<unknown[]> {
  const items: unknown[] = [];
  let token: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    const page = asRecord(
      await cloudwatch.send(
        new DescribeAlarmHistoryCommand({
          AlarmName: alarmName,
          NextToken: token,
          MaxRecords: 100,
        }),
      ),
    );
    items.push(...asArray(page.AlarmHistoryItems));
    const next = asString(page.NextToken);
    if (!next) {
      return items;
    }
    if (seen.has(next)) {
      throw new Error('pagination token repeated');
    }
    seen.add(next);
    token = next;
  }
}

interface QueryDefinition {
  name: string;
  queryString: string;
  logGroupNames: string[];
}

async function fetchQueryDefinitions(logs: SdkClient): Promise<QueryDefinition[]> {
  const items: QueryDefinition[] = [];
  let token: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    const page = asRecord(
      await logs.send(new DescribeQueryDefinitionsCommand({ nextToken: token, maxResults: 100 })),
    );
    for (const item of asArray(page.queryDefinitions)) {
      const record = asRecord(item);
      const name = asString(record.name) ?? asString(record.queryDefinitionId);
      const queryString = asString(record.queryString);
      const logGroupNames = asArray(record.logGroupNames).filter(
        (group): group is string => typeof group === 'string',
      );
      if (!name || !queryString) {
        throw new Error('a saved Logs Insights query is missing a name or query string');
      }
      if (logGroupNames.length === 0) {
        throw new Error(`saved query ${name} has no log groups`);
      }
      items.push({ name, queryString, logGroupNames });
    }
    const next = asString(page.nextToken);
    if (!next) {
      return items;
    }
    if (seen.has(next)) {
      throw new Error('pagination token repeated');
    }
    seen.add(next);
    token = next;
  }
}

async function runSavedQuery(
  logs: SdkClient,
  definition: QueryDefinition,
  startedAt: string,
  endedAt: string,
  sleep: (ms: number) => Promise<void>,
): Promise<Record<string, unknown>> {
  const started = asRecord(
    await logs.send(
      new StartQueryCommand({
        logGroupNames: definition.logGroupNames,
        queryString: definition.queryString,
        startTime: Math.floor(Date.parse(startedAt) / 1000),
        endTime: Math.floor(Date.parse(endedAt) / 1000),
      }),
    ),
  );
  const queryId = asString(started.queryId);
  if (!queryId) {
    throw new Error(`saved query ${definition.name} did not return an id`);
  }
  for (let attempt = 0; attempt < MAX_QUERY_POLLS; attempt += 1) {
    const page = asRecord(await logs.send(new GetQueryResultsCommand({ queryId })));
    const status = asString(page.status);
    if (status === 'Complete') {
      return {
        name: definition.name,
        status,
        results: asArray(page.results),
      };
    }
    if (status === 'Failed' || status === 'Cancelled' || status === 'Timeout') {
      throw new Error(`saved query ${definition.name} ${status}`);
    }
    await sleep(50);
  }
  throw new Error(`saved query ${definition.name} did not finish`);
}

async function exportAlertEvidence(
  input: { clients: TeardownClients; config: SafetyConfig },
  directory: string,
  record: RunRecord,
  files: string[],
): Promise<void> {
  const events = await fetchLogEvents(
    input.clients.logs,
    ALERT_LOG_GROUP,
    Date.parse(record.startedAt),
    Date.parse(record.endedAt),
    'grafana_alert_state_change',
  );
  await writeJson(directory, join('alerts', 'state-changes.json'), events, files);
  const rules = Object.entries(buildProvisioningFiles(readCatalog(input.config.alertsPath))).filter(
    ([name]) => name.startsWith('alerting/'),
  );
  if (rules.length === 0) {
    throw new Error('Grafana-provisioned rule files were not generated');
  }
  for (const [name, body] of rules) {
    await writeText(
      directory,
      join('alerts', 'rules', name.slice('alerting/'.length)),
      body,
      files,
    );
  }
}

async function exportTraces(
  input: { clients: TeardownClients; config: SafetyConfig },
  directory: string,
  record: RunRecord,
  files: string[],
): Promise<void> {
  const ids = await traceIds(input.clients.xray, record.startedAt, record.endedAt);
  if (ids.length === 0) {
    if (input.config.checkoutCount !== 0) {
      throw new Error(
        'No traces exported. The export failed unless the run recorded zero checkouts (EXPERIMENT_CHECKOUT_COUNT=0).',
      );
    }
    await writeJson(
      directory,
      join('traces', 'none.json'),
      { checkouts: 0, traces: [], missingHops: [] },
      files,
    );
    return;
  }
  for (const id of ids) {
    const segments = await traceSegments(input.clients.xray, id);
    await writeJson(
      directory,
      join('traces', `${safeStem(id)}.json`),
      shapeTrace(id, segments),
      files,
    );
  }
}

async function traceIds(xray: SdkClient, startedAt: string, endedAt: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const filter of CHECKOUT_TRACE_FILTERS) {
    let token: string | undefined;
    const seen = new Set<string>();
    for (;;) {
      const page = asRecord(
        await xray.send(
          new GetTraceSummariesCommand({
            StartTime: new Date(startedAt),
            EndTime: new Date(endedAt),
            FilterExpression: filter,
            NextToken: token,
          }),
        ),
      );
      for (const item of asArray(page.TraceSummaries)) {
        const id = asString(asRecord(item).Id);
        if (id) {
          ids.add(id);
        }
        if (ids.size >= 20) {
          return [...ids];
        }
      }
      const next = asString(page.NextToken);
      if (!next || seen.has(next)) {
        break;
      }
      seen.add(next);
      token = next;
    }
  }
  return [...ids];
}

async function traceSegments(xray: SdkClient, id: string): Promise<unknown[]> {
  const page = asRecord(await xray.send(new BatchGetTracesCommand({ TraceIds: [id] })));
  const trace = asRecord(asArray(page.Traces)[0]);
  return asArray(trace.Segments);
}

async function fetchLogEvents(
  logs: SdkClient,
  logGroup: string,
  startTime: number,
  endTime: number,
  filterPattern?: string,
): Promise<Record<string, unknown>> {
  const events: unknown[] = [];
  let token: string | undefined;
  const seen = new Set<string>();
  try {
    for (;;) {
      const page = asRecord(
        await logs.send(
          new FilterLogEventsCommand({
            logGroupName: logGroup,
            startTime,
            endTime,
            filterPattern,
            nextToken: token,
            limit: 1000,
          }),
        ),
      );
      events.push(
        ...asArray(page.events)
          .map((event) => {
            const record = asRecord(event);
            return { timestamp: record.timestamp, message: record.message };
          })
          .filter(
            (event) =>
              !filterPattern ||
              (typeof event.message === 'string' && event.message.includes(filterPattern)),
          ),
      );
      if (events.length > MAX_LOG_EVENTS) {
        throw new Error(`log group ${logGroup} exceeded the export event cap`);
      }
      const next = asString(page.nextToken);
      if (!next) {
        break;
      }
      if (seen.has(next)) {
        throw new Error('pagination token repeated');
      }
      seen.add(next);
      token = next;
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('exceeded the export event cap')) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/ResourceNotFound|does not exist/i.test(message)) {
      throw new Error(`log group ${logGroup} was not found`, { cause: error });
    }
    throw error;
  }
  return { logGroup, events };
}

async function writeText(
  directory: string,
  relative: string,
  value: string,
  files: string[],
): Promise<void> {
  const target = join(directory, relative);
  await mkdir(dirname(target), { recursive: true });
  const body = value.endsWith('\n') ? value : `${value}\n`;
  await writeFile(target, redactText(body), 'utf8');
  files.push(relative);
}

async function writeJson(
  directory: string,
  relative: string,
  value: unknown,
  files: string[],
): Promise<void> {
  const target = join(directory, relative);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${redactText(JSON.stringify(value, null, 2))}\n`, 'utf8');
  files.push(relative);
}

function safeStem(name: string): string {
  const stem = name.replace(/[^A-Za-z0-9._-]+/g, '_');
  if (!stem) {
    throw new Error('export file name is empty');
  }
  return stem;
}
