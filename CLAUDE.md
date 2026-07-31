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
> **Apprentissage classeur (2.16b, JALON 3)** : mémoire fournisseur DÉRIVÉE des
> corrections (`classeurMemory.ts`, pur) — jamais stockée, recalculée à la
> lecture (doctrine 2.9) ; PAS de réentraînement (ni vecteur ni fine-tuning) ;
> preuve = journal `corrections[]` UNIQUEMENT (jamais `extraction`, qui porte
> les valeurs de la mémoire — sinon la règle s'auto-conforte) ; comparaison
> NORMALISÉE (« eur » ≠ désaccord) ; 4 refus testés : une seule correction ne
> fait pas règle (`MIN_EVIDENCE`),
> une contradiction GÈLE le champ (jamais d'arbitrage à la place de l'humain),
> la mémoire COMBLE ou SIGNALE mais n'écrase JAMAIS une lecture du modèle, et
> un tenant n'apprend JAMAIS d'un autre (`withTenant`, test dédié) ; AUCUN
> montant appris ; `originalExtraction` reste la lecture BRUTE (sinon la
> mémoire s'auto-alimente) ; colonne `learned` = trace d'explicabilité affichée
> (« d'après vos N corrections ») + `GET /classeur/memoire` (`docs/classeur.md`).
> **Cockpit conversationnel (2.5)** : le modèle n'écrit JAMAIS de SQL — il
> remplit une requête STRUCTURÉE contre un catalogue fermé versionné
> (`dataCatalog.ts`, 5 datasets), compilée par une fonction PURE qui valide
> champ par champ AVANT toute lecture ; gating à DEUX niveaux (dataset ET
> champ owner-only, ex. `cout_unitaire` 3.3), description du catalogue
> FILTRÉE par rôle, rôle issu de la SESSION (`ActionsServerContext.role`,
> jamais d'un input) ; exécuteur = allowlist explicite de modèles Prisma sous
> `withTenant` (`dataQuery.ts`) ; un refus est une RÉPONSE motivée (le modèle
> reformule au lieu d'inventer un chiffre) ; unité (centimes) et troncature
> DITES, tri par l'agrégat côté base ; outil `query_business_data` (membres) +
> `POST /cockpit/ask` = même boucle que le chat (`docs/cockpit-conversationnel.md`).
> **Devis depuis un e-mail (2.7)** : premier ticket où du texte de TIERS
> alimente une préparation d'ÉCRITURE — 3 gardes testées (corps délimité et
> annoncé comme donnée jamais instruction ; pipeline d'extraction SANS AUCUN
> OUTIL — `route()` nu, pas la boucle d'agent, donc une injection n'a rien à
> détourner ; sortie Zod bornée → `pending_action` `create_quote`) ; AUCUN
> PRIX inventé : le schéma n'a pas de champ de prix (un prix glissé par le
> modèle est strippé), `unitCostCents` (COÛT owner-only 3.3) n'est même pas lu
> — vendre au coût serait une erreur de gestion ; rapprochement au référentiel
> `quoteRequest.ts` (pur) = exact | probable | AUCUNE (jamais forcé : une
> ligne vide se relit, une ligne fausse ne se relit pas), `unmatchedCount`
> jamais tu ; troncature du référentiel DITE ; débit borné (2 appels modèle
> par requête) ; approuver PRÉPARE sans émettre (`emitted: false` — aucune API
> facturier en V1) et RÉDUIT le payload (nom/adresse/demande du prospect
> effacés, compteurs gardés) ; la file affiche provenance + lignes + non
> reconnues avant validation ; corps jamais logué ni renvoyé
> (`docs/devis-email.md`).
> **Rapport mensuel (2.11)** : premier ticket qui SYNTHÉTISE — le risque n'est
> plus la fuite mais l'AFFIRMATION. Une anomalie est un écart MESURÉ, jamais un
> jugement de modèle : seuils en CONFIG VERSIONNÉE (`monthlyReport.ts`,
> doctrine 2.19), moteur PUR, chaque anomalie porte observed/reference/
> threshold/sampleSize + phrase déjà chiffrée (le modèle relaie, ne conclut
> pas) ; MÉDIANE et non moyenne pour la facture inhabituelle (sinon elle masque
> sa propre référence), fenêtre de médiane adossée au MOIS ANALYSÉ jamais à
> aujourd'hui (sinon le verdict change sans qu'aucune donnée bouge) ; toute
> règle non exécutée est DITE dans `notEvaluated` (historique < 3 mois,
> dénominateur nul, < 6 factures ou médiane nulle, aucun impayé de référence,
> aucun CA du mois, aucune facture rattachée à un client) + 2 refus dans
> l'outil (mois EN COURS refusé — 3 semaines vs mois pleins = une « baisse » de
> calendrier ; hors fenêtre 24 mois) ; « cette facture compte-t-elle dans un
> CA ? » = UNE fonction partagée avec 3.1 (`normalizeSaleInvoice` — partager
> deux constantes ne suffit pas, c'est la SÉQUENCE de décisions qui doit être
> unique), statuts d'échéance partagés avec la relance (`OVERDUE_STATUSES`,
> `pending` exclu), devise étrangère comptée jamais convertie, factures non
> attribuées comptées et DITES (sinon une vraie concentration passe sous le
> seuil), troncature marquée DANS la phrase de chaque anomalie ;
> `build_monthly_report` OWNER-ONLY (CA + nom du premier client) +
> `GET /rapports/mensuel` par le MÊME outil (`docs/rapport-mensuel.md`).
> **Banque DSP2 (2.15)** : `getBankClient()` = Qonto direct sinon agrégateur Bridge
> (toutes banques FR) — TOUS les consommateurs bancaires passent par lui, jamais par
> un client direct ; identifiants Bridge (clientId/clientSecret/userUuid) testés
> contre le fournisseur avant coffre ; flux Bridge Connect hébergé = ticket futur
> (`docs/bridge.md`).
> **Prévision ventes (3.1)** : modèle pur explicable (`salesForecast.ts`, régression
> clampée) sur les factures de l'interface Pennylane (réel/démo/FEC) — outil
> `forecast_sales` et carte cockpit OWNER-ONLY (`docs/prevision-ventes.md`).
> **Stocks (3.2)** : `stock_items`/`stock_movements` (append-only, plancher 0, RLS) —
> ajustements membre, référentiel owner, alertes sous seuil (cockpit/page/chat),
> outil `adjust_stock` HITL = premier exécuteur RÉEL (`docs/stocks.md`).
> **Prix matières (3.3)** : `unitCostCents` sur les articles (owner-only en lecture ET
> écriture), simulation pure bornée −90 %…+500 % (`materialScenario.ts`), outil
> `simulate_material_prices` OWNER-ONLY, carte valorisation page Stocks
> (`docs/prix-matieres.md`).
> **Signaux clients (3.4)** : modèle pur `customerSignals.ts` (cadence/récence/tendance
> par client sur 24 mois → segments `a_risque|en_croissance|fidele|nouveau|ponctuel`,
> chaque verdict chiffré) — factures avec `customer {id,name}` (Pennylane/démo/FEC),
> outil `analyze_customer_signals` OWNER-ONLY (PII + CA par client), non-attribuées
> comptées jamais tues (`docs/signaux-clients.md`).
> **Push (2.17)** : payload push = `{type, count, deepLink}` STRUCTUREL (`PushPayload`
> clos, `apps/api/src/push.ts`) — jamais une donnée métier vers FCM/Apple ; clés VAPID
> au coffre (absentes = 503, dégradation propre) ; regroupement 15 min + pas de
> re-notif avant ouverture de la file ; opt-in par appareil/type, `push_subscriptions`
> RLS ; dispatch = sweep Postgres en process (BullMQ quand Redis existera)
> (`docs/notifications-push.md`).
> **Immobilisations (2.19)** : règles fiscales = CONFIG VERSIONNÉE DATÉE sourcée
> (`frenchTax.ts` — IS, acomptes, coefficients 39 A, durées, seuil 500 € HT) ; moteur pur
> `depreciation.ts` (linéaire 360 j, dégressif à bascule gelée, cession) vérifié à la
> main ; registre `fixed_assets` (RLS) alimenté par FEC 2x/28x + classeur + saisie —
> TOUJOURS via propositions `create_fixed_asset` validées (jamais d'insertion
> silencieuse) ; AMORTISSEMENT ≠ DÉCAISSEMENT (garde testée) : seuls l'économie d'IS
> ESTIMÉE (labellisée expert-comptable) et le CAPEX de renouvellement (scénario)
> touchent la trésorerie ; owner-only (`docs/immobilisations.md`).
> **Plannings RH (3.5)** : modèle pur `staffingPlan.ts` (capacité = heures hebdo
> × 4,348 − absences 5/7 ; charge estimée = prévision de ventes ÷ taux horaire
> CONFIGURABLE, verdicts ±10 % chiffrés, `inconnu` sans prévision — jamais de
> charge fabriquée, label estimation permanent) ; tables `staff_members` (nom =
> PII)/`staff_absences` RLS ; OWNER-ONLY de bout en bout (routes `/rh/*`, outil
> `plan_staffing`, page) ; solveur + connecteurs RH = V2 (`docs/plannings-rh.md`).
> **Performance horaire (3.6)** : modèle pur `hourlyPerformance.ts` (CA mensuel
> observé ÷ heures estimées des contrats − absences, mêmes conventions 3.1/3.5,
> verdicts vs objectif ±10 %, label « pas d'un pointage » PERMANENT) ; outil
> `analyze_hourly_performance` OWNER-ONLY, facturier absent = zéro mois calculé
> (`revenueUnavailable`), route `GET /rh/performance` + carte page RH
> (`docs/performance-horaire.md`).
> **Veille réglementaire (3.7)** : catalogue d'obligations PME = CONFIG VERSIONNÉE
> DATÉE sourcée (`regulatoryWatch.ts`, doctrine 2.19 — pas de flux externe en V1) ;
> moteur pur d'applicabilité (vertical + effectif, inconnu = `peut_etre` jamais tu,
> échéances fixes/récurrentes, tri par urgence) ; table `tenant_profiles` (RLS,
> 1 ligne/tenant) ; outil `check_regulatory_watch` + routes `/reglementaire*` +
> page OWNER-ONLY ; label « pas un conseil juridique » PERMANENT
> (`docs/veille-reglementaire.md`).
> **Avis clients (3.8)** : registre `customer_reviews` (RLS, dédup import par
> `(source, externalId)`, lecture membres / écriture owner) ; modèle pur
> `reputation.ts` (moyenne, tendance 6 mois vs 6, alertes ≤ 2/5 sans réponse —
> agrégats et ids SEULEMENT, jamais nom/texte) ; réponse = `draft_review_reply`
> HITL (route() souverain, minimisation : note+texte sans nom d'auteur) →
> exécuteur `record_review_reply` (enregistre, n'écrase JAMAIS) — publication
> plateforme MANUELLE en V1, connecteur Google = futur (`docs/e-reputation.md`).
> **Assistant RGPD (3.9)** : registre des traitements art. 30 — modèles PME =
> CONFIG VERSIONNÉE DATÉE sourcée CNIL (`rgpdRegister.ts`, doctrine 2.19/3.7) ;
> moteur pur `auditRgpdRegister` (registre vide, durée manquante, base invalide,
> art. 9 sur intérêt légitime — chaque signalement justifié) ; table
> `processing_activities` (RLS, unique (tenantId,name), AUCUNE PII par
> construction) ; outil `check_rgpd_register` + routes `/rgpd*` + page
> OWNER-ONLY ; label « ni conseil juridique ni DPO » PERMANENT ; AIPD/droits/
> violations + RAG CNIL = V2 (`docs/assistant-rgpd.md`).
> **Silae (3.10)** : connecteur SIRH/paie lecture SEULE (`silae.ts`, API partenaire
> — base URL configurable, identifiants testés avant coffre, mode démo) ; outils
> `silae_get_employees`/`silae_get_absences` OWNER-ONLY (PII RH) ; sync HUMAINE
> `POST /connectors/silae/sync` (owner, précédent FEC) idempotente —
> `externalRef` unique sur staff, absences dédupliquées, conflits comptés jamais
> écrasés ; salaires/bulletins JAMAIS lus (minimisation à la source)
> (`docs/silae.md`).
> **Modules par vertical (3.11)** : catalogue versionné `moduleCatalog.ts`
> (7 modules, défauts par vertical — stocks off en `services`, cœur jamais
> désactivable) ; moteur pur `resolveModules` (défaut vertical + surcharges
> owner, source affichée) ; désactivation = nav masquée + outils RETIRÉS du
> toolset (`buildToolset` filtre, fail-open sans profil) — PAS une frontière
> de sécurité (routes/autorisations inchangées, données conservées) ;
> `tenant_profiles.module_overrides` (JSONB), `GET /modules` (membres) /
> `PUT /modules/:id` (owner), page Réglages → Modules (`docs/modules.md`).
> **Factur-X (2.3)** : `packages/facturx` — valeurs normatives en CONFIG
> VERSIONNÉE (`profiles.ts` : URNs de profil, UNTDID 1001/5305, barème TVA FR,
> catégories d'opération ; calendrier RESTE dans 3.7) ; `buildCiiXml` PUR
> (ordre des éléments normatif, échappement XML systématique, centimes →
> décimal une seule fois) ; `auditInvoice` BLOQUE avant génération (totaux,
> TVA, SIREN des DEUX parties, mention d'exonération) ; PDF/A-3 avec
> `factur-x.xml` en `AFRelationship /Data` + XMP schéma d'extension
> (sans lui, non conforme) ; `extractFacturXXml` = moitié RÉCEPTION de
> l'obligation 09/2026 ; routes `POST /factures/facturx` (owner) et
> `/lire` (membres) (`docs/facturx.md`).
> **Soumission PDP + e-reporting (2.4, JALON 2)** : déposer ENGAGE l'entreprise
> (irréversible, opposable) — AUCUN outil MCP de dépôt, la route prépare,
> l'humain valide, l'exécuteur dépose ; audit de conformité REJOUÉ juste avant
> le dépôt, place RÉSERVÉE dans le registre AVANT l'appel réseau (l'index
> unique tranche, une lecture préalable ne garantit rien) et payload = facture
> NORMALISÉE (générateur pur, PDF jamais stocké) RÉDUITE dès l'action
> terminée ; aucun opérateur en dur = contrat abstrait `PdpClient`
> (deposit/getStatus/reportTransactions, URL = config de DÉPLOIEMENT
> `PDP_BASE_URL`, placeholder et non-https refusés en prod) ; statuts = CONFIG
> VERSIONNÉE `lifecycle.ts` (10 statuts, `isValidTransition` JAMAIS en arrière
> ni sur place, `erreur` = panne de NOTRE côté (jamais un verdict, refusée par
> le canal webhook), `normalizeStatus` inconnu = null jamais deviné) ; retour
> de statut par le socle 2.13 UNIQUEMENT (handler `pdp` par défaut, tenant de
> l'ENDPOINT, soumission jamais créée depuis un message entrant, historique
> APPEND-ONLY borné) ;
> e-reporting = AGRÉGATS (`aggregateEReporting` pur : B2B/B2C et TVA NON
> dérivables → dits, jamais devinés ; devise étrangère exclue jamais
> convertie) ; table `einvoice_submissions` (RLS, hash SHA-256 — NI PDF NI
> XML, unique (tenant,numéro,direction)) ; routes `/factures/soumettre`,
> `/soumissions`, `/ereporting*` OWNER-ONLY (`docs/pdp.md`).
> **Échéancier fiscal & social (2.9)** : règles de date = CONFIG VERSIONNÉE
> DATÉE sourcée (`taxCalendar.ts` — TVA/IS/CFE/DSN/URSSAF ; acomptes IS repris
> de `frenchTax.ts`, jamais redupliqués ; CVAE ABSENTE assumée, calendrier de
> suppression instable) ; moteur pur `buildTaxSchedule` — régime `inconnu`
> BLOQUE les échéances de TVA (jamais un régime supposé), date CA3 = borne
> BASSE marquée `dateIsApproximate` (elle dépend du SIREN), AUCUN montant
> produit (test littéral : pas de propriété `amount*`) ; le calendrier n'est
> JAMAIS stocké (recalculé à chaque lecture) — seules les décisions humaines
> vivent dans `tax_deadlines` (RLS), et une surcharge orpheline est ignorée
> (pas d'échéance fantôme après changement de régime) ; `plannedOutflowCents`
> ne compte QUE les montants saisis par l'owner (garde 2.19 : non chiffré =
> aucun impact trésorerie, `unpricedCount` jamais tu) ; outil
> `check_tax_calendar` + routes `/echeancier*` + page OWNER-ONLY ; label
> « ne remplace pas votre expert-comptable » PERMANENT
> (`docs/echeancier-fiscal.md`).
> **Webhooks entrants (2.13)** : SEULE surface sans session — la signature HMAC
> (`t=<unix>,v1=<hmac(secret, "t.corps brut")>`, ±300 s, `timingSafeEqual`, corps
> brut via plugin encapsulé, 1 Mo) est l'UNIQUE preuve ; le tenant vient de
> l'ENDPOINT via `withWebhookResolver()` (RLS gated `app.webhook_resolver`,
> LECTURE SEULE sur `webhook_endpoints`, doctrine `withOps`) — JAMAIS du corps ;
> 401 CONSTANT sur tout échec (pas d'oracle) ; idempotence
> `(tenant, provider, externalId)` → re-livraison = 202 `duplicate` sans écriture ;
> handlers métier APRÈS la réponse (`received→processed|ignored|failed`) ; secret
> serveur au coffre, renvoyé UNE fois, cache 60 s ; débit borné AVANT toute I/O
> (429, sinon un flood anonyme vide le pool) ; payload collecté SEULEMENT si un
> handler existe (minimisation) + rétention 90 j ; rotation NON destructive
> (même id/URL, journal conservé) (`docs/webhooks.md`).
> **Support (2.18)** : schéma Postgres `ops` (tables `support_tickets`/`support_issues`)
> hors RLS métier MAIS sous RLS gated `app.ops_operator` — accès UNIQUEMENT via
> `withOps()` + routes OPERATOR (allowlist `OPS_OPERATOR_USER_IDS`, 404 sinon) ;
> contexte tenant accordé SEULEMENT si SPF/DKIM alignés (From usurpable) ; e-mail entrant = donnée NON FIABLE (délimiteurs,
> pipelines SANS outils, `confidentiel`, inconnu = zéro LLM/contexte) ; corps
> UNIQUEMENT en Object Storage (jamais base/logs) ; RIEN ne part sans validation
> opérateur (TEM) ; recueil anonymisé par garde structurelle (`docs/support.md`).

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
