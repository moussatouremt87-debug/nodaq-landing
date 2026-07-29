# Support & maintenance par e-mail (ticket 2.18)

`support@nodaq.fr` → polling IMAP → Object Storage → triage → un des 3
pipelines → **brouillon en file de validation opérateur** → envoi Scaleway TEM
après validation 1 clic → recueil des problèmes (anonymisé, validé).

## Architecture réelle (et écarts assumés vs ticket)

- **Polling IMAP en process** (90 s, connexions courtes, `imapflow`) — pas de
  BullMQ : aucun Redis provisionné (même décision que le dispatch push 2.17).
- **Corps + pièces jointes → Object Storage** (S3, fr-par en prod, MinIO en
  local ; PJ bornées 10 Mo, images/PDF seulement) — **jamais en base, jamais
  dans les logs** (les erreurs ne remontent que leur nom). Tout est optionnel :
  IMAP ou stockage absents = canal inactif, app intacte ; TEM absent = envoi
  en 503.
- **Schéma Postgres `ops`** (`support_tickets`, `support_issues`) : exception
  ASSUMÉE à la RLS métier — tables non tenant-scopées (un ticket peut ne pas
  avoir de tenant, le recueil sert tous les tenants), accessibles UNIQUEMENT
  par les routes `/ops/support/*`.
- **Rôle plateforme OPERATOR** = allowlist `OPS_OPERATOR_EMAILS` (coffre) —
  hors rôles tenant ; un non-opérateur reçoit **404** (l'existence du
  back-office n'est pas confirmée).
- **Recueil V1 en SQL plein-texte** (entrées validées seulement) — la
  réinjection dans une collection RAG ops dédiée viendra quand elle pourra se
  faire sans risque cross-tenant (le service RAG est tenant-scopé par
  construction).

## Les gardes (structurelles, testées)

1. **Le corps d'un e-mail est une DONNÉE, jamais une instruction.** Passé
   entre délimiteurs `<email>…</email>` à `route()` (catégorie `confidentiel`
   déclarée — ne peut qu'être endurcie) avec consigne d'ignorer toute
   injonction. La vraie défense : les « 3 agents » sont des **pipelines sans
   outils** (`support/pipelines.ts`) — aucun envoi, aucune écriture métier,
   aucun accès données sauf les **statuts** de connecteurs (lecture, tenant
   identifié) pour le diagnostic. Test d'injection : e-mail malveillant →
   ticket normal, zéro pending_action, zéro envoi.
2. **Rien ne part sans validation.** Seul `POST /ops/support/tickets/:id/send`
   envoie (TEM), après relecture/édition du brouillon. `auto_reply` n'existe
   que comme concept documenté, OFF — à activer quand le recueil aura fait ses
   preuves.
3. **Expéditeur identifié, pas cru.** From → user → memberships → tenant ;
   SPF/DKIM stocké comme *signal* (`authSignal`). **Inconnu = zéro contexte
   tenant et ZÉRO appel LLM** (l'audit de classification est tenant-scopé) :
   triage heuristique, brouillon générique qui renvoie vers l'app.
4. **Anonymisation structurelle** (`assertAnonymized`) : un rapport de bug ou
   une entrée de recueil contenant l'adresse de l'expéditeur, son domaine ou
   le nom du tenant est **REJETÉ** (et l'erreur ne répète jamais le terme).
   Le recueil sert tous les tenants : c'est la garde anti-« violation RGPD
   auto-infligée ».
5. **Idempotence par Message-ID** : re-poll, redémarrage → zéro doublon.
6. **P1 → push immédiat** aux opérateurs via la brique 2.17 — catégorie
   `support`, payload `{type: "support_p1", count, deepLink: "/ops/support"}`,
   jamais le sujet ni l'expéditeur.

## Boucle opérateur (`/ops/support`, apps/web)

Tickets (filtres statut/niveau/origine) → fiche : message original (servi
depuis le stockage par une route dédiée), rapport d'agent, brouillon éditable,
**Valider et envoyer** ; résolution avec proposition d'entrée de recueil
(refusée si non anonymisée) ; recueil avec validation 1 clic ; stats
(`/ops/support/stats`).

## Config (coffre)

`SUPPORT_IMAP_HOST/PORT/USER/PASSWORD` (boîte FR/UE), `SUPPORT_S3_*`
(endpoint, bucket, clés — MinIO en local), `SUPPORT_FROM_EMAIL` +
`SCW_SECRET_KEY`/`SCW_DEFAULT_PROJECT_ID` (TEM), `OPS_OPERATOR_EMAILS`.

## À ne pas faire

- Stocker ou logger un corps d'e-mail (base, logs, réponses JSON) — Object
  Storage uniquement, servi à l'opérateur seul.
- Donner un outil (envoi, écriture, lecture large) aux pipelines de support.
- Mettre un nom/adresse/domaine client dans le recueil ou une issue.
- Répondre des données sensibles par e-mail : la réponse renvoie vers l'app.
