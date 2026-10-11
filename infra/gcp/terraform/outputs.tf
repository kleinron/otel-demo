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
  value       = google_billing_budget.spike.display_name
  description = "Billing budget display name. The budget is attached to the billing account."
}
