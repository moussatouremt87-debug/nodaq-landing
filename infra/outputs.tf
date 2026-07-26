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

# Consommé par le smoke test du workflow (liste des statuts de conteneurs
# en cas d'échec). Format provider : "fr-par/<uuid>".
output "container_namespace_id" {
  value = scaleway_container_namespace.main.id
}

output "db_host" {
  value = local.db_host
}

output "db_port" {
  value = local.db_port
}

# Sensibles : consommés par le workflow (migrations + ALTER ROLE + masquage
# des logs du smoke test), masqués via ::add-mask:: — jamais affichés. Le
# smoke test réémet l'error_message des conteneurs (texte libre Scaleway) :
# tout secret généré susceptible d'y apparaître doit être masquable.
output "auth_secret" {
  value     = random_password.auth_secret.result
  sensitive = true
}

output "litellm_master_key" {
  value     = random_password.litellm_master_key.result
  sensitive = true
}

output "database_url" {
  value     = local.database_url
  sensitive = true
}

output "db_app_password" {
  value     = random_password.db_app.result
  sensitive = true
}
