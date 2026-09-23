variable "environment" {
  description = "Deployment environment — used in resource tags and SSM paths"
  default     = "prod"
}

variable "aws_region" {
  description = "AWS region for all resources (except ACM, which is always us-east-1)"
  default     = "us-west-2"
}

variable "app_name" {
  description = "Short kebab-case name used as a prefix for all AWS resources"
  type        = string
  # Example: "reef-dashboard", "ops-console", "acme-portal"
  # S3 bucket is derived as {app_name}-assets
}

variable "custom_domain" {
  description = "Custom domain to serve the SPA from (must be in your Cloudflare zone)"
  type        = string
  # Example: "dashboard.yourdomain.com"
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for the domain"
  type        = string
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token with Zone:DNS:Edit on the zone"
  type        = string
  sensitive   = true
}

variable "price_class" {
  description = "CloudFront price class — PriceClass_100 (US+EU), PriceClass_200 (+Asia), PriceClass_All"
  default     = "PriceClass_100"
}

variable "ssm_secret_path" {
  description = "SSM Parameter Store path for runtime secrets passed to Lambda (unused: this is a static-only deployment)"
  type        = string
  default     = ""
  # Derived by bootstrap.sh as /{app_name}/{environment}/secrets
}

variable "lambda_runtime" {
  description = "Lambda runtime identifier"
  default     = "python3.12"
}

variable "lambda_handler" {
  description = "Lambda handler in the form filename.function_name"
  default     = "handler.handler"
}

variable "lambda_timeout" {
  description = "Lambda timeout in seconds"
  default     = 30
}

variable "lambda_memory_mb" {
  description = "Lambda memory allocation in MB"
  default     = 256
}

variable "log_retention_days" {
  description = "CloudWatch log group retention in days"
  default     = 7
}
