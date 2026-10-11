variable "project_id" {
  type        = string
  description = "GCP project id for this spike. Not a project number."
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

variable "billing_account" {
  type        = string
  description = "Billing account id (XXXXXX-XXXXXX-XXXXXX). Do not commit a filled tfvars file."

  validation {
    condition     = can(regex("^[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$", var.billing_account))
    error_message = "billing_account must look like XXXXXX-XXXXXX-XXXXXX."
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

variable "shop_image" {
  type        = string
  description = "Shop container image in Artifact Registry. Build and push it before apply. Cloud Run must be able to run its architecture."
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

variable "database_secret" {
  type        = string
  default     = ""
  description = "Secret Manager secret id that holds DATABASE_URL. Empty omits it. The value is never stored in this repo."
}

variable "inventory_url" {
  type    = string
  default = "http://localhost:3002"
}

variable "payment_url" {
  type    = string
  default = "http://localhost:3003"
}

variable "delivery_url" {
  type    = string
  default = "http://localhost:3004"
}
