# Veille réglementaire sectorielle (ticket 3.7)

Les obligations françaises applicables à l'entreprise (échéances, seuils
d'effectif, spécificités sectorielles), présentées par urgence, chaque
inclusion justifiée et sourcée. **Information générale — jamais un conseil
juridique** : le label est permanent, dans l'outil comme dans l'UI.

## Catalogue = config versionnée datée sourcée (doctrine 2.19)

`packages/shared/src/regulatoryWatch.ts` — même statut que `frenchTax.ts` :

- `REGULATORY_WATCH_VERSION` (date de la photo du droit) exposée dans chaque
  sortie ; **chaque entrée porte sa source** (texte légal + URL Légifrance/CNIL).
- ~12 obligations PME : facturation électronique (réception 01/09/2026,
  émission PME 01/09/2027), registre RGPD, DUERP, CSE (11), OETH (20), index
  égalité (50, récurrent 1er mars), règlement intérieur (50), tri biodéchets
  (AGEC), décennale (BTP), affichage des prix (retail/négoce), médiation de la
  consommation (retail/services).
- **Aucun flux externe en V1** : pas de scraping présenté comme du droit — la
  mise à jour passe par ce fichier, versionnée et sourcée. Flux
  Légifrance/JO + résumés `route()` = ticket futur.
- **Méthode de vérification des sources** : à chaque bump de
  `REGULATORY_WATCH_VERSION`, ouvrir manuellement CHAQUE URL et vérifier que
  l'article cité correspond bien à l'obligation décrite (les identifiants
  `LEGIARTI…` sont opaques : un id erroné pointerait ailleurs sans erreur).
  Les URLs `/codes/article_lc/` ciblent la version consolidée courante.
  Dernière vérification : 2026-07-30 (création du catalogue).

## Moteur pur d'applicabilité

`matchRegulatoryItems(profile, now)` — déterministe, zéro I/O, zéro LLM :

- Profil = vertical métier (`industrie_btp|retail|negoce|services|autre`)
  + effectif. **Effectif inconnu ≠ 0** : les obligations à seuil restent
  visibles en `peut_etre` (« applicabilité à confirmer »), jamais tues.
- Sous le seuil (effectif connu) : réellement non applicable, exclue.
- Statuts : `echeance_proche` (≤ 90 j), `a_venir`, `en_vigueur` ; échéances
  fixes (facturation électronique) et récurrentes (prochaine occurrence du
  1er mars). Tri par urgence.
- Chaque inclusion a sa `reason` chiffrée (« effectif 25 ≥ seuil de 20 »).

## Profil tenant — `tenant_profiles` (RLS)

Une ligne par tenant : `vertical` (CHECK en base) + `headcountOverride`
(CHECK 0..10000). Effectif effectif = déclaré, sinon dérivé du nombre
d'actifs de l'équipe (3.5), sinon inconnu. Policy `tenant_isolation` + test
d'isolation avec preuve (policy retirée → fuite détectée).

## Outil, routes, UI — OWNER-ONLY

Le profil (vertical + effectif RH) est une donnée stratégique : owner-only
partout.

- Outil `check_regulatory_watch` (lecture seule, `requiresValidation: false`,
  sans entrée) — dans `OWNER_ONLY_TOOLS` (fail-closed, test paramétré).
- Routes : `GET /reglementaire` (même chemin que l'agent : outil du toolset),
  `GET|PUT /reglementaire/profil` (Zod strict, vertical inconnu = 400).
- Page **Veille réglementaire** : formulaire profil + liste par urgence
  (échéance proche en rouge avec compte à rebours, sources cliquables,
  raison au survol), label permanent + version du catalogue.

## Limites V1 (assumées)

- Photo du droit à la date du catalogue — pas de flux temps réel ; le bump de
  version est manuel et doit citer ses sources.
- Applicabilité par vertical + effectif uniquement (pas de CA, forme
  juridique, convention collective).
- Pas de notification push sur échéance proche (branchement au sweep 2.17 =
  ticket futur).
