# Prévision des ventes (ticket 3.1)

Chiffre d'affaires mensuel observé sur les **factures clients** (12 derniers
mois, mois courant exclu car incomplet), projeté sur 3 mois par **régression
linéaire explicable** — même philosophie que la prévision de trésorerie : un
modèle déterministe, auditable, avant les modèles ML du service dédié (V2).

## Sources de données

L'interface Pennylane existante alimente le modèle, donc il fonctionne
partout : connecteur Pennylane réel, fixtures du tenant démo (12 mois
d'historique saisonnier), ou **factures dérivées d'un import FEC** (repli
registre) — aucune configuration supplémentaire.

## Modèle (`mcp-servers/actions/src/salesForecast.ts`, pur)

- `buildMonthlySeries` : somme des factures par mois (brouillons/annulées et
  montants non positifs exclus), trous à 0 — un mois sans facture est un
  signal, sauf en tête de série (avant le début d'activité).
- `forecastSales` : ≥ 3 mois actifs → régression moindres carrés, clampée à
  0 (jamais de CA négatif) ; 1-2 mois → moyenne simple (une « tendance » sur
  2 points serait du bruit) ; rien → zéros signalés `aucune-donnee`.
- Sorties : série, points de prévision, `trendCentsPerMonth`, `method` — tout
  est affichable et explicable à l'utilisateur.

## Accès (owner only)

Le CA agrégé est une donnée financière globale du tenant : même règle
tiers-délégué que la trésorerie.

- **Outil agent** `forecast_sales` (lecture seule) — dans `OWNER_ONLY_TOOLS`,
  invisible pour un membre ou un expert-comptable.
- **Cockpit** : la carte « Prévision des ventes » (barres 12 mois + prévision)
  n'apparaît que pour l'owner (`/cockpit/kpis.sales`, null sinon), dégradée
  indépendamment de la trésorerie.

## À ne pas faire

- Exposer la série ou la prévision à un rôle non-owner (outil OU cockpit).
- Ajouter un modèle non explicable ici : les modèles avancés iront dans le
  service ML dédié, avec leurs évals.
