import { stringify } from 'yaml';
import { grafanaAlerts, type CatalogAlert } from './catalog.js';

const REGION = 'eu-central-1';
const METRIC_NAMESPACE = 'otel-demo';
const METRICS_UID = 'cw-metrics';
const LOGS_UID = 'cw-logs';
const XRAY_UID = 'xray';
const CONTACT = 'otel-demo-log';

const LOG_GROUPS = [
  '/otel-demo/shop',
  '/otel-demo/inventory',
  '/otel-demo/payment',
  '/otel-demo/delivery',
  '/otel-demo/loadgen',
  '/otel-demo/alerts',
];

export const TRACE_QUERY_NAME = 'otel-demo-all-lines-for-a-trace-id';
export const ERRORS_QUERY_NAME = 'otel-demo-errors-by-service-last-15m';

export const TRACE_QUERY = [
  'fields @timestamp, @message, service, level, trace_id, xray_trace_id',
  '| filter xray_trace_id = "TRACE_ID" or trace_id = "TRACE_ID"',
  '| sort @timestamp asc',
].join('\n');

export const ERRORS_QUERY = [
  'fields @timestamp, service, level, msg',
  '| filter level = "error"',
  '| stats count() by service',
].join('\n');

/** File-provisioning documents, keyed by path under Grafana's provisioning directory. */
export function buildProvisioningFiles(alerts: readonly CatalogAlert[]): Record<string, string> {
  const rules = grafanaAlerts(alerts);
  return {
    'datasources/datasources.yml': stringify(datasources()),
    'dashboards/dashboards.yml': stringify(dashboardProvider()),
    'dashboards/otel-demo.json': `${JSON.stringify(dashboard(), null, 2)}\n`,
    'alerting/rules.yml': stringify(ruleFile(rules)),
    'alerting/contact-points.yml': stringify(contactPoints()),
    'alerting/policies.yml': stringify(policies()),
  };
}

export function datasources(): Record<string, unknown> {
  return {
    apiVersion: 1,
    datasources: [
      cloudwatchDatasource('CloudWatch metrics', METRICS_UID),
      {
        ...cloudwatchDatasource('CloudWatch Logs', LOGS_UID),
        jsonData: {
          authType: 'default',
          defaultRegion: REGION,
          tracingDatasourceUid: XRAY_UID,
        },
      },
      {
        name: 'X-Ray',
        uid: XRAY_UID,
        type: 'grafana-x-ray-datasource',
        access: 'proxy',
        isDefault: false,
        jsonData: {
          authType: 'default',
          defaultRegion: REGION,
        },
      },
    ],
  };
}

function cloudwatchDatasource(name: string, uid: string): Record<string, unknown> {
  return {
    name,
    uid,
    type: 'cloudwatch',
    access: 'proxy',
    isDefault: uid === METRICS_UID,
    jsonData: {
      authType: 'default',
      defaultRegion: REGION,
    },
  };
}

function dashboardProvider(): Record<string, unknown> {
  return {
    apiVersion: 1,
    providers: [
      {
        name: 'otel-demo',
        orgId: 1,
        folder: 'otel-demo',
        type: 'file',
        disableDeletion: false,
        updateIntervalSeconds: 60,
        options: { path: '/etc/grafana/provisioning/dashboards' },
      },
    ],
  };
}

function contactPoints(): Record<string, unknown> {
  return {
    apiVersion: 1,
    contactPoints: [
      {
        orgId: 1,
        name: CONTACT,
        receivers: [
          {
            uid: CONTACT,
            type: 'webhook',
            settings: {
              url: 'http://localhost:8088/alerts',
              httpMethod: 'POST',
            },
            disableResolveMessage: false,
          },
        ],
      },
    ],
  };
}

function policies(): Record<string, unknown> {
  return {
    apiVersion: 1,
    policies: [
      {
        orgId: 1,
        receiver: CONTACT,
        group_by: ['alertname'],
        routes: [
          {
            receiver: CONTACT,
            matchers: ['severity = informational'],
            continue: false,
          },
        ],
      },
    ],
  };
}

function ruleFile(alerts: readonly CatalogAlert[]): Record<string, unknown> {
  return {
    apiVersion: 1,
    groups: [
      {
        orgId: 1,
        name: 'otel-demo',
        folder: 'otel-demo',
        interval: '1m',
        rules: alerts.map(rule),
      },
    ],
  };
}

