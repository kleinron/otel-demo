# Four Cloud SQL Postgres 16 instances, one per service. Smallest shape:
# ENTERPRISE, db-f1-micro, single zone, no backups, no HA, 10 GiB SSD.
# Passwords are generated here and stored in Secret Manager. They are never
# in the repo. Terraform state holds them, so keep state local and private.
resource "google_sql_database_instance" "app" {
  for_each = toset(local.apps)

  name                = "otel-demo-${each.key}"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = false

  settings {
    edition                     = "ENTERPRISE"
    tier                        = var.sql_tier
    availability_type           = "ZONAL"
    disk_type                   = "PD_SSD"
    disk_size                   = 10
    disk_autoresize             = false
    deletion_protection_enabled = false
    user_labels                 = local.labels

    backup_configuration {
      enabled                        = false
      point_in_time_recovery_enabled = false
    }

    # Public IP with no authorized networks. Only the Cloud SQL connector
    # (the Cloud Run /cloudsql socket) can reach it.
    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_sql_database" "app" {
  for_each = toset(local.apps)

  name     = each.key
  instance = google_sql_database_instance.app[each.key].name
}

resource "random_password" "db" {
  for_each = toset(local.apps)

  length  = 32
  special = false
}

resource "google_sql_user" "app" {
  for_each = toset(local.apps)

  name            = each.key
  instance        = google_sql_database_instance.app[each.key].name
  password        = random_password.db[each.key].result
  deletion_policy = "ABANDON"
}

resource "google_secret_manager_secret" "db_password" {
  for_each = toset(local.apps)

  secret_id = "otel-demo-${each.key}-db-password"
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

resource "google_secret_manager_secret_version" "db_password" {
  for_each = toset(local.apps)

  secret      = google_secret_manager_secret.db_password[each.key].id
  secret_data = random_password.db[each.key].result
}

locals {
  # Unix socket through the Cloud SQL connector volume mounted at /cloudsql.
  database_urls = {
    for app in local.apps : app => format(
      "postgres://%s:%s@localhost/%s?host=/cloudsql/%s",
      app,
      random_password.db[app].result,
      app,
      google_sql_database_instance.app[app].connection_name,
    )
  }
}

# Approved: the app runtime account connects through the Cloud SQL connector.
resource "google_project_iam_member" "cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.shop.email}"
}

# Hard stop for the databases: at hard_stop_utc, set activationPolicy NEVER on
# each instance through the Cloud SQL Admin API. Scheduler acts as an existing
# account that already has cloudsql.instances.update. No role is granted here.
resource "google_cloud_scheduler_job" "sql_hard_stop" {
  for_each = toset(local.apps)

  name        = "otel-demo-sql-hard-stop-${each.key}"
  description = "Stop Cloud SQL instance otel-demo-${each.key} (activationPolicy NEVER) at hard_stop_utc."
  schedule    = local.hard_stop_cron
  time_zone   = "Etc/UTC"
  region      = local.scheduler_region

  retry_config {
    retry_count          = 5
    min_backoff_duration = "30s"
    max_backoff_duration = "300s"
  }

  http_target {
    http_method = "PATCH"
    uri         = "https://sqladmin.googleapis.com/v1/projects/${var.project_id}/instances/otel-demo-${each.key}"
    body = base64encode(jsonencode({
      settings = {
        activationPolicy = "NEVER"
      }
    }))
    headers = {
      "Content-Type" = "application/json"
    }
    oauth_token {
      service_account_email = var.sql_stop_service_account
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [google_project_service.required]
}
