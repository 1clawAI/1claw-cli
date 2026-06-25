variable "project_id" {
  type        = string
  description = "Google Cloud project ID"
}

variable "region" {
  type        = string
  description = "Cloud Run region"
  default     = "us-central1"
}

variable "service_name" {
  type        = string
  description = "Cloud Run service name"
}

variable "image_tag" {
  type        = string
  description = "Container image (must be in a registry, e.g. docker.io/<user>/<name>:<tag>)"
}

variable "agent_id" {
  type        = string
  description = "1Claw agent ID (metadata only)"
  default     = ""
}

variable "modules" {
  type        = string
  description = "Comma-separated module names baked into the image"
  default     = ""
}

variable "agent_api_key" {
  type        = string
  description = "1Claw agent API key (ocv_...) stored in Secret Manager"
  sensitive   = true
}

variable "invoker_member" {
  type        = string
  description = "IAM member allowed to invoke the service"
  default     = "allUsers"
}
