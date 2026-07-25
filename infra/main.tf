# NODAQ — staging Scaleway (ticket 0.4). Région FR-PAR exclusivement
# (souveraineté). Tous les mots de passe/clés sont générés ICI (random_password,
# persistés dans le state chiffré côté bucket) — jamais commités, jamais loggés.

locals {
  registry = "rg.fr-par.scw.cloud/${scaleway_registry_namespace.main.name}"
  # Secrets applicatifs lus au boot par injectSecrets() (prefix + NOM).
  secret_prefix = "nodaq-staging-"
}

# ── Secrets générés (state-persisted, stables entre applies) ──────────────────

# Contraintes RDB Scaleway : au moins un chiffre, une majuscule, une minuscule
# et un caractère spécial. override_special évite les caractères qui piègent
# les DSN/shell ; les mots de passe sont urlencodés dans les URLs de connexion.
resource "random_password" "db_admin" {
  length           = 32
  special          = true
  override_special = "!#*()-_=+"
  min_special      = 1
  min_upper        = 1
  min_lower        = 1
  min_numeric      = 1
}

resource "random_password" "db_app" {
  length           = 32
  special          = true
  override_special = "!#*()-_=+"
  min_special      = 1
  min_upper        = 1
  min_lower        = 1
  min_numeric      = 1
}

resource "random_password" "auth_secret" {
  length  = 48
  special = false
}

resource "random_password" "litellm_master_key" {
  length  = 40
  special = false
}

# ── Registre d'images ─────────────────────────────────────────────────────────

resource "scaleway_registry_namespace" "main" {
  name       = "nodaq-staging"
  project_id = var.project_id
  is_public  = false
}

# ── PostgreSQL managé (RLS : l'app tourne avec app_user, jamais admin) ────────

resource "scaleway_rdb_instance" "main" {
  name           = "nodaq-staging-pg"
  project_id     = var.project_id
  node_type      = "db-dev-s"
  engine         = "PostgreSQL-15"
  is_ha_cluster  = false
  disable_backup = true # staging
  user_name      = "nodaq_admin"
  password       = random_password.db_admin.result
}

resource "scaleway_rdb_database" "appdb" {
  instance_id = scaleway_rdb_instance.main.id
  name        = "appdb"
}

# Scaleway RDB n'accorde AUCUN privilège sur une base créée via l'API — même
# pas CONNECT pour l'utilisateur initial (« permission denied for database »,
# run #5 des migrations). On attribue tout à nodaq_admin explicitement.
# app_user (créé par NOS migrations SQL, invisible de l'API Scaleway) reçoit
# son GRANT CONNECT via psql dans le workflow, juste après les migrations.
resource "scaleway_rdb_privilege" "admin_appdb" {
  instance_id   = scaleway_rdb_instance.main.id
  user_name     = scaleway_rdb_instance.main.user_name
  database_name = scaleway_rdb_database.appdb.name
  permission    = "all"
}

# ACL EXPLICITE (audit 0.4) : staging ouvert (runner GitHub + conteneurs
# serverless n'ont pas d'IP fixe), défense = mots de passe forts générés.
# Durcissement prod (suivi) : Private Network / VPC + ACL restreinte.
resource "scaleway_rdb_acl" "main" {
  instance_id = scaleway_rdb_instance.main.id
  acl_rules {
    ip          = "0.0.0.0/0"
    description = "staging: GitHub runner + serverless containers (pas d'IP fixe)"
  }
}

# Le provider expose load_balancer comme LISTE VIDE (connue) tant que
# l'instance n'existe pas — un [0] direct casse au plan. D'où : locals
# null-tolérants + un apply préalable ciblé sur l'instance dans le workflow,
# pour que les DSN soient toujours calculés sur un load balancer réel avant
# que les secrets/conteneurs ne soient planifiés.
locals {
  db_host = try(scaleway_rdb_instance.main.load_balancer[0].ip, null)
  db_port = try(scaleway_rdb_instance.main.load_balancer[0].port, null)
  # Mots de passe URL-encodés : un caractère spécial ne doit jamais casser la
  # connection string (Prisma, psql).
  database_url     = local.db_host == null ? null : "postgresql://nodaq_admin:${urlencode(random_password.db_admin.result)}@${local.db_host}:${local.db_port}/appdb"
  app_database_url = local.db_host == null ? null : "postgresql://app_user:${urlencode(random_password.db_app.result)}@${local.db_host}:${local.db_port}/appdb"
}

# ── Secret Manager : les secrets lus au boot de l'API ─────────────────────────

