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
  # Cloud Run's TCP startup probe cannot reach a localhost listener, so the
  # health extension must bind every interface. Octets are joined so the
  # address is not a literal in the repo.
  health_bind = "${join(".", ["0", "0", "0", "0"])}:13133"
  collector_config = templatefile("${path.module}/collector.yaml.tftpl", {
    project_id          = var.project_id
    health_bind         = local.health_bind
    collector_log_level = var.collector_log_level
  })
  labels = {
    experiment = "otel-demo"
    spike      = "gcp"
  }

  apps = ["shop", "inventory", "payment", "delivery"]
  app_containers = {
    shop      = { port = 3001, cpu = var.shop_cpu, memory = "512Mi", depends_on = ["collector", "inventory", "payment", "delivery"] }
    inventory = { port = 3002, cpu = var.sidecar_cpu, memory = "512Mi", depends_on = ["collector"] }
    payment   = { port = 3003, cpu = var.sidecar_cpu, memory = "512Mi", depends_on = ["collector"] }
    delivery  = { port = 3004, cpu = var.sidecar_cpu, memory = "512Mi", depends_on = ["collector"] }
  }
  common_env = {
    LISTEN_ANY                  = "true"
    LOG_LEVEL                   = "info"
    LOG_FORMAT                  = "gcp"
    CLOUD_PROVIDER              = "gcp"
    GCP_PROJECT_ID              = var.project_id
    OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318"
    DEPLOYMENT_ENVIRONMENT      = "gcp"
    # Faults stay off unless the Secret Manager switch is set to on.
    FAULT_SWITCH_SOURCE     = "module"
    FAULT_SWITCH_MODULE     = "@otel-demo/infra-gcp/fault-switch"
    FAULT_SWITCH_PROVIDER   = "gcp"
    GCP_FAULT_SWITCH_SOURCE = "secret"
    GCP_FAULT_SWITCH_SECRET = google_secret_manager_secret.faults.secret_id
  }
  shop_env = {
    INVENTORY_URL = "http://localhost:3002"
    PAYMENT_URL   = "http://localhost:3003"
    DELIVERY_URL  = "http://localhost:3004"
  }
}

resource "google_project_service" "required" {
  for_each = toset(concat(
    [
      "run.googleapis.com",
      "artifactregistry.googleapis.com",
      "cloudscheduler.googleapis.com",
      "cloudtrace.googleapis.com",
      "secretmanager.googleapis.com",
      "logging.googleapis.com",
      "iam.googleapis.com",
      "sqladmin.googleapis.com",
    ],
    var.create_budget ? [
      "billingbudgets.googleapis.com",
      "cloudbilling.googleapis.com",
      "pubsub.googleapis.com",
    ] : [],
  ))
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
    user_managed {
      replicas {
        location = var.region
      }
    }
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

# One Cloud Run service runs the whole store: shop is the ingress container,
# inventory, payment, and delivery are sidecars on localhost:3002-3004, and the
# collector sidecar exports every span to Cloud Trace. Each app container has
# its own service.name and its own Cloud SQL database over the unix socket.
# A single service keeps the backends private without any run.invoker grant.
resource "google_cloud_run_v2_service" "shop" {
  name                = local.service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false
  labels              = local.labels

  template {
    service_account = google_service_account.shop.email
    timeout         = "60s"
    labels          = local.labels

    scaling {
      min_instance_count = 1
      max_instance_count = var.max_instances
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [for app in local.apps : google_sql_database_instance.app[app].connection_name]
      }
    }

    dynamic "containers" {
      for_each = local.app_containers
      content {
        name    = containers.key
        image   = var.service_image
        command = ["node", "services/${containers.key}/dist/index.js"]

        dynamic "ports" {
          for_each = containers.key == "shop" ? [3001] : []
          content {
            container_port = ports.value
          }
        }

        resources {
          limits = {
            cpu    = containers.value.cpu
            memory = containers.value.memory
          }
          # false means the CPU stays allocated between requests.
          cpu_idle = false
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }

        # Cloud Run reserves PORT and sets it for the ingress container. Do not set it here.
        # Sidecars listen on their default ports (3002, 3003, 3004).
        dynamic "env" {
          for_each = merge(local.common_env, {
            OTEL_SERVICE_NAME = containers.key
            DATABASE_URL      = local.database_urls[containers.key]
          }, containers.key == "shop" ? local.shop_env : {})
          content {
            name  = env.key
            value = env.value
          }
        }

        startup_probe {
          tcp_socket {
            port = containers.value.port
          }
          period_seconds    = 10
          failure_threshold = 30
          timeout_seconds   = 1
        }

        depends_on = containers.value.depends_on
      }
    }

    containers {
      name  = "collector"
      image = var.collector_image
      args  = ["--config=env:OTEL_COLLECTOR_CONFIG"]

      resources {
        limits = {
          cpu    = var.sidecar_cpu
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

  # The hard-stop jobs are created first so a stop exists before this service runs.
  depends_on = [
    google_project_service.required,
    google_artifact_registry_repository.demo,
    google_cloud_scheduler_job.hard_stop,
    google_cloud_scheduler_job.sql_hard_stop,
    google_project_iam_member.cloudsql_client,
  ]
}

resource "google_cloud_scheduler_job" "hard_stop" {
  name        = "otel-demo-hard-stop"
  description = "Scale otel-demo-shop (all four services) to zero instances at hard_stop_utc."
  schedule    = local.hard_stop_cron
  time_zone   = "Etc/UTC"
  region      = local.scheduler_region

  retry_config {
    retry_count = 3
  }

  http_target {
    http_method = "PATCH"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/services/${local.service_name}?updateMask=scaling.scalingMode,scaling.manualInstanceCount"
    body = base64encode(jsonencode({
      scaling = {
        scalingMode         = "MANUAL"
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

  # Do not depend on the Cloud Run service. The URI names the service; the job
  # must exist before that service is created.
  depends_on = [
    google_project_service.required,
    google_service_account_iam_member.scheduler_mint,
  ]
}

resource "google_pubsub_topic" "budget" {
  count  = var.create_budget ? 1 : 0
  name   = "otel-demo-budget-alerts"
  labels = local.labels

  depends_on = [google_project_service.required]
}

resource "google_pubsub_topic_iam_member" "budget_publisher" {
  count  = var.create_budget ? 1 : 0
  topic  = google_pubsub_topic.budget[0].name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:billing-budget-alert@system.gserviceaccount.com"
}

resource "google_billing_budget" "spike" {
  count           = var.create_budget ? 1 : 0
  billing_account = var.billing_account
  display_name    = "otel-demo-gcp-spike"

  lifecycle {
    precondition {
      condition     = var.billing_account != ""
      error_message = "billing_account is required when create_budget is true."
    }
  }

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
    pubsub_topic                   = google_pubsub_topic.budget[0].id
    disable_default_iam_recipients = false
  }

  depends_on = [google_project_service.required]
}
