# NODAQ — Assistant IA souverain PME — contexte projet

> Blueprint complet : voir `blueprint-technique-v2.md` (architecture, stack, plan de build).
> État actuel du repo : landing page (`index.html`). Le produit se construit par phases (§9 du blueprint).

## Stack cible
- Monorepo pnpm + Turborepo. TS : apps/ (web Next.js, api NestJS, agent-runtime).
- Python (uv) : services/ (rag, ml, ocr). Outils métier : mcp-servers/.
- Data : PostgreSQL+pgvector, Qdrant, Redis, Object Storage (Scaleway FR-PAR).
- Modèles via LiteLLM. Agents via @anthropic-ai/claude-agent-sdk.

## Commandes
- Dev : `pnpm dev` | Tests : `pnpm test` / `uv run pytest`
- Lint : `pnpm lint` / `ruff check` | Types : `pnpm typecheck` / `mypy`
- Migrations : `pnpm prisma migrate dev`
- Landing actuelle : ouvrir `index.html` directement (page statique, aucun build).

## Règles NON négociables
- Souveraineté : aucune donnée `confidentiel` ne sort du tier souverain. Toujours
  passer par packages/classifier ; jamais d'appel LLM en direct.
- Multi-tenant : toute requête DB filtre par tenant_id (RLS). Écrire un test
  d'isolation pour toute nouvelle table.
- Human-in-the-loop : tout outil d'écriture/envoi crée une pending_action, il
  n'exécute jamais directement.
- Secrets : jamais en clair, jamais commités. Lire via Secret Manager.
- Style : TS strict, Zod pour toute frontière ; Python typé + mypy.

## Gotchas
- Les serveurs MCP d'écriture doivent déclarer `requiresValidation: true`.
- Ne pas appeler les services Python depuis le front : passer par l'API.
- La landing (`index.html`) est autonome et en français — ne pas y introduire de
  dépendances de build.

## Workflow de développement
- Un ticket du plan (§9 du blueprint) à la fois : plan → tests → code → vérif.
- Features parallèles en `git worktree`.
- Passer le sous-agent `rgpd-security-reviewer` sur tout diff touchant données/tenants.
