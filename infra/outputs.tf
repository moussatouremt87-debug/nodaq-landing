# public_endpoint normalisé en URL https (le champ peut être nu ou préfixé).
locals {
  web_url = startswith(scaleway_container.web.public_endpoint, "http") ? scaleway_container.web.public_endpoint : "https://${scaleway_container.web.public_endpoint}"
  api_url = startswith(scaleway_container.api.public_endpoint, "http") ? scaleway_container.api.public_endpoint : "https://${scaleway_container.api.public_endpoint}"
}

output "web_url" {
  value = local.web_url
}

output "api_url" {
  value = local.api_url
}

output "litellm_url" {
  value = local.litellm_url
}

output "db_host" {
  value = local.db_host
}

output "db_port" {
  value = local.db_port
}

# Sensibles : consommés par le workflow (migrations + ALTER ROLE), masqués dans
# les logs via ::add-mask:: — jamais affichés.
output "database_url" {
  value     = local.database_url
  sensitive = true
}

output "db_app_password" {
  value     = random_password.db_app.result
  sensitive = true
}
