# Plannings RH & prévision des besoins (ticket 3.5)

Capacité mensuelle de l'équipe vs **charge estimée** — le vrai « prévoir les
besoins » d'une PME de terrain : « en septembre, il te manque ~200 h ». Modèle
pur, déterministe, explicable (`mcp-servers/actions/src/staffingPlan.ts`) —
le solveur d'optimisation et les connecteurs RH (Silae) viendront après
(blueprint V2+).

## Modèle

- **Capacité** = Σ heures hebdo contractuelles des actifs × 4,348 semaines/mois,
  **absences déduites** (jours calendaires × 5/7 jours ouvrés × heures/jour).
- **Charge estimée** = CA prévu du mois (prévision de ventes 3.1 : réel
  Pennylane / démo / FEC) ÷ **taux horaire facturé moyen configurable**
  (défaut 60 €/h, visible dans chaque justification — jamais un chiffre caché).
- **Verdicts chiffrés** : `sous-capacite` / `sur-capacite` (au-delà de ±10 %
  de tolérance) / `equilibre` / `inconnu` (pas de prévision → **jamais une
  charge fabriquée**). Sortie TOUJOURS labellisée
  « estimation — charge dérivée de la prévision de ventes ».

## Données & accès

Tables `staff_members` (nom = PII, rôle, heures hebdo, actif — unicité par
tenant) et `staff_absences` (période, type) : RLS + FORCE + tests d'isolation
avec preuve. **Owner-only de bout en bout** (routes `/rh/*` en
`requireRole(["owner"])`, page web dégradée sur 403, outil dans
`OWNER_ONLY_TOOLS`) : noms de salariés = PII RH, charge dérivée du CA =
donnée financière. Jamais un nom de salarié dans les logs.

## Consommateurs

- **Outil agent `plan_staffing`** (lecture seule) — l'employé Compta répond
  « prévois un renfort en septembre » chiffres à l'appui.
- **Route `GET /rh/plan`** : passe par le MÊME outil du toolset lié au tenant
  (une implémentation, deux consommateurs, gate owner unique).
- **Page `/rh`** : équipe (ajout/désactivation), absences, tableau capacité
  vs charge avec taux horaire éditable.

## Limites V1 assumées

- Charge estimée globale (pas par compétence/chantier) ; absences en
  approximation 5/7 ; pas d'optimisation d'affectation (solveur V2+).
- Le taux horaire est une hypothèse de l'utilisateur — le label estimation
  ne disparaît jamais.
