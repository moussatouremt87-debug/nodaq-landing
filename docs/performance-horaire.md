# Performance horaire (ticket 3.6)

Le pendant **rétrospectif** des plannings RH (3.5) : au lieu de projeter la charge
future, on mesure ce que chaque heure travaillée a **réellement rapporté** sur les
mois écoulés — CA observé ÷ heures travaillées estimées — et on le compare à
l'objectif de taux horaire facturé.

## Modèle (pur, explicable)

`mcp-servers/actions/src/hourlyPerformance.ts` — aucune I/O, mêmes conventions
que 3.5 :

- **Heures travaillées estimées** par mois = Σ heures hebdo contractuelles des
  actifs × 4,348 − absences enregistrées (converties en jours ouvrés 5/7).
  **V1 n'a pas de pointage** : les heures viennent des contrats actuels, le
  rapport est donc labellisé en permanence
  « estimation — heures dérivées des contrats actuels (pas d'un pointage) ».
- **CA observé** par mois = série mensuelle des factures clients (conventions
  3.1 : mois courant exclu, mois vides de tête ignorés — avant l'activité —,
  un zéro APRÈS le démarrage est un signal réel).
- **Taux réalisé** = CA ÷ heures (¢/h). Verdicts vs objectif configurable
  (60 €/h par défaut, tolérance ±10 %) : `au-dessus | conforme | en-dessous |
  inconnu` (équipe vide = jamais une division par zéro). Chaque verdict porte
  sa justification chiffrée.
- **Synthèse** : moyenne pondérée (Σ CA ÷ Σ heures) et tendance (moindres
  carrés sur ≥ 3 mois, ¢/h par mois).

## Outil agent — `analyze_hourly_performance` (OWNER-ONLY)

CA réalisé + données RH agrégées = mêmes restrictions que `plan_staffing` :
l'outil n'existe pas dans le toolset d'un non-owner (fail-closed, test
paramétré). Lecture seule (`requiresValidation: false`), bornes de lecture
signalées (501/5001 → `truncated`), le **nom des salariés (PII) n'est jamais
sélectionné**. Facturier absent ou en erreur → `revenueUnavailable: true` et
**aucun mois calculé** — jamais un taux fabriqué sur un CA inconnu.

Paramètres : `targetRateEur` (10–500, défaut 60), `monthsBack` (3–12, défaut 6).

## Route & UI

- `GET /rh/performance` (owner-only, chaîne d'autorisation complète) — même
  chemin que l'agent : la route exécute l'outil du toolset lié au tenant, une
  seule implémentation.
- Page **Équipe & plannings** : carte « Performance horaire réalisée »
  (mois, heures estimées, CA, €/h réalisé, verdict — justification au survol),
  moyenne pondérée + tendance, label estimation permanent. Le réglage du taux
  horaire est **partagé** avec le plan de charge : un seul objectif cohérent.

## Limites V1 (assumées)

- Pas de pointage ni de connecteur temps : heures **estimées** depuis les
  contrats actuels — un changement d'effectif récent fausse les mois anciens
  (le label le dit).
- EUR uniquement, factures `draft/cancelled/estimate` exclues (conventions 3.1).
- Pas de ventilation par salarié ou par chantier (V2, avec pointage réel).
