# Assistant IA souverain PME — contexte projet

Plateforme SaaS d'employés virtuels (agents IA) pour PME françaises. Souveraineté des
données (France/UE), architecture agentique, multi-tenant strict. Voir
`blueprint-technique-v2.md` pour l'architecture cible complète.

> **Langue** : code, identifiants et commentaires techniques en anglais ; docs produit en français.

> **État du repo** : tickets 0.1 (monorepo + RLS `notes`) et 0.2 (better-auth) livrés,
> **plugin organization branché** : `organization` = `tenants`, `member` = `memberships`
> (rôles `owner|member|accountant`), le tenant vient de l'organisation active de la
> session (`activeOrganizationId`) — le header `x-tenant-id` n'existe plus. La chaîne
> `requireAuth → resolveTenant → requireMembership → withTenant` est en place dans
> `apps/api/src/app.ts`. La landing page historique reste dans `index.html`.

---

## Stack

- **Monorepo** : pnpm workspaces + Turborepo. `apps/*`, `packages/*`, `services/*`, `mcp-servers/*`.
- **TypeScript** (app) : strict, ESM, Node 20+. API en **Fastify**. ORM **Prisma**. Validation **Zod**. Tests **Vitest**.
- **Python** (data/ML) : `uv` + **FastAPI**. `services/{rag,ml,ocr}`. Typé, **mypy** + **ruff**.
- **Agents** : `@anthropic-ai/claude-agent-sdk` (headless) dans `apps/agent-runtime`.
- **Modèles** : via **LiteLLM** (jamais d'appel LLM en direct). Fournisseurs souverains : Scaleway Generative APIs / Managed Inference, Mistral EU.
- **Données** : PostgreSQL + pgvector, Redis, Qdrant, Object Storage (S3). En prod : **Scaleway, région FR-PAR**. Local : `ops/docker-compose.yml`.
- **Auth** : better-auth + plugin organization (`organization` = tenant, `member` = membership).
- **Workflows** : BullMQ (démarrage) → Temporal (à l'échelle). **Observabilité** : Langfuse + OpenTelemetry.

---

## Commandes

```bash
# Infra locale (obligatoire avant tout)
cd ops && cp .env.example .env && docker compose up -d

# Dev
pnpm install
pnpm dev                      # tous les services (Turborepo)
pnpm --filter @nodaq/api dev  # un seul service

# Qualité (à lancer après chaque étape)
pnpm lint && pnpm typecheck && pnpm test
uv run ruff check && uv run mypy && uv run pytest    # côté Python

# Base
pnpm db:migrate               # applique migrations Prisma + policies RLS
pnpm db:reset                 # reset complet (dev)
```

---

## Règles NON négociables

1. **Souveraineté** : aucune donnée classée `confidentiel` ne sort du tier souverain.
   Tout appel modèle passe par `packages/classifier` puis LiteLLM — **jamais** un SDK
   fournisseur en direct depuis le code métier.
2. **Isolation multi-tenant (2 couches, toujours les deux)** :
   - **DB** : Row-Level Security active. Le seul accès aux données métier est
     `withTenant(tenantId, fn)` (transaction + `set_config('app.current_tenant_id', …, true)`).
   - **App** : chaîne d'autorisation obligatoire avant `withTenant` :
     `requireAuth → resolveTenant → requireMembership → withTenant`.
3. **Le `tenantId` vient de la session** (organisation active), jamais d'un input client
   non recontrôlé contre les memberships de l'utilisateur.
4. **Human-in-the-loop** : tout outil MCP d'écriture/envoi (`send_*`, `create_*`,
   `submit_*`) crée une `pending_action` à valider en 1 clic — il n'exécute **jamais**
   directement.
5. **Secrets** : jamais en clair, jamais commités. Lus depuis `.env` (dev) / Secret
   Manager (prod). Ne jamais logger un secret ni le contenu d'une donnée sensible.
6. **Toute nouvelle table métier** ⇒ colonne `tenantId` + policy RLS + **test
   d'isolation** (le test doit échouer si on retire la policy).

---

## Pattern `withTenant` (accès données)

```ts
// Seule porte d'accès aux tables métier. Pose le tenant DANS la transaction
// (portée locale) — indispensable à cause du pooling Prisma.
await withTenant(tenantId, async (tx) => {
  return tx.note.findMany();   // RLS scelle automatiquement au tenant
});
```

## Chaîne d'autorisation (routes métier)

```
requireAuth        -> valide la session better-auth, sinon 401
resolveTenant      -> tenant visé = organisation active de la session
requireMembership  -> vérifie EN BASE que l'user est membre du tenant, sinon 403
withTenant(id, …)  -> ouvre l'accès données (RLS = dernier rempart)
```

Rôles : `OWNER | MEMBER | ACCOUNTANT`. `ACCOUNTANT` = accès délégué multi-tenants
(expert-comptable) : membre de plusieurs organisations clientes. `requireRole([...])`
pour les actions sensibles (ex. inviter un membre = OWNER).

---

## Conventions

- **Frontières typées** : toute entrée externe (HTTP, webhook, sortie LLM) validée par Zod.
- **Types partagés** dans `packages/shared` ; ne pas dupliquer les types entre app et tests.
- **Tests** : Postgres réel (pas de mock DB) pour tout ce qui touche RLS/tenant. Un
  test d'isolation par table métier. Vitest côté TS, pytest côté Python.
- **Outils MCP** : un outil = un schéma Zod d'entrée/sortie + garde-fous. Les outils
  d'écriture déclarent `requiresValidation: true`.
- **Migrations** : Prisma pour le schéma ; les policies RLS et rôles Postgres dans une
  migration SQL dédiée qui suit. Utiliser le skill `/add-migration`.
- **Commits** : Conventional Commits (`feat:`, `fix:`, `chore:`…). Une PR = un ticket.

---

## Gotchas (pièges déjà rencontrés)

- **Superuser bypass la RLS.** L'app tourne avec un rôle Postgres **non super-user**
  (`app_user`). Le user `postgres` ignore les policies — ne jamais faire tourner l'app
  avec.
- **Pooling Prisma + `SET`.** Un `SET` hors transaction fuit entre requêtes. Toujours
  `set_config(..., true)` **dans** la transaction (`withTenant`).
- **Session ≠ autorisation.** Être connecté ne donne aucun droit sur un tenant ;
  `requireMembership` est obligatoire avant `withTenant`.
- **pgvector déjà activé** par `ops/db/init` — ne pas recréer l'extension.
- **Port ClickHouse (9000)** laissé interne dans le compose pour ne pas entrer en
  conflit avec MinIO.
- **Ne pas appeler les services Python depuis le front** : toujours passer par l'API.

---

## Méthode de travail

1. **Plan mode d'abord** pour tout ticket non trivial (lis ce fichier + le blueprint + le ticket).
2. **TDD** : écrire le test qui échoue, puis le code jusqu'au vert.
3. **Isolation** : une feature = une branche / un `git worktree`. Une PR = un ticket.
4. **Avant de considérer une tâche finie** : `pnpm lint && pnpm typecheck && pnpm test`
   verts (+ équivalents Python), et l'éval du workflow concerné si applicable.
5. **Sécurité/RGPD** : sur tout diff touchant données/tenant/auth, passer le sous-agent
   `rgpd-security-reviewer` avant merge.

---

## Structure du repo (rappel)

```
apps/      web (Next.js) · api (Fastify) · agent-runtime (Claude Agent SDK)
services/  rag · ml · ocr           (Python / FastAPI)
mcp-servers/ connectors · actions · einvoice   (outils métier MCP)
packages/  shared · classifier · db · llm
infra/     Terraform (Scaleway)     ops/  docker-compose local
.claude/   agents · skills · settings.json
```

## À NE PAS faire

- Appeler un SDK LLM fournisseur en direct (toujours LiteLLM via le classifier).
- Lire/écrire une table métier hors `withTenant`.
- Faire confiance à un `tenantId` venu du client sans contrôle d'appartenance.
- Exécuter une action d'écriture agentique sans passer par la file de validation.
- Committer un secret, ou logger de la donnée client sensible.