function rule(alert: CatalogAlert): Record<string, unknown> {
  const range = windowSeconds(alert.window);
  const noDataState = alert.missingData === 'breaching' ? 'Alerting' : 'OK';
  return {
    uid: alert.name,
    title: alert.name,
    condition: 'C',
    data: ruleData(alert, range),
    noDataState,
    execErrState: 'Error',
    for: alert.window,
    labels: {
      severity: alert.severity,
      service: alert.service,
      operation: alert.operation,
    },
    annotations: {
      summary: alert.why,
      reason: alert.why,
      threshold: alert.threshold,
      condition: alert.condition,
    },
  };
}

function ruleData(alert: CatalogAlert, rangeSeconds: number): Record<string, unknown>[] {
  const kind = classify(alert);
  const period = String(Math.min(rangeSeconds, 3600));
  if (kind === 'log-volume') {
    return [
      query(
        'A',
        rangeSeconds,
        insightsQuery(
          'SELECT SUM(IncomingBytes) FROM SCHEMA("AWS/Logs", LogGroupName) WHERE LogGroupName LIKE \'/otel-demo/%\'',
          period,
          'Sum',
        ),
      ),
      reduce('M', 'A'),
      threshold('C', 'M', 'gt', 3 * 1024 * 1024 * 1024),
    ];
  }
  if (kind === 'request-zero') {
    return [
      query('A', rangeSeconds, metricQuery(alert, 'http.server.requests', 'Sum', period, false)),
      reduce('M', 'A'),
      threshold('C', 'M', 'lt', 1),
    ];
  }
  if (kind === 'db-timeout' || kind === 'payment-stuck' || kind === 'loadgen') {
    const metric =
      kind === 'db-timeout'
        ? 'db.client.timeouts'
        : kind === 'loadgen'
          ? 'loadgen.over_cap'
          : alert.name.includes('authorized')
            ? 'payment.stuck.authorized'
            : 'payment.stuck.unknown';
    const statistic = kind === 'loadgen' ? 'Maximum' : 'Sum';
    const expression = kind === 'payment-stuck' ? '$A >= 1' : '$A > 0';
    return [
      query('A', rangeSeconds, metricQuery(alert, metric, statistic, period, false)),
      math('M', expression),
      threshold('C', 'M', 'gt', 0),
    ];
  }

  const ratio = ratioMetrics(kind);
  const limit = numericThreshold(alert);
  const gate = alert.minRequestCount === undefined ? '$RS > 0' : `$RS >= ${alert.minRequestCount}`;
  const comparison =
    kind === 'http-p99' ? `$P > ${limit}` : `($ES / ($RS + 0.000001)) * 100 > ${limit}`;
  const data: Record<string, unknown>[] = [
    query(
      'E',
      rangeSeconds,
      kind === 'http-p99'
        ? metricQuery(alert, 'http.server.request.duration', 'p99', period, true)
        : metricQuery(alert, ratio.numerator, 'Sum', period, kind === 'http-5xx'),
    ),
    query(
      'R',
      rangeSeconds,
      metricQuery(alert, ratio.denominator, 'Sum', period, kind === 'http-5xx'),
    ),
  ];
  if (kind === 'http-p99') {
    data.push(
      reduce('P', 'E', 'last'),
      reduce('RS', 'R'),
      math('M', `(${gate}) * (${comparison})`),
    );
  } else {
    data.push(reduce('ES', 'E'), reduce('RS', 'R'), math('M', `(${gate}) * (${comparison})`));
  }
  data.push(threshold('C', 'M', 'gt', 0));
  return data;
}

function ratioMetrics(kind: RuleKind): { numerator: string; denominator: string } {
  if (kind === 'outbound') {
    return { numerator: 'outbound.errors', denominator: 'outbound.calls' };
  }
  if (kind === 'allocation-conflict') {
    return {
      numerator: 'inventory.allocation.conflicts',
      denominator: 'inventory.allocation.attempts',
    };
  }
  if (kind === 'out-of-stock') {
    return { numerator: 'inventory.out_of_stock', denominator: 'inventory.allocation.attempts' };
  }
  return { numerator: 'http.server.errors', denominator: 'http.server.requests' };
}

type RuleKind =
  | 'http-5xx'
  | 'http-p99'
  | 'outbound'
  | 'db-timeout'
  | 'payment-stuck'
  | 'allocation-conflict'
  | 'out-of-stock'
  | 'loadgen'
  | 'request-zero'
  | 'log-volume';

