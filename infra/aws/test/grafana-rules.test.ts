import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { grafanaAlerts, readCatalog } from '../src/grafana/catalog.js';
import { buildProvisioningFiles } from '../src/grafana/provision.js';
import { formatAlertLines, receiverScript } from '../src/grafana/receiver.js';
import { BUDGET_CATALOG_NAME } from '../src/tags.js';

const ALERTS = fileURLToPath(new URL('../../../observability/alerts.yml', import.meta.url));

function files(): Record<string, string> {
  return buildProvisioningFiles(readCatalog(ALERTS));
}

function rules(body: string): Record<string, unknown>[] {
  const document = parse(body) as {
    groups: { rules: Record<string, unknown>[] }[];
  };
  return document.groups[0]?.rules ?? [];
}

describe('grafana alert generator', () => {
  it('turns every non-budget catalog alert into one provisioned rule', () => {
    const catalog = readCatalog(ALERTS);
    const generated = grafanaAlerts(catalog);
    const provisioned = rules(files()['alerting/rules.yml'] ?? '');
    expect(generated.map((alert) => alert.name)).not.toContain(BUDGET_CATALOG_NAME);
    expect(provisioned.map((rule) => rule.title)).toEqual(generated.map((alert) => alert.name));
    expect(generated.length).toBeGreaterThan(0);
  });

  it('maps min request count, missing data, severity, and reason', () => {
    const catalog = grafanaAlerts(readCatalog(ALERTS));
    const byName = new Map(
      rules(files()['alerting/rules.yml'] ?? '').map((rule) => [rule.title, rule]),
    );
    for (const alert of catalog) {
      const rule = byName.get(alert.name);
      expect(rule, alert.name).toBeDefined();
      expect(rule?.labels).toMatchObject({ severity: alert.severity, service: alert.service });
      expect(rule?.annotations).toMatchObject({ reason: alert.why, summary: alert.why });
      expect(rule?.noDataState).toBe(alert.missingData === 'breaching' ? 'Alerting' : 'OK');
      if (alert.minRequestCount !== undefined) {
        expect(JSON.stringify(rule?.data)).toContain(`$RS >= ${alert.minRequestCount}`);
      }
    }
    const zero = catalog.find((alert) => alert.name === 'request-rate-zero');
    expect(zero?.missingData).toBe('breaching');
    expect(byName.get('request-rate-zero')?.noDataState).toBe('Alerting');
  });

  it('uses one webhook contact point for firing and informational routes', () => {
    const provisioned = files();
    const blob = Object.values(provisioned).join('\n').toLowerCase();
    const contacts = parse(provisioned['alerting/contact-points.yml'] ?? '') as {
      contactPoints: { name: string; receivers: { type: string; settings: { url: string } }[] }[];
    };
    const policies = parse(provisioned['alerting/policies.yml'] ?? '') as {
      policies: { receiver: string; routes: { receiver: string; matchers: string[] }[] }[];
    };
    expect(contacts.contactPoints).toHaveLength(1);
    expect(contacts.contactPoints[0]?.receivers).toEqual([
      expect.objectContaining({
        type: 'webhook',
        settings: { url: 'http://localhost:8088/alerts', httpMethod: 'POST' },
      }),
    ]);
    expect(policies.policies[0]?.receiver).toBe('otel-demo-log');
    expect(policies.policies[0]?.routes).toEqual([
      expect.objectContaining({
        receiver: 'otel-demo-log',
        matchers: ['severity = informational'],
      }),
    ]);
    expect(blob).not.toContain('email');
    expect(blob).not.toContain('pagerduty');
    expect(blob).not.toContain('sns');
    expect(blob).not.toContain('cloudwatch alarm');
  });

  it('provisions CloudWatch and X-Ray data sources and one dashboard row per service', () => {
    const provisioned = files();
    const sources = parse(provisioned['datasources/datasources.yml'] ?? '') as {
      datasources: { name: string; type: string; jsonData?: { tracingDatasourceUid?: string } }[];
    };
    expect(sources.datasources.map((source) => `${source.type}:${source.name}`)).toEqual([
      'cloudwatch:CloudWatch metrics',
      'cloudwatch:CloudWatch Logs',
      'grafana-x-ray-datasource:X-Ray',
    ]);
    expect(sources.datasources[1]?.jsonData?.tracingDatasourceUid).toBe('xray');
    const dashboard = JSON.parse(provisioned['dashboards/otel-demo.json'] ?? '') as {
      panels: { type: string; title: string }[];
    };
    const titles = dashboard.panels.map((panel) => panel.title);
    for (const service of ['shop', 'inventory', 'payment', 'delivery']) {
      expect(titles).toContain(service);
      expect(titles).toEqual(
        expect.arrayContaining([
          `${service} Request rate`,
          `${service} Error rate`,
          `${service} p50`,
          `${service} p95`,
          `${service} p99`,
          `${service} Outbound calls`,
        ]),
      );
    }
    expect(titles).toContain('all lines for a trace id');
    expect(titles).toContain('errors by service last 15m');
    expect(provisioned['dashboards/otel-demo.json']).toContain('xray_trace_id');
  });
});

describe('alert webhook receiver', () => {
  it('logs firing and resolved state changes as structured lines', () => {
    const now = '2026-10-10T00:00:00.000Z';
    const lines = formatAlertLines(
      {
        alerts: [
          {
            status: 'firing',
            previousState: 'Normal',
            labels: { alertname: 'shop-checkout-5xx-rate', severity: 'critical' },
            annotations: { reason: 'orders are failing' },
          },
          {
            status: 'resolved',
            labels: { alertname: 'request-rate-zero', severity: 'informational' },
            annotations: { summary: 'traffic returned' },
          },
        ],
      },
      now,
    );
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      event: 'grafana_alert_state_change',
      rule: 'shop-checkout-5xx-rate',
      severity: 'critical',
      previous: 'Normal',
      state: 'firing',
      time: now,
      reason: 'orders are failing',
    });
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({
      rule: 'request-rate-zero',
      severity: 'informational',
      state: 'resolved',
      time: now,
      reason: 'traffic returned',
    });
  });

  it('ships a localhost receiver and skips a body with no rule name', () => {
    expect(formatAlertLines({ status: 'firing' }, '2026-10-10T00:00:00.000Z')).toEqual([]);
    const script = receiverScript();
    expect(script).toContain('localhost');
    expect(script).toContain('grafana_alert_state_change');
    expect(script).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});
