# Seed: run once after apply with
#   gcloud run jobs execute otel-demo-seed --region REGION --wait
# It runs scripts/seed.ts against all four databases. Scheduler never runs it.
resource "google_cloud_run_v2_job" "seed" {
  name                = "otel-demo-seed"
  location            = var.region
  deletion_protection = false
  labels              = local.labels

  template {
    task_count = 1
    template {
      service_account = google_service_account.shop.email
      max_retries     = 0
      timeout         = "600s"

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          # Same order as live (shop, delivery, inventory, payment) so plan stays clean.
          instances = [for app in ["shop", "delivery", "inventory", "payment"] : google_sql_database_instance.app[app].connection_name]
        }
      }

      containers {
        image   = local.jobs_image
        command = ["npx", "tsx", "scripts/seed.ts"]

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }

        dynamic "env" {
          for_each = local.apps
          content {
            name  = "${upper(env.value)}_DATABASE_URL"
            value = local.database_urls[env.value]
          }
        }
      }
    }
  }

  depends_on = [
    google_project_iam_member.cloudsql_client,
    google_sql_user.app,
    google_sql_database.app,
  ]
}

# Load: every minute Scheduler runs this job once. One run starts
# load_carts_per_minute simulated cart journeys spaced over the minute, each with
# a fresh UUID v4 cart.id in W3C baggage. Three stop layers: load_cron only
# matches the deploy days, the job does nothing after hard_stop_utc, and the
# hard stop scales the shop to zero.
resource "google_cloud_run_v2_job" "loadgen" {
  count               = var.load_carts_per_minute > 0 ? 1 : 0
  name                = "otel-demo-loadgen"
  location            = var.region
  deletion_protection = false
  labels              = local.labels

  template {
    task_count = 1
    template {
      # Existing account. Its roles/run.developer already covers invoking the shop.
      service_account = google_service_account.hard_stop.email
      max_retries     = 0
      timeout         = "90s"

      containers {
        image   = local.jobs_image
        command = ["node", "loadgen/dist/cart-tick-main.js"]

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        env {
          name  = "SHOP_URL"
          value = google_cloud_run_v2_service.shop.uri
        }
        env {
          name  = "SHOP_AUDIENCE"
          value = google_cloud_run_v2_service.shop.uri
        }
        env {
          name  = "LOAD_CARTS"
          value = tostring(var.load_carts_per_minute)
        }
        env {
          name  = "LOAD_SPACING_MS"
          value = tostring(floor(55000 / var.load_carts_per_minute))
        }
        env {
          name  = "LOAD_STOP_AT"
          value = var.hard_stop_utc
        }
      }
    }
  }
}

resource "google_cloud_scheduler_job" "loadgen" {
  count            = var.load_carts_per_minute > 0 ? 1 : 0
  name             = "otel-demo-loadgen-real"
  description      = "Run otel-demo-loadgen once a minute until hard_stop_utc."
  schedule         = var.load_cron
  time_zone        = "Etc/UTC"
  region           = local.scheduler_region
  attempt_deadline = "30s"

  # No retry_config block: live has none, and the default (0 retries) is the same.

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.loadgen[0].name}:run"
    headers = {
      "Content-Type" = "application/json"
    }
    body = base64encode("{}")
    oauth_token {
      service_account_email = google_service_account.hard_stop.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }
}
