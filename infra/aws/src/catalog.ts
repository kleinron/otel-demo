import { readFile } from 'node:fs/promises';
import { BUDGET_CATALOG_NAME } from './tags.js';

/** CloudWatch alarm names generated from the catalog. The budget entry is not an alarm. */
export function cloudWatchAlarmNames(catalogYaml: string): string[] {
  const names: string[] = [];
  for (const line of catalogYaml.split(/\r?\n/)) {
    const match = /^\s*- name:\s*([A-Za-z0-9-]+)\s*$/.exec(line);
    const name = match?.[1];
    if (!name || name === BUDGET_CATALOG_NAME) {
      continue;
    }
    names.push(name);
  }
  if (names.length === 0) {
    throw new Error('alerts.yml did not contain any CloudWatch alarm names');
  }
  return names;
}

export async function readAlarmNames(alertsPath: string): Promise<string[]> {
  const text = await readFile(alertsPath, 'utf8');
  return cloudWatchAlarmNames(text);
}
