# Socle webhooks entrants (ticket 2.13)

La porte d'entrée des notifications fournisseurs — **prérequis technique de la
soumission PDP (2.4)** et du flux Bridge Connect hébergé. Un seul mécanisme,
partagé par tous les providers : signature, anti-rejeu, idempotence, journal.

## Le problème à résoudre

Une requête webhook **n'a aucune session** : ni cookie, ni organisation
active, donc aucun `tenantId` de session. C'est la seule surface du produit
où la chaîne `requireAuth → resolveTenant → requireMembership` ne s'applique
pas. Deux gardes la remplacent :

1. **La signature HMAC est la seule preuve d'authenticité.** Tout ce qui
   n'est pas prouvé est refusé.
2. **Le tenant se résout depuis l'endpoint**, jamais depuis le corps reçu —
   un `tenantId` injecté dans le payload n'a strictement aucun effet (testé).

## Résolution du tenant — `withWebhookResolver()`

Retrouver l'endpoint suppose de lire `webhook_endpoints` **avant** de
connaître le tenant, ce que la RLS interdit par construction. Même doctrine
que `withOps()` (2.18) : une policy supplémentaire `webhook_resolver_lookup`
**en LECTURE SEULE**, gated par `app.webhook_resolver`, posée dans la
transaction. Elle ne porte que sur cette table et n'expose que des
métadonnées (id, tenant, provider, référence de secret, actif) — jamais une
donnée métier ; `webhook_events` reste inaccessible sous cette porte (test
négatif dédié). Une fois le tenant connu, l'écriture repasse par `withTenant`
normal.

## Signature

```
X-Nodaq-Signature: t=<unix seconds>,v1=<hex hmac-sha256>
hmac = HMAC_SHA256(secret, "<t>.<octets bruts du corps>")
```

- **Corps BRUT** : le parser JSON est cantonné à un plugin encapsulé
  (`parseAs: "buffer"`), car une re-sérialisation casserait la preuve.
- **Horodatage signé** : il est *dans* la matière signée, donc un corps
  capturé ne peut pas être rejoué avec un `t` frais ; il est en plus contrôlé
  contre une fenêtre de ±300 s.
- **Comparaison en temps constant** (`timingSafeEqual`), longueur du digest
  vérifiée avant comparaison.
- **Corps borné** à 1 Mo : un fournisseur ne dicte pas notre mémoire.

## Réponses — pas d'oracle (en réponse)

Tout échec d'authentification (endpoint inconnu, inactif, provider qui ne
correspond pas, secret absent, signature fausse, horodatage hors fenêtre)
répond un **401 constant** `{"error":"unauthorized"}`. La raison réelle reste
dans le log serveur (ops), jamais dans la réponse : un appelant ne peut pas
énumérer les endpoints ni distinguer « n'existe pas » de « mal signé ».

**Nuance assumée** : l'égalité vaut pour le *contenu* de la réponse, pas pour
la *latence*. Un endpoint inconnu s'arrête après une lecture DB ; un endpoint
connu mal signé passe en plus par le coffre et le HMAC. Cet écart est un
oracle d'existence théorique, sans portée pratique (l'identifiant d'endpoint
est un UUID v4 non devinable) — un délai plancher serait le correctif si le
besoin apparaît.

Corps illisible, sans identifiant d'événement, ou refusé à l'insertion :
400 (la requête est authentifiée, elle est simplement inexploitable).

## Débit borné (disponibilité, art. 32)

C'est la seule route anonyme du produit : un flood de POST non signés
ouvrirait une transaction chacun et viderait le pool Postgres — l'API
tomberait **pour tous les tenants**. Un limiteur en mémoire (60 requêtes par
minute et par IP, nombre de clés suivies plafonné) s'exécute donc **avant
toute I/O**, et répond 429 au-delà. Per-process comme le balayage push : la
version partagée viendra avec le travail multi-réplicas (Redis).

