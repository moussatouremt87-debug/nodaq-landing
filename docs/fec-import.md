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
