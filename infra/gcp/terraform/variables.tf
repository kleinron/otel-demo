variable "project_id" {
  type        = string
  description = "Required. GCP project id for this spike. Not a project number. See terraform.tfvars.example."
}

variable "region" {
  type        = string
  default     = "me-west1"
  description = "Region for Cloud Run, Artifact Registry, Scheduler, and the fault-switch secret. Default is me-west1 (Tel Aviv). Set europe-west1 (Belgium) as the fallback."

  validation {
    condition     = contains(["me-west1", "europe-west1"], var.region)
    error_message = "region must be me-west1 (Tel Aviv) or europe-west1 (Belgium)."
  }
}

variable "scheduler_region" {
  type        = string
  default     = ""
  description = "Cloud Scheduler region. Empty uses var.region (me-west1 by default). Set europe-west1 only as a fallback if the job cannot be created in the chosen region."
}

variable "create_budget" {
  type        = bool
  default     = false
  description = "When true, create the billing budget and the Pub/Sub topic otel-demo-budget-alerts, and enable the Pub/Sub and billing-budget APIs. Default false so apply does not need those permissions."
}

variable "billing_account" {
  type        = string
  default     = ""
  description = "Billing account id (XXXXXX-XXXXXX-XXXXXX). Required only when create_budget is true. Leave empty otherwise. Do not commit a filled tfvars file."

  validation {
    condition     = var.billing_account == "" || can(regex("^[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$", var.billing_account))
    error_message = "billing_account must be empty, or look like XXXXXX-XXXXXX-XXXXXX."
  }
}

variable "budget_amount_usd" {
  type        = number
  default     = 25
  description = "Billing budget alert amount in whole US dollars."

  validation {
    condition     = var.budget_amount_usd > 0 && var.budget_amount_usd == floor(var.budget_amount_usd)
    error_message = "budget_amount_usd must be a positive whole number of US dollars."
  }
}

variable "hard_stop_utc" {
  type        = string
  default     = "2026-10-14T00:00:00Z"
  description = "UTC minute when Cloud Scheduler scales the Cloud Run service to zero. Seconds must be 00."

  validation {
    condition     = can(regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00Z$", var.hard_stop_utc))
    error_message = "hard_stop_utc must be an ISO-8601 UTC timestamp with zero seconds, such as 2026-10-14T00:00:00Z."
  }
}

variable "service_image" {
  type        = string
  description = "Required. Image built from infra/gcp/docker/service.Dockerfile (linux/amd64). It holds all four services, the seed, and the load tick. See terraform.tfvars.example."
}

variable "collector_log_level" {
  type        = string
  default     = "error"
  description = "Collector telemetry log level. Default error. Set info to raise it."

  validation {
    condition     = contains(["error", "info"], var.collector_log_level)
    error_message = "collector_log_level must be error or info."
  }
}

variable "collector_image" {
  type        = string
  default     = "otel/opentelemetry-collector-contrib:0.128.0"
  description = "Collector image. The googlecloud exporter is in the contrib image, not the core image."
}

variable "max_instances" {
  type        = number
  default     = 1
  description = "Cloud Run max instances. Min is always 1 until the hard stop. Default 1 caps the spike."

  validation {
    condition     = var.max_instances >= 1 && var.max_instances == floor(var.max_instances)
    error_message = "max_instances must be a whole number of at least 1."
  }
}

variable "shop_cpu" {
  type        = string
  default     = "1"
  description = "CPU limit of the shop (ingress) container."
}

variable "sidecar_cpu" {
  type        = string
  default     = "0.5"
  description = "CPU limit of each sidecar: inventory, payment, delivery, and the collector."
}

variable "sql_tier" {
  type        = string
  default     = "db-f1-micro"
  description = "Cloud SQL machine tier for each of the four Postgres 16 instances."
}

variable "sql_stop_service_account" {
  type        = string
  description = "Required. Existing service account that Cloud Scheduler acts as to set activationPolicy NEVER on each Cloud SQL instance at hard_stop_utc. It must already have cloudsql.instances.update. This module does not grant it."
}

variable "load_carts_per_minute" {
  type        = number
  default     = 12
  description = "Simulated cart journeys per minute (browse, add to cart, checkout). 0 creates no load jobs."

  validation {
    condition     = var.load_carts_per_minute >= 0 && var.load_carts_per_minute <= 60
    error_message = "load_carts_per_minute must be 0..60."
  }
}

variable "load_cron" {
  type        = string
  default     = "* * 12-13 10 *"
  description = "UTC cron for the load tick. The default only matches 2026-10-12 and 2026-10-13, so it ends at the hard stop."
}

variable "jobs_image" {
  description = "Image for the seed and loadgen jobs. Empty means service_image."
  type        = string
  default     = ""
}

variable "grafana_enabled" {
  type        = bool
  default     = false
  description = "Create the Grafana VM and its SA, IAM, secret, firewall and stop job."
}

variable "grafana_image" {
  type        = string
  default     = "grafana/grafana:11.6.0"
  description = "Grafana container image run on the VM."
}

variable "grafana_zone" {
  type    = string
  default = "me-west1-a"
}

variable "grafana_allowed_cidrs" {
  type        = list(string)
  default     = []
  description = "Source ranges allowed to reach Grafana on tcp:3000."
}
