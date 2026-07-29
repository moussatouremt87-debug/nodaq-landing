# Immobilisations & amortissements (ticket 2.19)

Registre parallèle **à visée trésorerie/décision** : on calcule, on n'écrit
**jamais** dans la comptabilité (pas d'écritures 68x/28x, pas d'export). LE
point de conception : **un amortissement ne décaisse rien** — ce qui touche la
trésorerie, c'est l'effet IS estimé et le renouvellement CAPEX.

## Règles fiscales = données versionnées

`packages/shared/src/frenchTax.ts`, **daté (2026-07-29) et sourcé** (CGI 219,
1668, 39 A ; BOFiP) : IS 25 % / 15 % ≤ 42 500 € (conditions PME), acomptes
15/03-15/06-15/09-15/12 (dispense < 3 000 €), coefficients dégressif
1,25/1,75/2,25, durées d'usage par catégorie, seuil charge/immobilisation
500 € HT. Note de veille : PLF 2026 (plafond 100 000 €) NON applicable à la
date de vérification. Un taux qui change = une donnée à éditer, pas un moteur
à recoder.

## Moteur (`packages/shared/src/depreciation.ts`, pur, zéro LLM)

Centimes entiers, exercice civil (V1 assumée) :
- **Linéaire** : prorata au JOUR de mise en service, convention 360 j (cas
  bissextile testé), dernière annuité en solde exact.
- **Dégressif** : départ au 1er du mois, taux = linéaire × coefficient CGI
  39 A, **bascule linéaire gelée** (VNC/années restantes) dès qu'elle devient
  plus favorable — plan de référence vérifié à la main dans les tests.
- **Cession** : exercice de cession proratisé, plan tronqué.
- VNC et % d'usure à toute fin d'exercice (convention d'affichage : fin
  d'exercice COURANT).

## Les 3 sources du registre (`fixed_assets`, RLS + preuve)

1. **FEC (2x/28x)** : à l'import, `deriveFixedAssets` reconstitue brut +
   amortissements rattachés (catégorie devinée du compte PCG, incohérences
   **signalées** — 28x > 2x, 28x manquant) → **propositions dans la file de
   validation existante** (`pending_action` type `create_fixed_asset`) —
   jamais d'insertion silencieuse ; idempotent par `sourceRef` (re-import et
   re-validation sans doublon).
2. **Classeur photo** : facture fournisseur ≥ 500 € HT → suggestion
   « immobiliser ? » (catégorie/durée proposées, à ajuster) dans la même
   file. JAMAIS automatique : frontière charge/immo = décision de gestion.
3. **Saisie manuelle** : formulaire owner (`POST /immobilisations`) — la
   saisie EST la décision humaine.

L'exécuteur `create_fixed_asset` (réel) ne tourne qu'après approbation.

## Impact trésorerie (`packages/shared/src/capex.ts`)

- **Garde « dotation ≠ décaissement » testée** : la projection de trésorerie
  du cockpit est INCHANGÉE par le registre ; seule sort une **économie d'IS
  estimée** (dotations × taux marginal — estimation simplifiée V1, le
  bénéfice réel n'est pas connu) datée sur le calendrier des acomptes,
  **toujours labellisée « estimation — à valider avec votre
  expert-comptable »**, et strictement inférieure aux dotations.
- **Mur de renouvellement 24 mois** : chaque actif pose un CAPEX prévisionnel
  (montant = base historique, **éditable** `renewalCostCents`) au trimestre
  de fin de plan — **scénario**, jamais imposé à la projection.
- **Alerte fin de vie** : ≥ 80 % amorti → alerte owner via le check horaire
  push (2.17), payload minimal — jamais le nom de l'asset.

## Limites V1 assumées (audit 2.19)

- Idempotence FEC par **compte** (`fec:<compteNum>`) : un compte déjà repris
  ne re-propose pas ses achats ultérieurs (re-saisie manuelle) ; un rejet
  n'est pas mémorisé (la proposition revient à l'import suivant).
- VNC affichée = recalcul du plan **plafonné par la reprise 28x** (jamais
  moins amorti que les livres) — peut différer du bilan pour les cas
  atypiques : l'expert-comptable reste la référence.
- Suggestion classeur : uniquement quand le HT est lisible (jamais de TTC
  amorti) ; ajustement catégorie/durée = rejeter puis saisie manuelle.

## Accès

Tout `/immobilisations` est **OWNER-ONLY** (patrimoine + valeurs
financières) ; page web registre (VNC, barres d'usure, plan par exercice,
mur 24 mois, effet IS labellisé, saisie manuelle, cession).

## À ne pas faire

- Afficher une dotation comme une sortie d'argent (le test-garde existe).
- Générer une écriture comptable ou présenter l'IS estimé comme un montant dû.
- Immobiliser automatiquement sur un seuil — on suggère, l'humain tranche.
- Coder un taux fiscal en dur dans le moteur.
