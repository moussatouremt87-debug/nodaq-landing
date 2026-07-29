# Prix matières premières + simulation de scénarios (ticket 3.3)

« Et si le cuivre prend 10 % ? » — le stock (3.2) valorisé aux **coûts de
remplacement** et revalorisé sous un scénario de prix, en chiffres
explicables. Aucune donnée externe en V1 : les prix sont ceux du tenant.

## Modèle (`mcp-servers/actions/src/materialScenario.ts`, pur)

- Chaque article porte un **coût de remplacement** (`unitCostCents`,
  saisi par l'owner sur la page Stocks — 0 = non renseigné, visible comme
  tel, jamais confondu avec « sans valeur »).
- `simulateMaterialPrices(items, scénario)` : variation **globale** et/ou
  **ciblée par article** (l'override gagne), bornée **−90 %…+500 %** (une
  faute de frappe ne produit pas d'absurdité) ; sortie = lignes détaillées
  (coût actuel/nouveau, valeur actuelle/nouvelle, delta) + totaux + noms de
  scénario **non appariés signalés** (jamais silencieux).

## Accès (owner only — donnée financière)

- Les **coûts et la valorisation** ne sortent de l'API que pour l'owner
  (`GET /stocks` : champs absents pour un membre, écriture owner). Un membre
  voit les quantités et les alertes, jamais les coûts.
- **Outil agent** `simulate_material_prices` (lecture seule) — dans
  `OWNER_ONLY_TOOLS`, comme la trésorerie et le CA.
- **Page Stocks** (owner) : carte « Valorisation du stock » — valeur de
  remplacement actuelle + simulateur global en %, même formule que l'outil.

## Suivis (hors V1, documentés)

- **Historique de prix** (courbe par matière) et **sources externes de
  cours** (LME cuivre, indices BTP) via un connecteur dédié — les prix V1
  sont déclaratifs.
- Répercussion sur les **devis** (marges cibles) quand le module devis
  portera des lignes matières.

## À ne pas faire

- Exposer un coût ou une valorisation à un rôle non-owner (API, outil, UI).
- Élargir les bornes de variation sans garde-fou.
