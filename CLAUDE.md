# nodaq — assistant opérationnel des TPE à l'affaire

**L'utilisateur ne saisit rien. Il dicte, il photographie, il valide. L'assistant
prépare, l'humain valide, le système apprend.**

Les outils existants s'organisent par période et par compte ; nous nous organisons
**par affaire**. Un logiciel de compta répond à « combien j'ai gagné en juin » ; nous
répondons à « est-ce que **ce** chantier me rapporte de l'argent, pendant qu'il est
encore en cours ».

**Cible** : TPE de 3 à 15 salariés travaillant à l'affaire (bâtiment, paysage,
événementiel, maintenance, services au projet). **Hors cible** : encaissement immédiat,
micro-entrepreneurs, PME de 20+ déjà sous ERP.

> **Pivot du 2026-08-02** — lis [`docs/adr/ADR-007`](docs/adr/ADR-007-pivot-assistant-operationnel.md)
> avant tout ticket 4.x. Il prime sur `blueprint-technique-v2.md`, qui reste en place
> comme trace de l'ancienne direction et dont **l'architecture demeure en vigueur**.
> **Langue** : code et commentaires en anglais ; docs produit en français.

---

## Les deux règles de structure du nouveau produit

1. **L'objet Affaire est le pivot du modèle.** Chantier, événement, intervention,
   mission : une dépense, une transaction, un document, une facture s'y rattachent.
   **Tout rattachement est NULLABLE, sans exception** — une pièce sans affaire (frais
   généraux, essence, assurance) est le cas majoritaire au démarrage, et l'existant
   doit continuer de fonctionner sans connaître les affaires.
   Le rattachement passe par `affaire_imputations` (polymorphe) : les transactions
   bancaires ne sont **pas** stockées et les lignes de temps n'existent pas, donc une
   colonne `affaireId` ne vit que là où une table existe. **Aucune suppression** :
   statut `ARCHIVEE`, qui ne détache rien.
2. **Un vertical = un fichier de données, jamais une ligne de code métier.** Le
   vocabulaire et les réglages viennent du pack. Un `if (vertical === 'btp')` dans une
   feature transforme un produit en cinq produits à maintenir : si un pack semble
   exiger du code, c'est le **moteur** qu'il faut étendre.

---

## Règles NON négociables

1. **Souveraineté** : aucune donnée classée `confidentiel` ne sort du tier souverain.
   Tout appel modèle passe par **`packages/llm.route()`** / `routeChat()` (classify →
   policy → garde dure → LiteLLM → audit hashé) — jamais LiteLLM ni un SDK fournisseur
   en direct depuis le métier. Embeddings : `embed()` (toujours souverain).
   Audio : `transcribe()` — catégorie FIXÉE à `confidentiel` (on ne classifie pas ce
   qu'on n'a pas encore lu) et aucun paramètre de tier (`spike-transcription-souveraine.md`).
2. **Isolation multi-tenant (2 couches, toujours les deux)** :
   - **DB** : Row-Level Security active. Le seul accès aux données métier est
     `withTenant(tenantId, fn)` (transaction + `set_config('app.current_tenant_id', …, true)`).
   - **App** : chaîne d'autorisation obligatoire avant `withTenant` :
     `requireAuth → resolveTenant → requireMembership → withTenant`.
3. **Le `tenantId` vient de la session** (organisation active), jamais d'un input client
   non recontrôlé contre les memberships de l'utilisateur.
4. **Human-in-the-loop** : tout outil MCP d'écriture/envoi (`send_*`, `create_*`,
   `submit_*`) crée une `pending_action` à valider en 1 clic — il n'exécute **jamais**
   directement. C'est devenu un **argument produit** : l'assistant prépare, le patron valide.
5. **Secrets** : jamais en clair, jamais commités. Lus depuis `.env` (dev) / Secret
   Manager (prod). Ne jamais logger un secret ni le contenu d'une donnée sensible.
6. **Toute nouvelle table métier** ⇒ colonne `tenantId` + policy RLS + **test
   d'isolation** (le test doit échouer si on retire la policy).
7. **Apprentissage = mémoire par tenant**, dérivée à la lecture, jamais de
   réentraînement, jamais de partage inter-tenant.

### Doctrines transverses (apprises à leurs dépens)

- **Config versionnée datée sourcée** pour toute règle métier (taux, seuils, plans de
  comptes, obligations) : `frenchTax.ts`, `taxCalendar.ts`, `costCategories.ts`,
  `receivableAccounts.ts`, `moduleCatalog.ts`… Une règle qui bouge doit se voir en diff.
- **Un refus est une RÉPONSE motivée**, jamais un chiffre inventé ni un zéro muet.
- **Ce qui n'est pas calculé est DIT** (troncature, règle non évaluée, limite d'une
  dérivation) : un compteur qui disparaît sans un mot est une donnée perdue.
- **Jamais d'inférence quand le coût des deux erreurs est asymétrique.** Ne pas
  reconnaître laisse un problème visible ; reconnaître à tort le rend muet.
