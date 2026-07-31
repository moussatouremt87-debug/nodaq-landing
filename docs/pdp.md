# Soumission PDP + e-reporting (ticket 2.4)

Le raccordement au réseau de la facturation électronique. 2.3 a produit le
document ; 2.13 a posé le canal de retour ; ce ticket relie les deux : une
facture part sur une **plateforme de dématérialisation** (PDP), et ce que la
plateforme en dit revient dans le produit.

C'est le **jalon 2** du plan : à partir de là, NODAQ n'explique plus la
réforme, il l'exécute.

## Ce qui rend ce ticket différent : le dépôt engage

Déposer une facture sur le réseau n'est pas un appel API de plus. C'est
**irréversible**, horodaté, opposable, et visible par le client. Une facture
déposée en double se voit ; une facture déposée non conforme laisse une trace
publique d'émission fautive.

Trois conséquences, toutes structurelles ici :

1. **Rien ne part de la boucle agent.** Il n'existe aucun outil MCP de dépôt.
   La route prépare, l'humain valide, l'exécuteur dépose (règle HITL du
   `CLAUDE.md`, même doctrine que `adjust_stock`).
2. **L'audit de conformité est REJOUÉ juste avant le dépôt.** La proposition
   peut dormir des heures dans la file ; entre-temps la config de règles a pu
   bouger. `submit_einvoice` refait `auditInvoice()` et refuse de déposer une
   facture qui n'est plus émissible.
3. **Le payload de la file porte la facture normalisée, jamais le PDF.** Le
   générateur (2.3) est pur : le document est reconstruit à l'identique au
   moment du dépôt. Stocker un PDF en base pour le ressortir plus tard aurait
   doublé la donnée client sans rien garantir de plus.

## Aucun opérateur en dur

La réforme laisse chaque entreprise choisir sa plateforme, et leurs API
diffèrent. Parier sur un opérateur serait un mauvais pari produit *et* un
mauvais pari commercial (un éditeur repreneur a déjà la sienne). D'où un
**contrat abstrait étroit** — `PdpClient` (`mcp-servers/connectors/src/pdp.ts`) :

| Méthode | Rôle |
|---|---|
| `deposit` | dépose un document Factur-X, renvoie la référence plateforme |
| `getStatus` | relit un statut (repli quand un webhook a été manqué) |
| `reportTransactions` | transmet les **agrégats** d'e-reporting |
| `testConnection` | vérifie les identifiants avant le coffre |

`HttpPdpClient` implémente une forme REST raisonnable ; l'adaptateur d'un
opérateur donné ajuste le format de fil. Ce qui ne bouge pas, c'est le
contrat. Même patron que `getBankClient()` (2.15) pour les banques.

L'URL de base est configurable (`PDP_BASE_URL`) et le placeholder
`https://api.pdp.example` est **refusé en production** : émettre une facture
vers un TLD réservé serait une panne silencieuse aux conséquences légales.

## Cycle de vie — vocabulaire normatif, transitions gardées

`packages/facturx/src/lifecycle.ts` (`LIFECYCLE_RULES_VERSION`) porte les dix
statuts du cycle de vie, en config versionnée datée sourcée (doctrine 2.19 /
3.7 / 3.9). Le vocabulaire est **partagé** par l'émetteur, la plateforme, le
destinataire et l'administration : en inventer un casserait le rapprochement.

```
prete → deposee → recue → prise_en_charge → approuvee ┐
                                          → refusee   ├→ encaissee
                                          → rejetee   ┘
erreur (transport, jamais un verdict) → deposee
```

`isValidTransition` n'autorise que l'avance. Trois refus qui comptent :

- **jamais en arrière** — un webhook rejoué ou livré dans le désordre ne
  réécrit pas l'histoire (`encaissee → deposee` est refusé) ;
- **jamais sur place** — un doublon n'est pas une transition ;
- **`erreur` n'est pas un rejet** — `isRejection()` distingue le refus du
  client (`refusee`) et le rejet de la plateforme (`rejetee`) d'une panne de
  transport. Confondre les trois ferait relancer un client qui n'a rien fait.

Les sauts en avant sont tolérés (`deposee → approuvee`) : une plateforme n'est
pas tenue de notifier chaque étape, et attendre une étape manquante bloquerait
le suivi.

`normalizeStatus` accepte les variantes usuelles (`approved`, `Déposée`,
`prise en charge`) et renvoie **`null` sur un statut inconnu** — jamais une
supposition. Un statut inventé afficherait « approuvée » sur une facture qui
ne l'est pas.

## Retour de statut — par le socle webhooks, jamais autrement

