output "shop_service" {
  value       = google_cloud_run_v2_service.shop.name
  description = "Cloud Run service name."
}

output "shop_uri" {
  value       = google_cloud_run_v2_service.shop.uri
  description = "HTTPS URL of the shop service."
}

output "artifact_registry" {
  value       = google_artifact_registry_repository.demo.id
  description = "Docker repository for the spike image."
}

output "hard_stop_cron" {
  value       = local.hard_stop_cron
  description = "Cloud Scheduler cron derived from hard_stop_utc."
}

output "fault_switch_secret" {
  value       = google_secret_manager_secret.faults.secret_id
  description = "Secret Manager secret that holds the fault kill switch. Created as off."
}

output "budget_display_name" {
  value       = var.create_budget ? google_billing_budget.spike[0].display_name : ""
  description = "Billing budget display name when create_budget is true. Empty otherwise."
}

output "sql_instances" {
  value       = { for app in local.apps : app => google_sql_database_instance.app[app].connection_name }
  description = "Cloud SQL connection names, one per service."
}

output "seed_command" {
  value       = "gcloud run jobs execute ${google_cloud_run_v2_job.seed.name} --region ${var.region} --wait"
  description = "Seed all four databases once."
}
