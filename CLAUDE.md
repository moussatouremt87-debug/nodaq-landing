# Assistant IA souverain PME — contexte projet

Plateforme SaaS d'employés virtuels (agents IA) pour PME françaises. Souveraineté des
données (France/UE), architecture agentique, multi-tenant strict. Voir
`blueprint-technique-v2.md` pour l'architecture cible complète.

> **Langue** : code, identifiants et commentaires techniques en anglais ; docs produit en français.

> **État du repo** : 0.1→0.5 et 1.1→1.8 livrés (staging : workflow `deploy-staging` → URL). Auth : better-auth
> + plugin organization (`organization` = `tenants`, `member` = `memberships`, rôles
> `owner|member|accountant`) ; tenant = organisation active de la session, chaîne
> `requireAuth → resolveTenant → requireMembership → withTenant` (`apps/api/src/app.ts`).
> Secrets : `@nodaq/secrets`. LLM : `packages/llm` (`route()`/`routeChat()`), classifieur,
> connecteurs, RAG, OCR + `pending_actions`, trésorerie/relances (1.1→1.5).
> **Compta (1.6, ADR-006)** : boucle model-agnostic dans `apps/agent-runtime` — chaque
> itération passe par `routeChat()`, runtime LIÉ au tenant de session (jamais un input
> d'outil), écritures → `pending_action`, exécution UNIQUEMENT sur approbation
> (idempotente), chat SSE `/employees/compta/chat`, Langfuse métadonnées-seulement.
> **UI (1.7/1.8)** : `apps/web` (Next.js 15) — cockpit KPIs (trésorerie owner-only), file
> de validation 1-clic, chat SSE, onboarding connecteurs (identifiants Zod + TESTÉS contre
> le fournisseur puis coffre inscriptible `defaultWritableProvider` — Scaleway en prod,
> `.dev-vault.json` en dev — jamais renvoyés) ; API via le proxy de `next.config.ts`.
> **Import FEC (2.14)** : `packages/fec` (parseur A47 A-1 + dérivation 411/lettrage),
> connecteur fichier (statut `file`, posé UNIQUEMENT par `POST /connectors/fec/import`,
> owner, 50 Mo) — données CONFIDENTIELLES : jamais une ligne du journal dans les
> logs/erreurs/réponses ; repli registre vers l'interface Pennylane (`docs/fec-import.md`).
> **Classeur photo (2.16)** : `route()` accepte des images (data-URI, MIME allowlist) —
> catégorie `confidentiel` PAR CONSTRUCTION dès qu'une image est présente, hash d'audit
> texte+images. Table `classeur_documents` (photo en `Bytes` sous RLS, V1 assumée avant
> l'Object Storage), extraction vision souveraine, corrections append-only
> (apprentissage), rapprochement Qonto owner-only, photo servie UNIQUEMENT par la route
> binaire authentifiée (`docs/classeur.md`).
> **Banque DSP2 (2.15)** : `getBankClient()` = Qonto direct sinon agrégateur Bridge
> (toutes banques FR) — TOUS les consommateurs bancaires passent par lui, jamais par
> un client direct ; identifiants Bridge (clientId/clientSecret/userUuid) testés
> contre le fournisseur avant coffre ; flux Bridge Connect hébergé = ticket futur
> (`docs/bridge.md`).
> **Prévision ventes (3.1)** : modèle pur explicable (`salesForecast.ts`, régression
> clampée) sur les factures de l'interface Pennylane (réel/démo/FEC) — outil
> `forecast_sales` et carte cockpit OWNER-ONLY (`docs/prevision-ventes.md`).

---

## Stack

- **Monorepo** : pnpm workspaces + Turborepo. `apps/*`, `packages/*`, `services/*`, `mcp-servers/*`.
- **TypeScript** (app) : strict, ESM, Node 20+. API en **Fastify**. ORM **Prisma**. Validation **Zod**. Tests **Vitest**.
- **Python** (data/ML) : `uv` + **FastAPI**. `services/{rag,ml,ocr}`. Typé, **mypy** + **ruff**.
- **Agents** : boucle model-agnostic via `routeChat()` dans `apps/agent-runtime` (ADR-006 ; Claude Agent SDK = piste future non-sensible).
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
pnpm dev                      # tous les services (ou --filter @nodaq/api pour un seul)

# Qualité (à lancer après chaque étape)
pnpm lint && pnpm typecheck && pnpm test
cd services/rag && uv run ruff check && uv run mypy && uv run pytest   # côté Python

# Base
pnpm db:migrate               # applique migrations Prisma + policies RLS
pnpm seed:demo                # (re)crée le tenant démo « Élec Provence » (DEMO_USER_PASSWORD requis)
pnpm db:reset                 # reset complet (dev)
```

---

## Règles NON négociables

1. **Souveraineté** : aucune donnée classée `confidentiel` ne sort du tier souverain.
   Tout appel modèle passe par **`packages/llm.route()`** (classify → policy → garde
   dure → LiteLLM → audit hashé) — jamais LiteLLM ni un SDK fournisseur en direct
   depuis le métier. Embeddings : `embed()` (toujours souverain).
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
- **Port ClickHouse (9000)** laissé interne dans le compose (conflit MinIO sinon).
- **Ne pas appeler les services Python depuis le front** : toujours passer par l'API.
  Les services Python sont INTERNES : jeton d'appel obligatoire (`RAG_INTERNAL_TOKEN`).
- **Python : migrations = Prisma SEULEMENT.** Les services Python font du DML, jamais
  de DDL — `document_chunks` (pgvector) et sa RLS viennent de `packages/db`. La
  dimension d'embedding (1024) doit matcher la colonne `vector(1024)`.
- **Python : même RLS, même piège.** `services/rag/src/rag/db.py::with_tenant` =
  réplique de `withTenant` (rôle `app_user` + `set_config(..., true)` EN transaction).
  Garde au boot : refus de tourner en superuser. Embeddings via LiteLLM uniquement.
- **Shadow DB Prisma + pgvector** : `prisma migrate dev` exige une shadow DB où
  `CREATE EXTENSION vector` est déjà passé (voir `packages/db/.env.example`).
- **Secrets au boot, pas à l'import.** `injectSecrets()` (`@nodaq/secrets`) doit
  s'exécuter AVANT l'import des modules qui lisent `process.env` à l'import
  (`@nodaq/db`, `auth.ts`) — d'où les imports dynamiques dans `server.ts`.
- **`packages/secret-manager`** (et pas `secrets`) : la règle deny
  `Read(**/secrets/**)` de `.claude/settings.json` bloquerait le dossier.

---

## Méthode de travail

1. **Plan mode d'abord** pour tout ticket non trivial (lis ce fichier + le blueprint + le ticket).
2. **TDD** : écrire le test qui échoue, puis le code jusqu'au vert.
3. **Isolation** : une feature = une branche / un `git worktree`. Une PR = un ticket.
4. **Avant de considérer une tâche finie** : `pnpm lint && pnpm typecheck && pnpm test`
   verts (+ équivalents Python), et l'éval du workflow concerné si applicable.
5. **Sécurité/RGPD** : sur tout diff touchant données/tenant/auth, passer le sous-agent
   `rgpd-security-reviewer` avant merge (il rapporte, il ne corrige pas — gate humaine,
   pas bloqueur automatique).

### Outillage automatique (ticket 0.5)

- **Nouvelle table métier** ⇒ skill `/add-migration` (modèle + migration + RLS depuis
  le template bundlé + test d'isolation, via le sous-agent `migration-writer`).
- **Tests** ⇒ sous-agent `test-runner` (résumé court, jamais le log verbeux).
- **Hooks** (`.claude/hooks/`) : PreToolUse bloque les écritures dans les `.env` réels
  / fichiers de secrets / contenus ressemblant à un secret, plus `rm -rf` hors repo et
  `git push --force` (sans lease). PostToolUse lance lint+typecheck du package touché
  (jamais la suite de tests — trop lente pour un hook). Stop rappelle tests + gate RGPD.
- **ESLint** : `no-restricted-imports` interdit les SDK LLM fournisseurs dans `apps/**`
  et `mcp-servers/**` (exception : `apps/agent-runtime`, Claude Agent SDK légitime).
- **Permissions** : `.env` réels bloqués en lecture (`.env`, `.env.local`,
  `.env.{production,staging,development,test}*`, à la racine comme en sous-dossier),
  `**/secrets/**` et `*.pem` aussi ; `.env.example` éditable. Git : seuls les verbes
  de lecture + `add` sont auto-approuvés (`show`/`log -p` liraient les fichiers deny ;
  `commit`/`push` restent sur confirmation). Overrides perso dans
  `settings.local.json` (gitignored), qui l'emporte.

---

## Structure du repo (rappel)

```
apps/      web (Next.js) · api (Fastify) · agent-runtime (boucle ADR-006)
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