- **Types qui rendent l'erreur impossible** : union discriminée plutôt qu'un optionnel
  qu'un écran pourrait afficher à tort (borne supérieure de marge).
- **Un écran qui écrit périme les vues des AUTRES** : après un succès, `emitDomainEvent`
  (`fraicheur-donnees.md`) — un affichage figé qui se dit « à jour » est un mensonge,
  et il ne se voit qu'en démonstration.

## Stack

- **Monorepo** : pnpm workspaces + Turborepo. `apps/*`, `packages/*`, `services/*`, `mcp-servers/*`.
- **TypeScript** (app) : strict, ESM, Node 20+. API en **Fastify**. ORM **Prisma**.
  Validation **Zod**. Tests **Vitest**. Front **Next.js 15**.
- **Python** (data/ML) : `uv` + **FastAPI**. `services/{rag,ml,ocr}`. **mypy** + **ruff**.
- **Agents** : boucle model-agnostic via `routeChat()` dans `apps/agent-runtime` (ADR-006).
- **Modèles** : via **LiteLLM** uniquement. Fournisseurs souverains : Scaleway, Mistral EU.
- **Données** : PostgreSQL + pgvector, Redis, Qdrant, Object Storage (Scaleway FR-PAR).
- **Auth** : better-auth + organization (`organization` = tenant, `member` = membership).
  **Observabilité** : Langfuse (métadonnées seulement) + OpenTelemetry.

## Commandes

```bash
cd ops && cp .env.example .env && docker compose up -d   # infra locale (obligatoire)
pnpm install && pnpm dev                                  # --filter @nodaq/api pour un seul
pnpm lint && pnpm typecheck && pnpm test                  # après chaque étape
cd services/rag && uv run ruff check && uv run mypy && uv run pytest
pnpm db:migrate     # migrations Prisma + policies RLS · pnpm seed:demo (tenant démo)
```

---

## Pattern `withTenant` et chaîne d'autorisation

```ts
// Seule porte d'accès aux tables métier. Pose le tenant DANS la transaction
// (portée locale) — indispensable à cause du pooling Prisma.
await withTenant(tenantId, async (tx) => tx.note.findMany());
```

```
requireAuth        -> valide la session better-auth, sinon 401
resolveTenant      -> tenant visé = organisation active de la session
requireMembership  -> vérifie EN BASE que l'user est membre du tenant, sinon 403
withTenant(id, …)  -> ouvre l'accès données (RLS = dernier rempart)
```

Rôles : `OWNER | MEMBER | ACCOUNTANT`. `ACCOUNTANT` = accès délégué multi-tenants
(expert-comptable). `requireRole([...])` pour les actions sensibles. Portes analogues :
`withOps()` (schéma `ops`, support 2.18) et `withWebhookResolver()` (2.13).

---

## Ce qui existe (et où sa doctrine est écrite)

Le détail vit dans `docs/` — **lis le doc du domaine avant d'y toucher**.