# Least privilege : le runtime ne reçoit JAMAIS le DSN admin (DATABASE_URL
# reste dans le state, consommé par le seul job de migrations du workflow).
resource "scaleway_secret" "boot" {
  for_each   = toset(["AUTH_SECRET", "APP_DATABASE_URL"])
  name       = "${local.secret_prefix}${each.key}"
  project_id = var.project_id
}

resource "scaleway_secret_version" "auth_secret" {
  secret_id = scaleway_secret.boot["AUTH_SECRET"].id
  data      = random_password.auth_secret.result
}

resource "scaleway_secret_version" "app_database_url" {
  secret_id = scaleway_secret.boot["APP_DATABASE_URL"].id
  data      = local.app_database_url
}

# ── Conteneurs serverless ─────────────────────────────────────────────────────

resource "scaleway_container_namespace" "main" {
  name       = "nodaq-staging"
  project_id = var.project_id
}

resource "scaleway_container" "litellm" {
  name               = "litellm"
  namespace_id       = scaleway_container_namespace.main.id
  image              = "${local.registry}/litellm:${var.image_tag}"
  port               = 4000
  cpu_limit          = 500
  memory_limit_bytes = 1073741824 # 1 GiB
  min_scale          = 1
  max_scale          = 1
  privacy            = "public" # protégé par LITELLM_MASTER_KEY ; réseau privé = suivi

  environment_variables = {
    # Fallback Mistral La Plateforme non provisionné en staging : la config
    # référence os.environ/MISTRAL_API_KEY, il doit exister (vide accepté).
    MISTRAL_API_KEY = ""
  }

  secret_environment_variables = {
    LITELLM_MASTER_KEY = random_password.litellm_master_key.result
    # Generative APIs (souverain FR) s'authentifie avec la clé secrète Scaleway.
    SCW_GENERATIVE_API_KEY = var.scw_secret_key
  }
}

# public_endpoint peut être nu ou déjà préfixé selon la version du provider :
# on normalise en URL https dans tous les cas.
locals {
  litellm_url = startswith(scaleway_container.litellm.public_endpoint, "http") ? scaleway_container.litellm.public_endpoint : "https://${scaleway_container.litellm.public_endpoint}"
}

resource "scaleway_container" "api" {
  name               = "api"
  namespace_id       = scaleway_container_namespace.main.id
  image              = "${local.registry}/api:${var.image_tag}"
  port               = 8080
  cpu_limit          = 1000
  memory_limit_bytes = 2147483648 # 2 GiB
  min_scale          = 1
  max_scale          = 2
  privacy            = "public"

  environment_variables = {
    NODE_ENV               = "production"
    SCW_DEFAULT_REGION     = "fr-par"
    SCW_DEFAULT_PROJECT_ID = var.project_id
    SCW_SECRET_PREFIX      = local.secret_prefix
    LITELLM_BASE_URL       = local.litellm_url
    # 2e apply : URLs réelles ; 1er apply : placeholders le temps que les
    # domaines existent (l'auth 403 tant que WEB_ORIGIN n'est pas la vraie).
    WEB_ORIGIN    = var.web_origin != "" ? var.web_origin : "https://staging.invalid"
    AUTH_BASE_URL = var.api_base_url != "" ? var.api_base_url : "https://staging.invalid"
  }

  secret_environment_variables = {
    # Lecture/écriture du Secret Manager (boot + coffre connecteurs).
    SCW_SECRET_KEY     = var.scw_secret_key
    SCW_ACCESS_KEY     = var.scw_access_key
    LITELLM_MASTER_KEY = random_password.litellm_master_key.result
  }

  depends_on = [
    scaleway_secret_version.auth_secret,
    scaleway_secret_version.app_database_url,
  ]
}

resource "scaleway_container" "web" {
  name               = "web"
  namespace_id       = scaleway_container_namespace.main.id
  image              = "${local.registry}/web:${var.image_tag}"
  port               = 3000
  cpu_limit          = 500
  memory_limit_bytes = 1073741824 # 1 GiB
  min_scale          = 1
  max_scale          = 2
  privacy            = "public"
  # API_URL est figé DANS l'image (rewrites Next au build) — voir le workflow.
}

variable "scw_access_key" {
  description = "Clé d'accès Scaleway (env TF_VAR_scw_access_key dans le workflow)."
  type        = string
  sensitive   = true
}

variable "scw_secret_key" {
  description = "Clé secrète Scaleway (env TF_VAR_scw_secret_key dans le workflow)."
  type        = string
  sensitive   = true
}
