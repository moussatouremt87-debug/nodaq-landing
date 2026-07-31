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

## Réponses — pas d'oracle

Tout échec d'authentification (endpoint inconnu, inactif, provider qui ne
correspond pas, secret absent, signature fausse, horodatage hors fenêtre)
répond un **401 constant** `{"error":"unauthorized"}`. La raison réelle reste
dans le log serveur (ops), jamais dans la réponse : un appelant ne peut pas
énumérer les endpoints ni distinguer « n'existe pas » de « mal signé ».

Corps illisible ou sans identifiant d'événement : 400 (la requête est
authentifiée, elle est simplement inexploitable).

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

## Limites V1 (assumées)

- Pas de re-tentative automatique côté NODAQ (`failed` reste `failed`) : le
  rejeu se fait à la demande du fournisseur ou par un futur balayage.
- Pas de purge automatique des événements traités (rétention à définir avec
  les premiers volumes réels).
- Un endpoint par provider et par tenant ; pas d'allowlist d'IP source (la
  signature est la garde, l'IP n'ajouterait qu'une contrainte d'exploitation).