Le handler `pdp` (`apps/api/src/einvoice.ts`) est enregistré **par défaut** :
sans lui, la plateforme notifierait dans le vide et 2.13 ne collecterait même
pas le corps (le payload n'est stocké que si un handler existe — minimisation).

Ce que le handler garantit :

- le **tenant vient de l'endpoint** qui a authentifié la livraison, jamais du
  corps reçu (`withWebhookResolver`, 2.13). Une référence appartenant à un
  autre tenant ne correspond donc à rien — testé ;
- une soumission inconnue n'est **jamais créée** depuis un message entrant :
  la ligne naît du dépôt validé, point ;
- l'historique est **append-only et borné** (`MAX_STATUS_HISTORY = 50`) : une
  plateforme bavarde ne fait pas grossir une ligne sans fin ;
- rien n'est logué du payload : un événement de statut porte un numéro de
  facture, qui est une donnée d'entreprise.

## E-reporting — des totaux, jamais des noms

L'e-invoicing transmet la facture (B2B domestique). L'e-reporting transmet des
**agrégats** pour le reste : B2C, clients étrangers, opérations hors champ.
Cette asymétrie est l'intérêt du dispositif, et elle est tenue structurellement :
`reportTransactions` n'a pas de champ où mettre un nom.

`aggregateEReporting` (`packages/facturx/src/ereporting.ts`) est un modèle
**pur** qui lit le facturier (Pennylane / démo / FEC — même source que 3.1 et
3.4) sur une période. Il compte ce qu'il **n'a pas pu** utiliser au lieu de
rétrécir le total en silence : hors période, devise étrangère (exclue, jamais
convertie à un taux inventé), ligne sans date ou sans montant.

Deux choses qu'il **refuse** de faire :

- **répartir B2B / B2C** : le facturier ne porte pas le SIREN du client, la
  répartition n'est pas dérivable. La deviner ferait mal déclarer ;
- **dériver la TVA** : le montant du facturier est un chiffre unique dont la
  nature HT/TTC n'est pas garantie selon la source. `vatDerivable: false`, et
  le montant de TVA est **saisi** par l'owner avant transmission.

L'aperçu (`GET /factures/ereporting/apercu`) est un pré-remplissage — pas une
déclaration. Le facturier étant lu par page, un agrégat partiel se signale
(`truncated`) plutôt que de se présenter comme complet.

## Registre `einvoice_submissions`

| Colonne | Rôle |
|---|---|
| `invoiceNumber` | numéro de facture, ou `début..fin` pour l'e-reporting |
| `direction` | `emission` \| `ereporting` (CHECK) |
| `status` | un des dix statuts du cycle de vie (CHECK) |
| `pdpReference` | identifiant du dépôt chez la plateforme |
| `documentHash` | SHA-256 du PDF déposé — **preuve d'intégrité** |
| `statusHistory` | historique horodaté borné |
| `lastError` | **nom** d'erreur seulement |

RLS + test d'isolation comme toute table métier. La table ne stocke **ni le
PDF ni le XML** : un hash prouve ce qui est parti sans conserver une seconde
copie de la facture (art. 5.1.c). `@@unique(tenantId, invoiceNumber, direction)`
porte l'idempotence : re-valider une proposition ne dépose jamais deux fois, et
la route refuse (409) avant même la file.

## Surface HTTP

| Route | Rôle | Accès |
|---|---|---|
| `POST /factures/soumettre` | audite puis met en file un dépôt | owner |
| `GET /factures/soumissions` | suivi (métadonnées seules) | owner |
| `GET /factures/ereporting/apercu` | pré-remplissage depuis le facturier | owner |
| `POST /factures/ereporting` | met en file la transmission d'agrégats | owner |
| `POST /webhooks/pdp/:id` | statuts entrants (signés HMAC) | public signé |

Owner-only de bout en bout : numéros, montants et statuts de factures sont de
la donnée d'entreprise. Réponses en `cache-control: private, no-store`.

## Limites assumées (V1)

- **Réception B2B**, moitié obligatoire au 01/09/2026, s'appuie sur
  `extractFacturXXml` (2.3) ; le rapprochement automatique d'une facture reçue
  avec une commande reste à faire.
- **Annulation / avoir** : un avoir est une facture (type UNTDID 381) et suit
  le même chemin ; il n'y a pas de « retrait » d'un dépôt — il n'y en a pas
  dans la réforme non plus.
- **Repli `getStatus`** : le contrat existe, le balayage périodique qui
  rattrape un webhook manqué attend Redis/BullMQ (comme le sweep push 2.17).
- **Annuaire destinataire** : le routage vers la plateforme du client se fait
  côté PDP en V1 ; l'annuaire n'est pas interrogé par le produit.
