# Import FEC — le connecteur fichier universel (ticket 2.14)

Le FEC (Fichier des Écritures Comptables, art. A47 A-1 du LPF) est le format
que **tout logiciel de comptabilité français doit savoir exporter**. L'importer
dans nodaq peuple le cockpit et l'employé Compta avec les **vraies créances**
d'une entreprise — sans connecteur, sans OAuth : un cabinet exporte le FEC d'un
dossier en 2 minutes, nodaq montre ses impayés dans la foulée.

## Utilisation

/connecteurs → carte **« Import FEC »** → choisir le fichier (`.txt`, tabulation
ou « | », 50 Mo max). Réservé au rôle **owner**. Le rapport affiche : écritures
analysées, clients, factures, impayés (nombre + montant), avertissements.

- **Idempotent** : ré-importer le même fichier (même empreinte SHA-256) ne
  change rien et le signale.
- **Remplacement** : un fichier différent remplace intégralement l'import
  précédent (les factures dérivées sont re-calculées de zéro).
- **Rejet franc** : un FEC invalide (en-tête non conforme, dates/montants
  malformés, déséquilibre débit/crédit) est refusé en bloc avec un rapport
  ligne à ligne — jamais d'ingestion partielle.

## Ce qui est dérivé (`packages/fec`)

- Comptes clients **411** + compte auxiliaire → clients.
- Débits 411 groupés par **PieceRef** → factures (les crédits de la même pièce
  = règlements partiels).
- **Lettrage** (`EcritureLet`) → facture soldée. Non lettrée + **échéance
  estimée** (date de pièce + 30 j — le FEC ne contient pas l'échéance réelle)
  strictement dépassée → **impayé**.
- Les factures dérivées sont servies à l'employé Compta et au cockpit via
  l'interface Pennylane existante (repli automatique du registre quand aucun
  Pennylane n'est connecté) : relances, scoring et validation fonctionnent
  sans modification.

## Confidentialité (données `confidentiel` par nature)

- Le fichier est parsé **en mémoire** ; **le brut n'est pas conservé** (V1,
  minimisation) — seule son empreinte SHA-256 sert l'idempotence.
  L'archivage Object Storage fr-par viendra avec l'infra bucket dédiée.
- **Aucune ligne du journal** n'apparaît dans les logs, les erreurs ou les
  réponses API — uniquement des compteurs, des numéros de ligne et des
  messages génériques.
- Tables `fec_imports`/`fec_invoices` : `tenantId` + RLS + tests d'isolation.
- Le badge connecteur affiche « importé » (statut `file`) — jamais
  « connecté » : rien n'est branché.
- **Conservation / effacement (art. 17)** : les données dérivées vivent
  jusqu'au prochain import (remplacement intégral) ou jusqu'à suppression
  explicite — bouton « Supprimer les données importées » de la carte
  (`DELETE /connectors/fec`, owner), qui purge imports, factures dérivées et
  connecteur fichier.

## À ne pas faire

- Générer un FEC (jamais notre rôle) ou l'utiliser comme import comptable
  complet : seule la dérivation créances clients est couverte (V1).
- Poser le statut connecteur `file` ailleurs que via l'endpoint d'import.

## Retenue de garantie — jamais un impayé (US-8, ticket 2.20)

Dans le bâtiment, le client retient contractuellement 5 % du marché jusqu'à la
levée des réserves, souvent un an après la réception. **Ce n'est pas un
impayé** : c'est une somme non encore exigible, prévue au contrat.

Comptablement, la retenue vit au **4117 « Clients — Retenues de garantie »**.
Or `4117` est une **subdivision de `411`** — et la dérivation des créances
filtrait sur le préfixe `411`. La retenue était donc :

1. agrégée à la facture, ce qui **gonflait le montant facturé** de 5 % ;
2. non lettrée jusqu'à la libération, ce qui laissait la facture **ouverte** ;
3. comptée dans `overdueCents`, donc **candidate à une relance**.

Relancer un bon client sur sa retenue de garantie est la faute qui coûte le
plus cher en crédibilité devant un artisan : elle prouve en une phrase que
l'outil ne connaît pas son métier.

### Ce qui a changé

`classifyReceivableAccount` (config versionnée datée sourcée PCG,
`packages/shared/src/receivableAccounts.ts`) sépare désormais trois natures :
`retenue` (4117), `client` (411), `hors_clients`. Le préfixe le plus long
l'emporte — sinon la retenue redevient une créance ordinaire.

| Grandeur | Contenu |
|---|---|
| `amountCents` | débits 411 de la pièce — la retenue y est **carvée** par le transfert, pas ajoutée (l'additionner comptait les 5 % deux fois) |
| `residualCents` | part **exigible** restant due, retenue **exclue** |
| `retainedCents` | la retenue elle-même — conservée, jamais effacée |
| `settled` | jugé sur les seules lignes **exigibles** : la retenue, non lettrée par nature, ne peut plus à elle seule faire passer une facture réglée pour ouverte |

`overdueCents` et `overdueCount` excluent la retenue, donc le statut renvoyé
par l'interface facturier est `paid` — et c'est ce statut qui décide d'une
proposition de relance.

### Ce que le produit ne prétend pas savoir

La **date de libération** est contractuelle : elle n'existe nulle part dans un
FEC. Le produit ne l'invente pas (`releaseDateKnown: false`) ; la saisir est un
ticket à part. Une retenue est donc affichée pour son montant et son nombre,
sans échéance — dire « libérable le … » sans le savoir serait exactement le
genre d'affirmation que le reste du produit s'interdit.

Une retenue **négative** est refusée en base (CHECK) : elle signalerait une
libération sur-comptabilisée, qui doit être vue et non absorbée en silence.
