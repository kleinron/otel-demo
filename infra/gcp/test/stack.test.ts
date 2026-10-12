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
    // One dynamic block for the four app containers, one for the collector.
    expect(text.match(/cpu_idle\s*=\s*false/g)?.length).toBe(2);
    expect(text).toContain('name  = "collector"');
    expect(text).toContain('exporters: [googlecloud]');
    expect(text).toContain('endpoint: localhost:4318');
    expect(text).toContain('endpoint: ${health_bind}');
    expect(text).not.toContain('endpoint: localhost:13133');
    expect(text).toContain('deletion_protection = false');
    expect(text).not.toContain('name  = "PORT"');
    expect(text).toContain('LOG_FORMAT');
    expect(text).toContain('CLOUD_PROVIDER');
    expect(text).toMatch(/LOG_FORMAT\s*=\s*"gcp"/);
    expect(text).toMatch(/CLOUD_PROVIDER\s*=\s*"gcp"/);
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
    expect(text).toContain('scalingMode         = "MANUAL"');
    expect(text).toContain('updateMask=scaling.scalingMode,scaling.manualInstanceCount');
    expect(text).toContain('count  = var.create_budget ? 1 : 0');
    expect(text).toContain('default     = false');
    expect(text).toContain('default     = "error"');
    expect(text).toContain('level: ${collector_log_level}');
    expect(text).toContain('default     = "me-west1"');
    expect(text).toContain('europe-west1');
    expect(text).toContain('me-west1');
    expect(hardStopCron('2026-10-14T00:00:00Z')).toBe('0 0 14 10 *');

    const service = text.slice(
      text.indexOf('resource "google_cloud_run_v2_service" "shop"'),
      text.indexOf('resource "google_cloud_scheduler_job" "hard_stop"'),
    );
    expect(service).toContain('google_cloud_scheduler_job.hard_stop');

    const scheduler = text.slice(text.indexOf('resource "google_cloud_scheduler_job" "hard_stop"'));
    const schedulerDepends = scheduler.slice(
      scheduler.indexOf('depends_on'),
      scheduler.indexOf('resource "google_pubsub_topic" "budget"'),
    );
    expect(schedulerDepends).not.toContain('google_cloud_run_v2_service.shop');
  });

  it('runs all four services with their own Cloud SQL database', () => {
    expect(text).toContain('apps = ["shop", "inventory", "payment", "delivery"]');
    expect(text).toContain('database_version    = "POSTGRES_16"');
    expect(text).toContain('edition                     = "ENTERPRISE"');
    expect(text).toContain('availability_type           = "ZONAL"');
    expect(text).toContain('enabled                        = false');
    expect(text).toContain('disk_size                   = 10');
    expect(text).toContain('default     = "db-f1-micro"');
    expect(text).toContain('host=/cloudsql/');
    expect(text).toContain('resource "random_password" "db"');
    expect(text).toContain('resource "google_secret_manager_secret_version" "db_password"');
    expect(text).toContain('"roles/cloudsql.client"');
    expect(text.match(/deletion_protection(_enabled)?\s*=\s*true/g)).toBeNull();
    // The only project-level roles this module grants.
    const roles = [...text.matchAll(/role\s*=\s*"(roles\/[^"]+)"/g)].map((m) => m[1]).sort();
    expect([...new Set(roles)]).toEqual([
      'roles/cloudsql.client',
      'roles/cloudtrace.agent',
      'roles/iam.serviceAccountTokenCreator',
      'roles/pubsub.publisher',
      'roles/run.developer',
      'roles/secretmanager.secretAccessor',
    ]);
  });

  it('stops every Cloud SQL instance and the load at the hard stop', () => {
    expect(text).toContain('resource "google_cloud_scheduler_job" "sql_hard_stop"');
    expect(text).toContain('activationPolicy = "NEVER"');
    expect(text).toContain('https://sqladmin.googleapis.com/v1/projects/');
    expect(text).toContain('default     = "* * 12-13 10 *"');
    expect(text).toContain('name  = "LOAD_STOP_AT"');
    expect(text).toContain('value = var.hard_stop_utc');
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
    expect(docs).toContain('project_id');
    expect(docs).toContain('shop_image');
    expect(docs).toContain('create_budget');
    expect(docs).toContain('collector_log_level');
    expect(docs).toContain('scalingMode');
    expect(docs).toContain('deletion_protection');
    expect(docs).toContain('roles/run.admin');
    expect(docs).toContain('roles/artifactregistry.admin');
    expect(docs).toContain('roles/cloudbuild.builds.editor');
    expect(docs).toContain('roles/storage.admin');
    expect(docs).toContain('roles/iam.serviceAccountAdmin');
    expect(docs).toContain('roles/resourcemanager.projectIamAdmin');
    expect(docs).toContain('roles/secretmanager.admin');
    expect(docs).toContain('roles/cloudscheduler.admin');
    expect(docs).toContain('roles/logging.viewer');
    expect(docs).toContain('roles/cloudtrace.user');
    expect(docs).toContain('roles/storage.objectViewer');
    expect(docs).toContain('roles/artifactregistry.writer');
    expect(docs).toContain('roles/logging.logWriter');
    expect(docs).toContain('constraints/iam.disableServiceAccountKeyCreation');
    expect(docs).toContain('constraints/iam.managed.disableServiceAccountKeyCreation');
  });
});