function classify(alert: CatalogAlert): RuleKind {
  if (alert.name === 'cloudwatch-log-ingestion-volume') {
    return 'log-volume';
  }
  if (alert.name === 'request-rate-zero') {
    return 'request-zero';
  }
  if (alert.name === 'load-generator-exceeds-caps') {
    return 'loadgen';
  }
  if (alert.name.includes('db-timeout')) {
    return 'db-timeout';
  }
  if (alert.name.includes('stuck')) {
    return 'payment-stuck';
  }
  if (alert.name.includes('allocation-conflict')) {
    return 'allocation-conflict';
  }
  if (alert.name.includes('out-of-stock')) {
    return 'out-of-stock';
  }
  if (alert.name.includes('outbound')) {
    return 'outbound';
  }
  if (alert.name.includes('p99')) {
    return 'http-p99';
  }
  return 'http-5xx';
}

function metricQuery(
  alert: CatalogAlert,
  metricName: string,
  statistic: string,
  period: string,
  includeOperation: boolean,
): Record<string, unknown> {
  if (alert.groupBy) {
    const dims = ['service', 'operation', alert.groupBy].join(', ');
    return insightsQuery(
      `SELECT SUM(${quoteMetric(metricName)}) FROM SCHEMA("${METRIC_NAMESPACE}", ${dims}) WHERE service = '${alert.service}' AND operation = '${alert.operation}' GROUP BY ${alert.groupBy}`,
      period,
      statistic,
    );
  }
  const dimensions: Record<string, string> = {};
  if (alert.service !== 'experiment') {
    dimensions.service = alert.service;
  }
  if (includeOperation && alert.operation !== 'all') {
    dimensions.operation = alert.operation;
  }
  return {
    refId: 'A',
    namespace: METRIC_NAMESPACE,
    metricName,
    dimensions,
    statistic,
    period,
    region: REGION,
    queryMode: 'Metrics',
    metricQueryType: 0,
    metricEditorMode: 0,
    matchExact: true,
  };
}

function insightsQuery(sql: string, period: string, statistic: string): Record<string, unknown> {
  return {
    refId: 'A',
    region: REGION,
    queryMode: 'Metrics',
    // Metrics Insights SQL (metricQueryType 1, code editor). Grafana still
    // requires statistic or statistics before it will run the SQL.
    metricQueryType: 1,
    metricEditorMode: 1,
    sqlExpression: sql,
    statistic,
    period,
  };
}

function quoteMetric(name: string): string {
  return `"${name}"`;
}

function query(
  refId: string,
  rangeSeconds: number,
  model: Record<string, unknown>,
): Record<string, unknown> {
  return {
    refId,
    relativeTimeRange: { from: rangeSeconds, to: 0 },
    datasourceUid: METRICS_UID,
    model: {
      ...model,
      refId,
      datasource: { type: 'cloudwatch', uid: METRICS_UID },
    },
  };
}

function reduce(
  refId: string,
  expression: string,
  reducer: 'sum' | 'last' = 'sum',
): Record<string, unknown> {
  return {
    refId,
    relativeTimeRange: { from: 0, to: 0 },
    datasourceUid: '__expr__',
    model: {
      refId,
      type: 'reduce',
      expression,
      reducer,
      datasource: { type: '__expr__', uid: '__expr__' },
    },
  };
}

function math(refId: string, expression: string): Record<string, unknown> {
  return {
    refId,
    relativeTimeRange: { from: 0, to: 0 },
    datasourceUid: '__expr__',
    model: {
      refId,
      type: 'math',
      expression,
      datasource: { type: '__expr__', uid: '__expr__' },
    },
  };
}

function threshold(
  refId: string,
  expression: string,
  type: 'gt' | 'lt',
  value: number,
): Record<string, unknown> {
  return {
    refId,
    relativeTimeRange: { from: 0, to: 0 },
    datasourceUid: '__expr__',
    model: {
      refId,
      type: 'threshold',
      expression,
      conditions: [
        {
          evaluator: { type, params: [value] },
          operator: { type: 'and' },
          query: { params: [refId] },
          reducer: { type: 'last', params: [] },
          type: 'query',
        },
      ],
      datasource: { type: '__expr__', uid: '__expr__' },
    },
  };
}

function numericThreshold(alert: CatalogAlert): number {
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(alert.threshold.trim());
  if (percent?.[1]) {
    return Number(percent[1]);
  }
  const millis = /^(\d+(?:\.\d+)?)ms$/.exec(alert.threshold.trim());
  if (millis?.[1]) {
    return Number(millis[1]);
  }
  const seconds = /^(\d+(?:\.\d+)?)s$/.exec(alert.threshold.trim());
  if (seconds?.[1]) {
    return Number(seconds[1]) * 1000;
  }
  return 0;
}

