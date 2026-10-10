import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { BUDGET_CATALOG_NAME } from '../tags.js';

export interface CatalogAlert {
  name: string;
  signal: string;
  service: string;
  operation: string;
  groupBy?: string;
  condition: string;
  threshold: string;
  window: string;
  minRequestCount?: number;
  missingData?: 'not_breaching' | 'breaching';
  severity: string;
  why: string;
  retainOnTeardown: boolean;
}

export function readCatalog(alertsPath: string): CatalogAlert[] {
  return parseCatalog(readFileSync(alertsPath, 'utf8'));
}

export function parseCatalog(yamlText: string): CatalogAlert[] {
  const parsed = parse(yamlText) as unknown;
  if (parsed === null || typeof parsed !== 'object' || !('alerts' in parsed)) {
    throw new Error('alerts.yml is missing the alerts list');
  }
  const alerts = (parsed as { alerts?: unknown }).alerts;
  if (!Array.isArray(alerts) || alerts.length === 0) {
    throw new Error('alerts.yml did not contain any alerts');
  }
  return alerts.map((entry, index) => parseAlert(entry, index));
}

/** Grafana rules. The budget entry stays an AWS Budgets alert and is not a rule. */
export function grafanaAlerts(alerts: readonly CatalogAlert[]): CatalogAlert[] {
  return alerts.filter((alert) => !alert.retainOnTeardown && alert.name !== BUDGET_CATALOG_NAME);
}

function parseAlert(entry: unknown, index: number): CatalogAlert {
  if (entry === null || typeof entry !== 'object') {
    throw new Error(`alert ${index} is not an object`);
  }
  const record = entry as Record<string, unknown>;
  const scope =
    record.scope !== null && typeof record.scope === 'object'
      ? (record.scope as Record<string, unknown>)
      : undefined;
  const name = requiredString(record.name, `alert ${index} name`);
  const missing = record.missing_data;
  if (missing !== undefined && missing !== 'not_breaching' && missing !== 'breaching') {
    throw new Error(`${name} missing_data must be not_breaching or breaching`);
  }
  const min = record.min_request_count;
  if (min !== undefined && (typeof min !== 'number' || !Number.isFinite(min))) {
    throw new Error(`${name} min_request_count must be a number`);
  }
  return {
    name,
    signal: requiredString(record.signal, `${name} signal`),
    service: requiredString(scope?.service, `${name} service`),
    operation: requiredString(scope?.operation, `${name} operation`),
    groupBy: optionalString(record.group_by),
    condition: requiredString(record.condition, `${name} condition`),
    threshold: requiredString(record.threshold, `${name} threshold`),
    window: requiredString(record.window, `${name} window`),
    minRequestCount: min,
    missingData: missing,
    severity: requiredString(record.severity, `${name} severity`),
    why: requiredString(record.why, `${name} why`),
    retainOnTeardown: record.retain_on_teardown === true,
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
