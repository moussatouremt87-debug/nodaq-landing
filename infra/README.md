# Infra staging — Scaleway FR-PAR (ticket 0.4)

Une URL vivante pour la démo du MVP. Tout est en **région fr-par** (souveraineté).

## Ce que déploie `terraform apply`

| Ressource | Rôle |
|---|---|
| `scaleway_rdb_instance` (db-dev-s, PostgreSQL 15) | Base `appdb` — RLS active, l'app tourne avec `app_user` (jamais admin) |
| `scaleway_registry_namespace` `nodaq-staging` | Images `api`, `web`, `litellm` |
| `scaleway_container` × 3 | API Fastify (8080), web Next standalone (3000), passerelle LiteLLM (4000) |
| `scaleway_secret` × 3 | `nodaq-staging-{AUTH_SECRET, DATABASE_URL, APP_DATABASE_URL}` — lus au boot par `injectSecrets()` |
| `random_password` × 4 | Mots de passe DB admin/app, AUTH_SECRET, clé maître LiteLLM — générés par Terraform, persistés dans le state (bucket S3 Scaleway), jamais commités ni loggés |

Le coffre des identifiants connecteurs (ticket 1.8) utilise le **même Secret
Manager** : l'API reçoit `SCW_SECRET_KEY` en variable secrète de conteneur et
`defaultWritableProvider()` bascule automatiquement sur Scaleway en production.

## Déployer

1. **Une fois** : dans GitHub → Settings → Secrets and variables → Actions,
   créer les secrets `SCW_ACCESS_KEY` et `SCW_SECRET_KEY` (clé API du projet
   staging). Le project id (non sensible) est en clair dans le workflow —
   surchargable par la variable de repo `SCW_DEFAULT_PROJECT_ID`.
2. Actions → **Deploy staging** → *Run workflow*.
3. L'URL de l'application s'affiche dans le résumé du job (`web_url`).

Le workflow fait trois `apply` (les domaines des conteneurs n'existent qu'après
création) : base+API+LiteLLM → migrations Prisma + rotation du mot de passe
`app_user` → build du web avec `API_URL` figé (rewrites Next au build) →
`WEB_ORIGIN` définitif (trustedOrigins better-auth).

## ⚠️ Staging ≠ production

- **Aucune donnée client réelle** dans cet environnement : base sans backup,
  ACL réseau ouverte (conteneurs serverless sans IP fixe), pas de rétention.
- **Avant tout usage prod** : clés IAM Scaleway SÉPARÉES (Terraform admin /
  API = Secret Manager scoping préfixe / LiteLLM = Generative APIs seul) — en
  staging la même clé sert partout, c'est le premier durcissement à faire.

## Limites du staging v0 (suivis)

- Services Python (RAG/OCR) non déployés : `rag_search` échoue proprement dans
  la boucle agent ; le reste (cockpit, connecteurs, relances, validation)
  fonctionne.
- Modèles LiteLLM : vérifier les noms dans `ops/litellm/config.yaml` contre la
  console Scaleway Generative APIs (ils évoluent).
- Conteneurs publics (protégés par auth applicative / clé maître) — réseau
  privé + LB à faire en durcissement.
- Pas de Langfuse déployé.
- Domaine custom : le front vit sur **app.nodaq.fr** (`web_subdomain`/`dns_zone`
  dans `variables.tf`). La zone DNS de nodaq.fr est hébergée chez Scaleway dans
  le même projet (`project_id` épinglé sur l'enregistrement) : le CNAME et le
  domaine conteneur (certificat TLS automatique) sont gérés par Terraform.
  `web_url` est dérivé de la RESSOURCE domaine (pas de la variable) : si le
  domaine n'a pas pu être créé, `WEB_ORIGIN` retombe sur l'URL Scaleway au
  lieu d'annoncer une origine que personne ne sert. L'API reste sur son URL
  Scaleway (appelée via le proxy Next, jamais directement par le navigateur).
  - **Retour arrière** : exporter `TF_VAR_web_subdomain=""` sur les steps
    d'apply du workflow (ou passer `-var web_subdomain=`) — pas de
    `prevent_destroy` sur l'enregistrement, précisément pour que ce chemin
    reste possible sans chirurgie de state.
  - **Enregistrement `app` préexistant dans la zone** : l'apply échouera en
    conflit — importer (`terraform import 'scaleway_domain_record.web[0]'
    <id-du-record>`) ou supprimer l'enregistrement avant.
  - Premier apply : l'émission Let's Encrypt peut prendre quelques minutes —
    le smoke test web a un budget de 6 min pour ça.
