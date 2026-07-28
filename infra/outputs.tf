# public_endpoint normalisé en URL https (le champ peut être nu ou préfixé).
# Avec un domaine custom, web_url EST ce domaine : le workflow s'en sert pour
# WEB_ORIGIN (trustedOrigins better-auth), le smoke test et le résumé.
locals {
  web_url = local.web_domain != "" ? "https://${local.web_domain}" : (startswith(scaleway_container.web.public_endpoint, "http") ? scaleway_container.web.public_endpoint : "https://${scaleway_container.web.public_endpoint}")
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

# Consommé par le workflow pour l'import idempotent de scaleway_rdb_user.app
# (format fr-par/<uuid>).
output "rdb_instance_id" {
  value = scaleway_rdb_instance.main.id
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

# DSN applicatif (app_user, RLS) — requis par le seed démo (withTenant).
output "app_database_url" {
  value     = local.app_database_url
  sensitive = true
}

output "db_app_password" {
  value     = random_password.db_app.result
  sensitive = true
}
