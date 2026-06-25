output "service_url" {
  description = "Public URL of the deployed Cloud Run service"
  value       = google_cloud_run_v2_service.agent.uri
}

output "service_name" {
  description = "Cloud Run service name"
  value       = google_cloud_run_v2_service.agent.name
}
