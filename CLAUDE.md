# NODAQ — Assistant IA souverain PME — contexte projet

> Blueprint complet : voir `blueprint-technique-v2.md` (architecture, stack, plan de build).
> État : monorepo initialisé (ticket 0.1 — fondations + socle multi-tenant RLS,
> ticket 0.2 — auth better-auth + tenant de session).
> La landing page historique reste dans `index.html`.

## Stack
- Monorepo pnpm workspaces + Turborepo. TypeScript strict, ESM, Node 20+.
- `apps/api` : Fastify (ADR-003 tranché Fastify au ticket 0.1) — health + notes RLS.
- `packages/shared` : types + schémas Zod partagés (TenantId, CreateNoteInput...).
- `packages/db` : Prisma + Postgres, helper `withTenant`, client admin séparé.
- `services/` : futurs micro-services Python (uv) — rag, ml, ocr.
- Cible : Next.js (web), agent-runtime (@anthropic-ai/claude-agent-sdk), LiteLLM,
  Qdrant, Redis, Object Storage — voir blueprint §3.

## Commandes
- Stack locale (PG+pgvector, Redis, Qdrant, MinIO, LiteLLM, Langfuse) :
  `cd ops && cp .env.example .env && docker compose up -d` (détails : `ops/README.md`)
- Setup : `cp .env.example .env && cp packages/db/.env.example packages/db/.env`
- Install : `pnpm install` | Build : `pnpm build` | Dev API : `pnpm --filter @nodaq/api dev`
- Tests : `pnpm test` (sérialisés — base réelle partagée) | Lint : `pnpm lint` | Types : `pnpm typecheck`
- Migrations : `pnpm db:migrate` (dev) / `pnpm db:migrate:deploy` (CI/prod) / `pnpm db:reset`
- Landing actuelle : ouvrir `index.html` directement (page statique, aucun build).

## Multi-tenant : le pattern withTenant (OBLIGATOIRE)
- Deux rôles Postgres : `postgres` (admin — migrations/seeds SEULEMENT, bypass la RLS)
  et `app_user` (non-superuser, NOBYPASSRLS — tout le runtime). L'app ne tourne
  JAMAIS en admin, sinon la RLS est silencieusement bypassée.
- Toute requête sur une table métier passe par `withTenant(tenantId, fn)`
  (`packages/db/src/index.ts`) : transaction + `set_config('app.current_tenant_id',
  id, true)` (portée transaction — sûr avec le pooling). Jamais de `prisma.note.*`
  hors `withTenant`.
- **Toute nouvelle table métier ⇒** `tenant_id uuid` non nullable + index, RLS
  `ENABLE` + `FORCE` + policy `tenant_isolation` (pattern dans la migration
  `rls_notes`), **et un test d'isolation** dans `packages/db/test/` qui prouve que
  la fuite se produit si on désactive la RLS.
- Le tenant vient de la SESSION (better-auth, ticket 0.2) : `requireTenant` résout
  les memberships du user connecté. Le header `x-tenant-id` n'est qu'un sélecteur
  parmi SES tenants (403 sinon) — jamais une source de vérité.
- Tables d'auth (`users`, `sessions`, `accounts`, `verifications`) et la table
  pont `memberships` : plan auth, pas de RLS (un user vit dans plusieurs tenants).
  La règle RLS s'applique aux tables MÉTIER (notes et suivantes).
- Auth : better-auth (email+password) monté sur `/api/auth/*` (`apps/api/src/auth.ts`).
  `AUTH_SECRET` obligatoire en prod (le défaut de dev est refusé au boot).

## Règles NON négociables
- Souveraineté : aucune donnée `confidentiel` ne sort du tier souverain. Toujours
  passer par packages/classifier ; jamais d'appel LLM en direct.
- Multi-tenant : toute requête DB passe par `withTenant` (RLS). Test d'isolation
  pour toute nouvelle table.
- Human-in-the-loop : tout outil d'écriture/envoi crée une pending_action, il
  n'exécute jamais directement.
- Secrets : jamais en clair, jamais commités. Lire via Secret Manager (dev : `.env`
  gitignorés, valeurs par défaut = stack `ops/` uniquement).
- Style : TS strict, Zod pour toute frontière ; Python typé + mypy.

## Gotchas
- Un superuser Postgres bypass la RLS : les tests d'isolation vérifient que le
  client applicatif n'est ni `rolsuper` ni `rolbypassrls` — ne pas retirer ce garde-fou.
- `set_config(..., true)` DOIT rester dans une transaction (un `SET` global fuit
  entre requêtes à cause du pooling Prisma).
- L'extension `vector` est activée par `ops/db/init` — ne pas la recréer.
- `pnpm test` tourne avec `--concurrency=1` : les suites db et api partagent la
  même base ; ne pas re-paralléliser.
- Les serveurs MCP d'écriture doivent déclarer `requiresValidation: true`.
- Ne pas appeler les services Python depuis le front : passer par l'API.
- La landing (`index.html`) est autonome et en français — ne pas y introduire de
  dépendances de build.

## Workflow de développement
- Un ticket du plan (§9 du blueprint) à la fois : plan → tests → code → vérif.
- Features parallèles en `git worktree`.
- Passer le sous-agent `rgpd-security-reviewer` sur tout diff touchant données/tenants.
- CI (`.github/workflows/ci.yml`) : Postgres de service (pgvector), migrations,
  lint + typecheck + tests — les tests d'isolation sont bloquants.