Le secret d'endpoint est mis en cache 60 s (invalidé à la rotation) : sans
cela, chaque livraison déclencherait un appel au Secret Manager, provocable
par quiconque détient l'identifiant d'endpoint — qui est justement partagé
avec un tiers.

## Idempotence et traitement

- Unicité `(tenantId, provider, externalId)` : une **re-livraison ne crée
  jamais un second événement**. La réponse reste `202 {received, duplicate}` —
  un 4xx ferait boucler les re-tentatives du fournisseur pour rien.
- Le traitement métier tourne **après** la réponse (registre
  `webhookHandlers` par provider) : un handler lent ou en échec ne provoque
  pas de tempête de re-livraisons, et l'événement stocké reste la source de
  vérité pour un rejeu. Statuts : `received → processed | ignored | failed`
  (sans handler = `ignored`, jamais perdu ; échec = nom d'erreur seulement,
  jamais un message qui citerait le payload).

## Minimisation et rétention

- **Le payload n'est collecté que s'il va être traité** : sans handler
  enregistré pour le provider, la trace de réception est conservée (id
  d'événement, type, statut) mais **le corps fournisseur ne l'est pas** —
  transactions bancaires et factures nominatives n'ont aucune finalité tant
  que rien ne les consomme (art. 5.1.b/c). Brancher un handler (2.4, Bridge)
  ouvre la collecte pour ce provider, et pour lui seul.
- **Rétention 90 jours** : les réceptions plus anciennes sont purgées
  opportunément à chaque traitement (art. 5.1.e), sans balayeur dédié.
- **La rotation d'un secret ne détruit rien** : l'endpoint est mis à jour
  (même identifiant, donc même URL déjà configurée chez le fournisseur) et le
  journal des réceptions est conservé — une piste d'audit ne doit pas
  s'effacer d'un clic. Seule la révocation explicite supprime.

## Secrets

Générés par le **serveur** (256 bits CSPRNG), stockés au coffre sous
`webhook/<tenantId>/<provider>` et **renvoyés une seule fois** à la création
— jamais en base, jamais relisibles, absents de toute réponse ultérieure. La
référence de secret est vérifiée contre son namespace de tenant avant usage
(précédent connecteurs). Ré-émettre un endpoint = rotation du secret ; la
révocation purge le coffre.

## Routes

| Route | Accès | Rôle |
|---|---|---|
| `POST /webhooks/:provider/:endpointId` | **public**, signé | Réception |
| `POST /webhooks/endpoints` | owner | Créer / renouveler (secret une fois) |
| `GET /webhooks/endpoints` | owner | Métadonnées (jamais le secret) |
| `DELETE /webhooks/endpoints/:provider` | owner | Révoquer + purge coffre |
| `GET /webhooks/events` | owner | Journal (métadonnées, **jamais le payload**) |

UI : section « Webhooks entrants » de la page Connecteurs.

## Contrat fournisseur

- En-tête `X-Nodaq-Signature: t=<unix>,v1=<hex>` — `t` en secondes, **sans
  zéros de tête** (la matière signée est reconstruite à partir de l'entier).
- `Content-Type: application/json`, corps ≤ 1 Mo.
- Un identifiant d'événement stable (`id`, `event_id` ou `eventId`) : c'est la
  clé d'idempotence, sans elle la livraison est refusée.
- L'URL à configurer est renvoyée à la création de l'endpoint ; elle est
  absolue dès que `PUBLIC_API_URL` est défini côté API.

## Limites V1 (assumées)

- Pas de re-tentative automatique côté NODAQ (`failed` reste `failed`), et un
  arrêt du process laisse les `received` en l'état : le rejeu se fait à la
  demande du fournisseur ou par un futur balayeur de reprise.
- Limiteur et cache de secrets **par process** : un déploiement multi-réplicas
  multiplie le quota effectif d'autant (Redis avec le ticket T.2).
- Un endpoint par provider et par tenant ; pas d'allowlist d'IP source (la
  signature est la garde, l'IP n'ajouterait qu'une contrainte d'exploitation).
