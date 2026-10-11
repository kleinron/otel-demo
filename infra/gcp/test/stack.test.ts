import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hardStopCron } from '../src/hard-stop.js';

const terraformDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'terraform');
const docsPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'gcp-spike.md',
);

const IPV4 =
  /\b(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\b/;

function terraformText(): string {
  return readdirSync(terraformDir)
    .filter((name) => name.endsWith('.tf') || name.endsWith('.tftpl') || name.endsWith('.example'))
    .map((name) => readFileSync(join(terraformDir, name), 'utf8'))
    .join('\n');
}

describe('GCP terraform spike', () => {
  const text = terraformText();
  const docs = readFileSync(docsPath, 'utf8');

  it('defines one Cloud Run service, a collector sidecar, and always-on CPU', () => {
    expect(text).toContain('resource "google_cloud_run_v2_service" "shop"');
    expect(text).toContain('min_instance_count = 1');
    expect(text.match(/cpu_idle\s*=\s*false/g)?.length).toBe(2);
    expect(text).toContain('name  = "collector"');
    expect(text).toContain('exporters: [googlecloud]');
    expect(text).toContain('endpoint: localhost:4318');
    expect(text).toContain('LOG_FORMAT');
    expect(text).toContain('CLOUD_PROVIDER');
    expect(text).toContain('value = "gcp"');
  });

  it('creates Artifact Registry, a budget defaulting to 25 USD, and a hard stop', () => {
    expect(text).toContain('resource "google_artifact_registry_repository" "demo"');
    expect(text).toContain('resource "google_billing_budget" "spike"');
    expect(text).toContain('resource "google_pubsub_topic" "budget"');
    expect(text).toContain('depends_on = ["collector"]');
    expect(text).toContain('default     = 25');
    expect(text).toContain('default     = "2026-10-14T00:00:00Z"');
    expect(text).toContain('resource "google_cloud_scheduler_job" "hard_stop"');
    expect(text).toContain('manualInstanceCount = 0');
    expect(text).toContain('default     = "me-west1"');
    expect(text).toContain('europe-west1');
    expect(text).toContain('me-west1');
    expect(hardStopCron('2026-10-14T00:00:00Z')).toBe('0 0 14 10 *');
  });

  it('keeps secrets and addresses out of the spike files', () => {
    expect(text).not.toMatch(IPV4);
    expect(docs).not.toMatch(IPV4);
    expect(text).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    expect(docs).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    expect(text).not.toMatch(/\b[0-9]{12}\b/);
    expect(docs).not.toMatch(/\b[0-9]{12}\b/);
    const secretData = text.match(/secret_data\s*=\s*"[^"]*"/g) ?? [];
    expect(secretData).toEqual(['secret_data = "off"']);
  });

  it('documents deploy, the view-trace link, teardown, and key hygiene', () => {
    expect(docs).toContain('terraform apply');
    expect(docs).toContain('view trace');
    expect(docs).toContain('logging.googleapis.com/trace');
    expect(docs).toContain('gcloud projects delete');
    expect(docs).toContain('gcloud billing budgets list');
    expect(docs).toContain('gcloud run services list');
    expect(docs).toContain('JSON');
    expect(docs).toMatch(/delete it when the spike is over/i);
  });
});
