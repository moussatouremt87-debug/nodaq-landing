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
resource "scaleway_rdb_privilege" "admin_appdb" {
  instance_id   = scaleway_rdb_instance.main.id
  user_name     = scaleway_rdb_instance.main.user_name
  database_name = scaleway_rdb_database.appdb.name
  permission    = "all"
}

# app_user DOIT être déclaré dans le modèle Scaleway : la réconciliation des
# privilèges RDB (déclenchée par les applies) RÉVOQUE les droits des rôles
# qu'elle ne connaît pas — le GRANT CONNECT posé en psql disparaissait en
# quelques minutes (« User does not have CONNECT privilege », run #8).
# Le rôle existe déjà côté PG (créé par les migrations SQL) : le workflow
# fait un `terraform import` idempotent avant l'apply. NOSUPERUSER : la RLS
# (FORCE) reste le rempart — « all » ne la contourne pas.
resource "scaleway_rdb_user" "app" {
  instance_id = scaleway_rdb_instance.main.id
  name        = "app_user"
  password    = random_password.db_app.result
  is_admin    = false
}

resource "scaleway_rdb_privilege" "app_appdb" {
  instance_id   = scaleway_rdb_instance.main.id
  user_name     = scaleway_rdb_user.app.name
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
  port = 4000
  # 1000 mvCPU : 500 mvCPU plafonnent la mémoire à 2000 Mo (< 2 GiB refusé
  # par l'API). 2 GiB requis : à 1 GiB le conteneur est OOM-killed avant
  # même de logger (reproduit sur le runner CI : ExitCode=137, OOM=true).
  cpu_limit          = 1000
  memory_limit_bytes = 2147483648
  min_scale          = 1
  max_scale          = 1
  privacy            = "public" # protégé par LITELLM_MASTER_KEY ; réseau privé = suivi
  # L'image boote parfaitement en docker standard (reproduit sur le runner CI)
  # mais crashe « exit code 128 » dans la sandbox par défaut de Scaleway :
  # v2 (micro-VM) offre une meilleure compatibilité syscalls.
  sandbox = "v2"

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
  # UNE SEULE RÉPLIQUE, et c'est une contrainte de CORRECTION, pas de coût.
  #
  # Le bus d'événements (4.4) tient son registre d'abonnés SSE en mémoire du
  # processus, et son relais marque `delivered_at` après avoir dépêché. À deux
  # instances, l'instance A sert ses abonnés puis marque l'événement transmis :
  # les navigateurs branchés sur B ne reçoivent JAMAIS rien, et aucun compteur
  # ne le dit. C'est la panne de fraîcheur du 2.21 restaurée pour une fraction
  # des utilisateurs, en silence.
  #
  # Le code le documentait déjà en affirmant « le déploiement est
  # mono-réplique » — c'était faux, ce fichier autorisait 2.
  #
  # CE QUE CETTE LIGNE NE GARDE PAS, et il faut le dire : `max_scale` borne les
  # instances d'UNE révision, pas les processus vivants pendant le REMPLACEMENT
  # d'une révision. Un déploiement sans coupure implique par construction un
  # recouvrement — donc deux relais, donc le scénario ci-dessus, pendant
  # quelques dizaines de secondes à chaque `deploy-staging`. Cette ligne fait
  # passer la fenêtre de « permanente » à « le temps d'un déploiement ». Ce
  # n'est pas la même chose qu'un absolu, et le prochain lecteur doit le savoir.
  #
  # CE QUI LÈVERA LA CONTRAINTE : un canal partagé (`LISTEN/NOTIFY` PostgreSQL)
  # qui rend le registre en mémoire inutile. Un verrou entre répliques ne
  # suffirait PAS — la réplique gagnante marquerait les événements transmis
  # sans servir les abonnés de l'autre.
  max_scale = 1
  # CONCURRENCE — RISQUE CONNU, DÉLIBÉRÉMENT NON RÉGLÉ ICI.
  #
  # Le bus ajoute une connexion PERMANENTE par onglet (jusqu'à 4 par
  # utilisateur, tenues 30 min). Avec une seule instance, ces sockets occupent
  # la même enveloppe de concurrence que les requêtes ordinaires : quelques
  # dizaines d'onglets pourraient mettre en file les requêtes de tous les
  # tenants.
  #
  # `max_concurrency` a été essayé puis RETIRÉ : l'argument existe en provider
  # 2.49 mais a disparu des versions suivantes, et `versions.tf` épingle
  # `~> 2.49` SANS fichier de verrouillage — un `terraform init` en CI peut
  # donc résoudre une version où l'argument n'existe plus et faire échouer le
  # déploiement. Poser une valeur invalide dans un fichier qu'aucun test ne
  # couvre pour se prémunir d'une saturation encore théorique est un mauvais
  # échange. Le remplaçant est `scaling_option { concurrent_requests_threshold }`,
  # qui est un seuil de MISE À L'ÉCHELLE — donc inopérant tant que
  # `max_scale = 1`. La vraie réponse est la même que ci-dessus : `LISTEN/NOTIFY`,
  # qui lève le plafond de réplique et rend la question sans objet.
  privacy = "public"
  # Même politique que litellm : le moteur natif Prisma (lib .so) tourne dans
  # la sandbox v2 (micro-VM), compatibilité maximale.
  sandbox = "v2"

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

# ── Domaine custom du front (app.nodaq.fr) ────────────────────────────────
# La zone DNS de nodaq.fr est hébergée chez Scaleway (même projet) : le
# CNAME est géré ICI, et doit exister AVANT le domaine conteneur — Scaleway
# le valide pour émettre le certificat TLS (Let's Encrypt automatique).
locals {
  web_domain = var.web_subdomain != "" ? "${var.web_subdomain}.${var.dns_zone}" : ""
}

resource "scaleway_domain_record" "web" {
  count = local.web_domain != "" ? 1 : 0
  # project_id épinglé (audit RGPD) : la zone apex nodaq.fr sert aussi le
  # site public — ce state ne touche QUE la zone du projet désigné. La zone
  # peut vivre dans un AUTRE projet que le staging (dns_zone_project_id).
  project_id = var.dns_zone_project_id != "" ? var.dns_zone_project_id : var.project_id
  dns_zone   = var.dns_zone
  name       = var.web_subdomain
  type       = "CNAME"
  data       = "${scaleway_container.web.domain_name}."
  ttl        = 300
}

resource "scaleway_container_domain" "web" {
  count        = local.web_domain != "" ? 1 : 0
  container_id = scaleway_container.web.id
  hostname     = local.web_domain

  depends_on = [scaleway_domain_record.web]
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
