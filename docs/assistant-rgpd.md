# Assistant RGPD (ticket 3.9)

Le registre des activités de traitement (RGPD art. 30) tenu dans NODAQ, avec
des modèles PME prêts à l'emploi et un audit de complétude — **information
générale, jamais un conseil juridique ni un DPO** : le label est permanent,
dans l'outil comme dans l'UI.

## Modèles = config versionnée datée sourcée (doctrine 2.19/3.7)

`packages/shared/src/rgpdRegister.ts` — `RGPD_REGISTER_VERSION` exposée dans
chaque sortie ; 8 traitements types du **registre simplifié CNIL** (paie,
facturation clients, prospection, relation clients, fournisseurs,
recrutement, vidéosurveillance, site web), chacun avec finalité, base légale
(art. 6), catégories de données, personnes concernées, destinataires et
**durée de conservation sourcée** (L3243-4, L123-22, référentiels CNIL…).
Chaque modèle porte son URL CNIL — même méthode de vérification manuelle au
bump de version que la veille réglementaire (3.7).

## Moteur pur d'audit

`auditRgpdRegister(activities)` — déterministe, zéro I/O, zéro LLM :

- `registre_vide` (alerte) : le registre est exigible en contrôle CNIL.
- `duree_manquante` (alerte) : champ obligatoire du registre.
- `base_invalide` (alerte) : base hors des six bases de l'art. 6.
- `base_inadaptee` (alerte) : données sensibles (art. 9) sur « intérêt
  légitime » — l'interdiction de principe exige une exception art. 9 §2.
- `donnees_sensibles` (attention) : rappel des conditions renforcées.
- `incoherence_sensible` (attention) : catégorie « santé » sans le drapeau.

Chaque signalement est justifié en français ; le moteur n'invente jamais une
obligation au-delà des textes cités.

## Table `processing_activities` (RLS)

Une ligne par traitement : finalité, base légale (CHECK en base, synchro
TS↔SQL figée par test), catégories de données (enum fermée `DATA_CATEGORIES`
— « Santé » ne peut pas contourner la règle d'audit sur `sante`), personnes,
destinataires, conservation, drapeau sensible, `sourceTemplate` (traçabilité
du modèle CNIL). Unicité `(tenantId, name)` — doublon = 409 en création
COMME en renommage. Policy `tenant_isolation` + test d'isolation avec preuve
+ assertion RLS activée/forcée. **La table décrit des traitements, pas des
personnes** : par convention, ses champs libres (nom, finalité,
destinataires) ne doivent pas recevoir de données personnelles.

## Outil, routes, UI — OWNER-ONLY

Le registre est un document de conformité stratégique : owner-only partout.

- Outil `check_rgpd_register` (lecture seule, sans entrée) — dans
  `OWNER_ONLY_TOOLS` (fail-closed, test paramétré) ; borne 500 signalée.
- Routes : `GET /rgpd` (registre + audit via le MÊME outil que l'agent +
  modèles), `POST /rgpd` (Zod strict, doublon = 409), `POST
  /rgpd/modele/:id` (ajout 1-clic), `PATCH|DELETE /rgpd/:id`.
- Page **Assistant RGPD** : audit en tête (alertes rouges), registre,
  modèles CNIL avec sources cliquables et état « déjà ajouté ».

## Limites V1 (assumées)

- **Champs art. 30 §1 non portés** : transferts hors UE, description des
  mesures de sécurité, identité/coordonnées du responsable de traitement.
  L'audit ne les vérifie pas et l'UI le DIT (« champs couverts par
  l'audit ») — complétion = ticket futur.
- Registre art. 30 uniquement : pas d'AIPD, pas de gestion des demandes
  d'exercice de droits, pas de notification de violation (tickets futurs).
- La saisie libre et la correction d'un traitement passent par l'API
  (`POST/PATCH /rgpd`) — l'UI V1 n'expose que les modèles CNIL et la
  suppression (confirmée).
- Q&A RGPD dans le chat via RAG sur corpus CNIL = V2 (`services/rag`).
- Pas d'export PDF du registre (impression navigateur en attendant).
