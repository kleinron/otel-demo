data "google_project" "this" {
  project_id = var.project_id
}

locals {
  service_name     = "otel-demo-shop"
  scheduler_region = var.scheduler_region != "" ? var.scheduler_region : var.region
  # minute hour day-of-month month day-of-week, UTC.
  # 2026-10-14T00:00:00Z becomes "0 0 14 10 *". See hardStopCron in src/hard-stop.ts.
  hard_stop_parts = regex(
    "^(?P<year>[0-9]{4})-(?P<month>[0-9]{2})-(?P<day>[0-9]{2})T(?P<hour>[0-9]{2}):(?P<minute>[0-9]{2}):(?P<second>[0-9]{2})Z$",
    var.hard_stop_utc,
  )
  hard_stop_cron = format(
    "%d %d %d %d *",
    tonumber(local.hard_stop_parts.minute),
    tonumber(local.hard_stop_parts.hour),
    tonumber(local.hard_stop_parts.day),
    tonumber(local.hard_stop_parts.month),
  )
  collector_config = templatefile("${path.module}/collector.yaml.tftpl", {
    project_id = var.project_id
  })
  labels = {
    experiment = "otel-demo"
    spike      = "gcp"
  }
}

resource "google_project_service" "required" {
  for_each = toset([
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudscheduler.googleapis.com",
    "billingbudgets.googleapis.com",
    "cloudbilling.googleapis.com",
    "cloudtrace.googleapis.com",
    "secretmanager.googleapis.com",
    "logging.googleapis.com",
    "iam.googleapis.com",
    "pubsub.googleapis.com",
  ])
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "demo" {
  location      = var.region
  repository_id = "otel-demo"
  description   = "otel-demo GCP spike images"
  format        = "DOCKER"
  labels        = local.labels

  depends_on = [google_project_service.required]
}

resource "google_service_account" "shop" {
  account_id   = "otel-demo-shop"
  display_name = "otel-demo shop spike"
}

resource "google_service_account" "hard_stop" {
  account_id   = "otel-demo-hard-stop"
  display_name = "otel-demo spike hard stop"
}

resource "google_project_iam_member" "trace_agent" {
  project = var.project_id
  role    = "roles/cloudtrace.agent"
  member  = "serviceAccount:${google_service_account.shop.email}"
}

resource "google_project_iam_member" "hard_stop_run_admin" {
  project = var.project_id
  role    = "roles/run.developer"
  member  = "serviceAccount:${google_service_account.hard_stop.email}"
}

resource "google_service_account_iam_member" "scheduler_mint" {
  service_account_id = google_service_account.hard_stop.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-cloudscheduler.iam.gserviceaccount.com"

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret" "faults" {
  secret_id = "otel-demo-faults-enabled"
  labels    = local.labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "faults" {
  secret      = google_secret_manager_secret.faults.id
  secret_data = "off"
}

resource "google_secret_manager_secret_iam_member" "faults_accessor" {
  secret_id = google_secret_manager_secret.faults.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.shop.email}"
}

resource "google_secret_manager_secret_iam_member" "database" {
  count     = var.database_secret == "" ? 0 : 1
  secret_id = var.database_secret
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.shop.email}"
}

resource "google_cloud_run_v2_service" "shop" {
  name     = local.service_name
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"
  labels   = local.labels

  template {
    service_account = google_service_account.shop.email
    timeout         = "60s"
    labels          = local.labels

    scaling {
      min_instance_count = 1
      max_instance_count = var.max_instances
    }

    containers {
      name    = "shop"
      image   = var.shop_image
      command = ["node", "services/shop/dist/index.js"]

      ports {
        container_port = 3001
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        # false means the CPU stays allocated between requests.
        cpu_idle = false
      }

      env {
        name  = "LISTEN_ANY"
        value = "true"
      }
      env {
        name  = "PORT"
        value = "3001"
      }
      env {
        name  = "LOG_LEVEL"
        value = "info"
      }
      env {
        name  = "LOG_FORMAT"
        value = "gcp"
      }
      env {
        name  = "CLOUD_PROVIDER"
        value = "gcp"
      }
      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "OTEL_SERVICE_NAME"
        value = "shop"
      }
      env {
        name  = "OTEL_EXPORTER_OTLP_ENDPOINT"
        value = "http://localhost:4318"
      }
      env {
        name  = "DEPLOYMENT_ENVIRONMENT"
        value = "gcp-spike"
      }
      env {
        name  = "FAULT_SWITCH_SOURCE"
        value = "env"
      }
      env {
        name  = "OTEL_DEMO_FAULTS_ENABLED"
        value = "off"
      }
      env {
        name  = "FAULT_SWITCH_PROVIDER"
        value = "gcp"
      }
      env {
        name  = "GCP_FAULT_SWITCH_SOURCE"
        value = "secret"
      }
      env {
        name  = "GCP_FAULT_SWITCH_SECRET"
        value = google_secret_manager_secret.faults.secret_id
      }
      env {
        name  = "INVENTORY_URL"
        value = var.inventory_url
      }
      env {
        name  = "PAYMENT_URL"
        value = var.payment_url
      }
      env {
        name  = "DELIVERY_URL"
        value = var.delivery_url
      }

      dynamic "env" {
        for_each = var.database_secret == "" ? [] : [var.database_secret]
        content {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        tcp_socket {
          port = 3001
        }
        period_seconds    = 10
        failure_threshold = 30
        timeout_seconds   = 1
      }

      depends_on = ["collector"]
    }

    containers {
      name  = "collector"
      image = var.collector_image
      args  = ["--config=env:OTEL_COLLECTOR_CONFIG"]

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = false
      }

      env {
        name  = "OTEL_COLLECTOR_CONFIG"
        value = local.collector_config
      }

      startup_probe {
        tcp_socket {
          port = 13133
        }
        period_seconds    = 5
        failure_threshold = 12
        timeout_seconds   = 1
      }
    }
  }

  depends_on = [
    google_project_service.required,
    google_artifact_registry_repository.demo,
  ]
}

resource "google_cloud_scheduler_job" "hard_stop" {
  name        = "otel-demo-hard-stop"
  description = "Scale otel-demo-shop to zero instances at hard_stop_utc."
  schedule    = local.hard_stop_cron
  time_zone   = "Etc/UTC"
  region      = local.scheduler_region

  retry_config {
    retry_count = 3
  }

  http_target {
    http_method = "PATCH"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/services/${local.service_name}?updateMask=scaling.manualInstanceCount"
    body = base64encode(jsonencode({
      scaling = {
        manualInstanceCount = 0
      }
    }))
    headers = {
      "Content-Type" = "application/json"
    }
    oauth_token {
      service_account_email = google_service_account.hard_stop.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [
    google_project_service.required,
    google_cloud_run_v2_service.shop,
    google_service_account_iam_member.scheduler_mint,
  ]
}

resource "google_pubsub_topic" "budget" {
  name   = "otel-demo-budget-alerts"
  labels = local.labels

  depends_on = [google_project_service.required]
}

resource "google_pubsub_topic_iam_member" "budget_publisher" {
  topic  = google_pubsub_topic.budget.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:billing-budget-alert@system.gserviceaccount.com"
}

resource "google_billing_budget" "spike" {
  billing_account = var.billing_account
  display_name    = "otel-demo-gcp-spike"

  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_amount_usd)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.9
  }
  threshold_rules {
    threshold_percent = 1.0
  }

  all_updates_rule {
    pubsub_topic                   = google_pubsub_topic.budget.id
    disable_default_iam_recipients = false
  }

  depends_on = [google_project_service.required]
}