function windowSeconds(window: string): number {
  const match = /^(\d+)(m|h)$/.exec(window.trim());
  if (!match?.[1] || !match[2]) {
    return 300;
  }
  const amount = Number(match[1]);
  return match[2] === 'h' ? amount * 3600 : amount * 60;
}

const DASHBOARD_SERVICES = ['shop', 'inventory', 'payment', 'delivery'] as const;

function dashboard(): Record<string, unknown> {
  const panels: Record<string, unknown>[] = [];
  let id = 1;
  let y = 0;
  for (const service of DASHBOARD_SERVICES) {
    panels.push({
      id: id++,
      type: 'row',
      title: service,
      gridPos: { h: 1, w: 24, x: 0, y },
      collapsed: false,
    });
    y += 1;
    const specs = [
      ['Request rate', search(service, 'http.server.requests', 'Sum')],
      ['Error rate', search(service, 'http.server.errors', 'Sum')],
      ['p50', search(service, 'http.server.request.duration', 'p50')],
      ['p95', search(service, 'http.server.request.duration', 'p95')],
      ['p99', search(service, 'http.server.request.duration', 'p99')],
      ['Outbound calls', search(service, 'outbound.calls', 'Sum')],
    ] as const;
    specs.forEach((spec, index) => {
      panels.push(statPanel(id++, spec[0], service, spec[1], index * 4, y));
    });
    y += 6;
  }
  panels.push(tracePanel(id++, y));
  y += 8;
  panels.push(errorPanel(id++, y));
  return {
    uid: 'otel-demo',
    title: 'otel-demo',
    tags: ['otel-demo'],
    timezone: 'utc',
    schemaVersion: 39,
    version: 1,
    refresh: '1m',
    time: { from: 'now-1h', to: 'now' },
    templating: {
      list: [
        {
          name: 'trace_id',
          type: 'textbox',
          label: 'trace id',
          current: { text: '', value: '' },
        },
      ],
    },
    panels,
  };
}

function search(service: string, metric: string, statistic: string): string {
  return `SEARCH('{${METRIC_NAMESPACE},service,operation} MetricName="${metric}" service="${service}"', '${statistic}', 60)`;
}

function statPanel(
  id: number,
  title: string,
  service: string,
  expression: string,
  x: number,
  y: number,
): Record<string, unknown> {
  return {
    id,
    type: 'timeseries',
    title: `${service} ${title}`,
    gridPos: { h: 6, w: 4, x, y },
    datasource: { type: 'cloudwatch', uid: METRICS_UID },
    fieldConfig: { defaults: { unit: title.startsWith('p') ? 'ms' : 'short' }, overrides: [] },
    targets: [
      {
        refId: 'A',
        region: REGION,
        queryMode: 'Metrics',
        metricQueryType: 0,
        metricEditorMode: 1,
        expression,
      },
    ],
  };
}

function tracePanel(id: number, y: number): Record<string, unknown> {
  return {
    id,
    type: 'logs',
    title: 'all lines for a trace id',
    description:
      'Saved query: all lines for a trace id. The xray_trace_id field links to the X-Ray data source.',
    gridPos: { h: 8, w: 24, x: 0, y },
    datasource: { type: 'cloudwatch', uid: LOGS_UID },
    targets: [
      {
        refId: 'A',
        region: REGION,
        queryMode: 'Logs',
        logGroupNames: LOG_GROUPS,
        expression: [
          'fields @timestamp, @message, service, level, trace_id, xray_trace_id',
          '| filter xray_trace_id = "$trace_id" or trace_id = "$trace_id"',
          '| sort @timestamp asc',
        ].join('\n'),
      },
    ],
    options: { showTime: true, enableLogDetails: true, dedupStrategy: 'none' },
    fieldConfig: {
      defaults: {},
      overrides: [
        {
          matcher: { id: 'byName', options: 'xray_trace_id' },
          properties: [
            {
              id: 'links',
              value: [
                {
                  title: 'xray_trace_id',
                  url: '/explore?schemaVersion=1&panes={"xray":{"datasource":"xray","queries":[{"refId":"A","queryType":"getTrace","query":"${__value.raw}"}]}}',
                  targetBlank: true,
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

function errorPanel(id: number, y: number): Record<string, unknown> {
  return {
    id,
    type: 'table',
    title: 'errors by service last 15m',
    gridPos: { h: 8, w: 24, x: 0, y },
    timeFrom: '15m',
    datasource: { type: 'cloudwatch', uid: LOGS_UID },
    targets: [
      {
        refId: 'A',
        region: REGION,
        queryMode: 'Logs',
        logGroupNames: LOG_GROUPS,
        expression: ERRORS_QUERY,
      },
    ],
  };
}
