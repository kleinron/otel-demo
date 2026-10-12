# Grafana on one Compute Engine VM (DRAFT, waits on Ron's approval: adds a SA,
# IAM and a firewall rule). Created only when grafana_enabled = true.
# COS + Docker, e2-small, 10 GB pd-standard data disk for /var/lib/grafana.
# Dashboards and data sources are provisioned from infra/gcp/grafana. All data
# sources authenticate as the attached SA through the metadata server; no key.

locals {
  grafana_name = "otel-demo-grafana"
  grafana_dir  = "${path.module}/../grafana"
  grafana_roles = toset([
    "roles/monitoring.viewer", # Cloud Monitoring data source
    "roles/cloudtrace.user",   # Cloud Trace data source
    "roles/logging.viewer",    # Cloud Logging data source (ported log panels)
  ])
}

resource "google_project_service" "compute" {
  count              = var.grafana_enabled ? 1 : 0
  project            = var.project_id
  service            = "compute.googleapis.com"
  disable_on_destroy = false
}

resource "google_service_account" "grafana" {
  count        = var.grafana_enabled ? 1 : 0
  account_id   = "otel-demo-grafana"
  display_name = "otel-demo Grafana VM (read-only telemetry)"
}

resource "google_project_iam_member" "grafana" {
  for_each = var.grafana_enabled ? local.grafana_roles : toset([])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.grafana[0].email}"
}

resource "random_password" "grafana_admin" {
  count   = var.grafana_enabled ? 1 : 0
  length  = 32
  special = false
}

resource "google_secret_manager_secret" "grafana_admin" {
  count     = var.grafana_enabled ? 1 : 0
  secret_id = "otel-demo-grafana-admin-password"
  labels    = local.labels

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "grafana_admin" {
  count       = var.grafana_enabled ? 1 : 0
  secret      = google_secret_manager_secret.grafana_admin[0].id
  secret_data = random_password.grafana_admin[0].result
}

resource "google_secret_manager_secret_iam_member" "grafana_admin_accessor" {
  count     = var.grafana_enabled ? 1 : 0
  secret_id = google_secret_manager_secret.grafana_admin[0].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.grafana[0].email}"
}

resource "google_compute_disk" "grafana_data" {
  count  = var.grafana_enabled ? 1 : 0
  name   = "${local.grafana_name}-data"
  zone   = var.grafana_zone
  type   = "pd-standard"
  size   = 10
  labels = local.labels

  depends_on = [google_project_service.compute]
}

resource "google_compute_instance" "grafana" {
  count        = var.grafana_enabled ? 1 : 0
  name         = local.grafana_name
  zone         = var.grafana_zone
  machine_type = "e2-small"
  labels       = local.labels
  tags         = [local.grafana_name]

  boot_disk {
    initialize_params {
      image = "cos-cloud/cos-stable"
      size  = 10
    }
  }

  attached_disk {
    source      = google_compute_disk.grafana_data[0].id
    device_name = "grafana-data"
  }

  network_interface {
    network = "default"
    access_config {} # ephemeral public IP; the firewall below limits who reaches :3000
  }

  service_account {
    email  = google_service_account.grafana[0].email
    scopes = ["cloud-platform"] # IAM roles above are the real limit
  }

  shielded_instance_config {
    enable_secure_boot = true
  }

  metadata = {
    block-project-ssh-keys = "true"
    user-data = templatefile("${local.grafana_dir}/cloud-init.yaml.tftpl", {
      project_id              = var.project_id
      secret_id               = google_secret_manager_secret.grafana_admin[0].secret_id
      grafana_image           = var.grafana_image
      datasources_b64         = base64encode(templatefile("${local.grafana_dir}/provisioning/datasources/datasources.yml.tftpl", { project_id = var.project_id }))
      dashboards_provider_b64 = filebase64("${local.grafana_dir}/provisioning/dashboards/dashboards.yml")
      dashboard_b64           = filebase64("${local.grafana_dir}/provisioning/dashboard-json/otel-demo.json")
    })
  }

  # A stop job exists before the VM runs, same as the shop.
  depends_on = [
    google_cloud_scheduler_job.grafana_hard_stop,
    google_secret_manager_secret_version.grafana_admin,
    google_secret_manager_secret_iam_member.grafana_admin_accessor,
  ]
}

# Only Grafana's port, only from the listed ranges. No SSH rule.
resource "google_compute_firewall" "grafana" {
  count         = var.grafana_enabled ? 1 : 0
  name          = "${local.grafana_name}-3000"
  network       = "default"
  direction     = "INGRESS"
  source_ranges = var.grafana_allowed_cidrs
  target_tags   = [local.grafana_name]

  allow {
    protocol = "tcp"
    ports    = ["3000"]
  }

  lifecycle {
    precondition {
      condition     = length(var.grafana_allowed_cidrs) > 0
      error_message = "Set grafana_allowed_cidrs (e.g. Ron's IP/32) when grafana_enabled is true."
    }
  }

  depends_on = [google_project_service.compute]
}

# Same hard stop as the shop (hard_stop_utc, 2026-10-14T00:00:00Z): stop the VM.
resource "google_cloud_scheduler_job" "grafana_hard_stop" {
  count       = var.grafana_enabled ? 1 : 0
  name        = "otel-demo-grafana-hard-stop"
  description = "Stop the otel-demo-grafana VM at hard_stop_utc."
  schedule    = local.hard_stop_cron
  time_zone   = "Etc/UTC"
  region      = local.scheduler_region

  retry_config {
    retry_count = 3
  }

  http_target {
    http_method = "POST"
    uri         = "https://compute.googleapis.com/compute/v1/projects/${var.project_id}/zones/${var.grafana_zone}/instances/${local.grafana_name}/stop"
    oauth_token {
      service_account_email = var.sql_stop_service_account
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [google_project_service.required]
}
