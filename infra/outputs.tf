output "web_url" {
  value = "https://${scaleway_container.web.domain_name}"
}

output "api_url" {
  value = "https://${scaleway_container.api.domain_name}"
}

output "litellm_url" {
  value = "https://${scaleway_container.litellm.domain_name}"
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
