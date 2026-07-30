# Connecteur Silae — paie & RH (ticket 3.10)

Alimente l'équipe et les absences (3.5/3.6) depuis le SIRH/paie **Silae**,
au lieu de la saisie manuelle. Lecture SEULE : NODAQ ne modifie jamais rien
dans Silae.

## Réalité d'accès (assumée)

L'API Silae est réservée aux **partenaires agréés** (historiquement SOAP,
middlewares REST selon les intégrateurs). Le client V1
(`mcp-servers/connectors/src/silae.ts`) suit une interface REST simplifiée de
middleware partenaire, **base URL configurable** (`silaeBaseUrl`) — le
branchement réel se fait avec les identifiants fournis par le gestionnaire de
paie/intégrateur. En attendant : mode démo (fixtures « Élec Provence »).

## Onboarding (pattern 1.8)

`POST /connectors` type `silae` : `{ apiKey, dossierId }` — Zod strict,
identifiants **TESTÉS contre le fournisseur** (`testConnection()`, réponse
jetée) avant coffre (`connector/<tenant>/silae`), jamais renvoyés. Échec =
422 générique. Owner-only. Carte dédiée page Connecteurs.

## Outils MCP (lecture seule, OWNER-ONLY)

`silae_get_employees` et `silae_get_absences` (bornés, `truncated` signalé) —
noms de salariés = PII RH : les deux outils sont dans `OWNER_ONLY_TOOLS`
(fail-closed, test paramétré), comme `plan_staffing`.

## Synchronisation — `POST /connectors/silae/sync` (owner)

Déclenchée par l'humain depuis la page **Équipe & plannings** (précédent
FEC 2.14 : import humain = route directe owner, pas de pending_action).
Idempotente :

- **Salariés** : rapprochés par `externalRef` (id Silae, colonne dédiée
  unique `(tenantId, externalRef)`), sinon par nom (fiche manuelle existante
  → adoptée, `externalRef` posé), sinon créés. Conflit de nom insoluble =
  compté `employeesSkipped`, jamais un écrasement silencieux.
- **Absences** : fenêtre bornée, dédupliquées par
  `(staffId, type, startDate, endDate)` — re-synchroniser ne duplique rien.
- Compte-rendu chiffré (`created/updated/skipped`, `truncated`) affiché dans
  l'UI ; les fiches restent éditables à la main après sync.

## Limites V1 (assumées)

- Pas de webhooks Silae : la sync est manuelle (bouton), pas de planification.
- Salaires/bulletins NON lus : seulement identité, heures contractuelles,
  actif, absences — minimisation dès la source.
- Suppression côté Silae non propagée (désactivation manuelle des fiches).