| Domaine | Où | Doc |
|---|---|---|
| Socle : auth, RLS, classifier, LLM, agent-runtime, file de validation | `packages/*`, `apps/agent-runtime` | ADR-006 |
| **Affaires** (pivot) : imputations, marge déterministe, vocabulaire | `apps/api/src/affaires.ts`, `packages/shared/src/affaireMargin.ts` | `affaires.md` |
| **Packs verticaux** : métiers, libellés, vocabulaire accordé (un vertical = une DONNÉE) | `packages/shared/src/verticalPacks.ts` | `packs-verticaux.md` |
| Imputation suggérée (photo → affaire, **jamais écrite d'office**) | `apps/api/src/affaireSuggestion.ts` | `imputation-suggeree.md` |
| Brief du matin (assemblage déterministe, angles morts DITS) | `apps/api/src/briefMatin.ts` | `brief-matin.md` |
| File de validation (affaire + socle ; une action ne se masque jamais) | `apps/api/src/app.ts`, `packages/shared/src/pendingActionCatalog.ts` | `file-validation.md` |
| Classeur photo + mémoire tenant | `apps/api/src/classeur*.ts` | `classeur.md` |
| Équipe, plannings, performance horaire (**PII, owner-only**) | `apps/api/src` | `plannings-rh.md`, `performance-horaire.md` |
| Import FEC (source de données) | `packages/fec` | `fec-import.md` |
| **Effacement (art. 17)** : effacer une source efface ce qui en DÉRIVE | `apps/api/src/app.ts` | `effacement.md` |
| **Rétention (art. 5.1.e)** : une proposition qui dort n'est plus une proposition | `apps/api/src/retention.ts` | `retention-file-validation.md` |
| Marge, rapport mensuel, cockpit conversationnel, devis e-mail, prospection | `mcp-servers/actions/src` | `marge.md`, `rapport-mensuel.md`, `cockpit-conversationnel.md`, `devis-email.md`, `prospection.md` |
| **Devis dicté** (audio jamais stocké ; la transcription EST la relecture) | `apps/api/src/app.ts`, `packages/llm/src/audioFormat.ts` | `dictee.md` |
| Registre de modules (**frontière du produit**) | `packages/shared/src/moduleCatalog.ts` | `modules.md` |
| Webhooks entrants, push, support e-mail | `apps/api/src` | `webhooks.md`, `notifications-push.md`, `support.md` |
| Fraîcheur des écrans (bus d'invalidation, registre des mutations) | `apps/web/lib/freshness.ts` | `fraicheur-donnees.md` |
| Connecteurs (Pennylane, Qonto, Bridge, Silae, PDP) | `mcp-servers/connectors` | `bridge.md`, `silae.md` |
| **Modules hors socle** (éteints, jamais supprimés) | catalogue 3.11 | ADR-007 |

**Éteindre ≠ supprimer ≠ fermer.** Un module hors socle perd sa page et ses outils
d'agent ; **ses routes API restent ouvertes** et ses autorisations inchangées. C'est une
surface produit, pas une frontière de sécurité.

## Conventions

- **Frontières typées** : toute entrée externe (HTTP, webhook, sortie LLM) validée par Zod.
- **Types partagés** dans `packages/shared` ; ne pas dupliquer entre app et tests.
- **Tests** : Postgres réel (pas de mock DB) pour tout ce qui touche RLS/tenant. Un test
  d'isolation par table métier. Vitest côté TS, pytest côté Python.
- **Outils MCP** : un outil = un schéma Zod d'entrée/sortie + garde-fous. Les outils
  d'écriture déclarent `requiresValidation: true`. Owner-only : `OWNER_ONLY_TOOLS`.
- **Migrations** : Prisma pour le schéma ; policies RLS et rôles dans une migration SQL
  dédiée qui suit. Utiliser le skill `/add-migration`.
- **Commits** : Conventional Commits. **Une PR = un ticket.**

---

## Méthode de travail

1. **Plan mode d'abord** pour tout ticket non trivial (ce fichier + l'ADR-007 + le ticket).
2. **TDD** : écrire le test qui échoue, puis le code jusqu'au vert.
3. **Avant de considérer une tâche finie** : `pnpm lint && pnpm typecheck && pnpm test`
   verts (+ équivalents Python).
4. **Sécurité/RGPD** : sur tout diff touchant données/tenant/auth, passer le sous-agent
   `rgpd-security-reviewer` — et **traiter toutes ses conclusions**. Il rapporte, il ne
   corrige pas.
5. **Sois le contre-pouvoir technique** : si une décision produit oblige à trahir une
   règle ci-dessus, dis-le et propose l'alternative générique, avant de coder.

**Outillage** : `/add-migration`, sous-agents `test-runner` et `rgpd-security-reviewer`,
hooks `.claude/hooks/` (PreToolUse bloque secrets et `rm -rf` hors repo ; PostToolUse
lint+typecheck du package touché).

---

## Gotchas (pièges déjà payés)

- **Superuser bypasse la RLS** : l'app tourne en `app_user`, jamais `postgres`.
- **Pooling Prisma + `SET`** : toujours `set_config(..., true)` **dans** la transaction.
- **Session ≠ autorisation** : `requireMembership` obligatoire avant `withTenant`.
- **Secrets au boot, pas à l'import** : `injectSecrets()` avant l'import des modules qui
  lisent `process.env` (d'où les imports dynamiques dans `server.ts`).
- **Python : migrations = Prisma SEULEMENT** ; `with_tenant` y réplique `withTenant`.
- **pgvector déjà activé** (`ops/db/init`) ; shadow DB requise par `prisma migrate dev`.
- **Services Python jamais appelés depuis le front** : via l'API (jeton interne).
- **`packages/secret-manager`** (pas `secrets`) : la règle deny `Read(**/secrets/**)` bloque.
- **Dimension d'embedding 1024** ⇄ colonne `vector(1024)` : elles doivent matcher.
- **ESLint `no-restricted-imports`** interdit les SDK LLM fournisseurs dans `apps/**` et
  `mcp-servers/**` — **exception documentée** : `apps/agent-runtime` (Claude Agent SDK,
  ADR-006). Ce n'est pas un oubli à « corriger ».

---

## À NE PAS faire

- Appeler un SDK LLM fournisseur en direct (toujours LiteLLM via le classifier).
- Lire/écrire une table métier hors `withTenant`.
- Faire confiance à un `tenantId` venu du client sans contrôle d'appartenance.
- Exécuter une action d'écriture agentique sans passer par la file de validation.
- Committer un secret, ou logger de la donnée client sensible.
- **Rendre un rattachement d'affaire obligatoire** « pour la propreté ».
- **Supprimer le code d'un module éteint** : l'extinction passe par le registre, et rien d'autre.
- Relancer un ticket 2.x/3.x non livré : ils appartiennent à l'ancienne feuille de route.
