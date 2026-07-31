# Modules activables par vertical (ticket 3.11)

Chaque tenant active les modules qui correspondent à son métier : les défauts
suivent le **vertical** du profil d'entreprise (3.7), le dirigeant peut tout
surcharger. Ferme la phase V2 du blueprint (« Modules activables par
vertical »).

## Catalogue = config versionnée (doctrine 2.19)

`packages/shared/src/moduleCatalog.ts` — `MODULE_CATALOG_VERSION` datée ;
7 modules : classeur, stocks & prix matières, immobilisations, équipe &
plannings, veille réglementaire, avis clients, assistant RGPD. Chaque module
porte sa page (`href`) et **ses outils agent** (`tools`). Défauts : tout est
actif partout, SAUF stocks pour le vertical `services` (réactivable en un
clic) ; `autre` = tout actif (découverte, fail-open).

Le **cœur n'est pas un module** : cockpit, chat, file de validation,
connecteurs, notifications et les outils compta (trésorerie, prévision,
relances, OCR…) ne sont jamais désactivables.

## Moteur pur `resolveModules`

État effectif = défaut du vertical, surchargé par les choix explicites de
l'owner — chaque état porte sa **source** (`defaut_vertical` | `choix`),
jamais un module qui disparaît sans explication. Surcharges inconnues ou non
booléennes ignorées.

## Effet réel d'une désactivation

1. **Navigation** : la page du module sort du menu (shell, filtrage par
   préfixe d'URL, fail-open en cas d'erreur réseau — la visibilité est du
   confort produit).
2. **Agent** : les outils du module sortent du toolset (`buildToolset` lit le
   profil et filtre — même mécanique fail-closed que le gate owner : absent
   du routage ⇒ `unknown tool`). Sans profil : tout actif (un profil manquant
   n'ampute jamais l'employé virtuel). En revanche une **erreur DB** dans
   cette lecture fait échouer la construction du toolset entier — fail-closed
   global assumé, comme le reste de la chaîne.
3. **Routes API** : les autorisations ne changent JAMAIS (pas une frontière
   de sécurité), mais l'effet varie selon l'implémentation — les routes
   adossées à un outil du toolset (`/rh/plan`, `/rh/performance`,
   `/reglementaire`, `/avis/reputation`, `/avis/:id/reponse`) répondent
   **409 « module désactivé »** explicite ; `GET /rgpd` dégrade son audit à
   `null` ; les routes CRUD directes (équipe, avis, registre…) restent
   pleinement fonctionnelles. La cohérence outil↔catalogue est figée par un
   test (tout nom orphelin fait échouer la CI).

**Aucune donnée n'est supprimée** — réactiver un module retrouve tout. Le
vertical et la source des états sont OWNER-ONLY dans `GET /modules` (donnée
stratégique 3.7) : les membres ne reçoivent que `{id, titre, href, actif}`.

## Stockage, routes, UI

- `tenant_profiles.module_overrides` (JSONB, map moduleId → bool) —
  1 ligne/tenant déjà sous RLS ; l'upsert de bascule assainit la map (modules
  connus, booléens purs) et ne touche pas au reste du profil.
- `GET /modules` (tous les membres — la nav en dépend ; les listes d'outils
  internes ne traversent pas la frontière HTTP) ; `PUT /modules/:id` (owner,
  Zod strict, module inconnu = 404).
- Page **Réglages → Modules** : bascules avec source affichée (« votre
  choix » / « défaut du vertical ») + rappel qu'aucune donnée n'est
  supprimée.

## Limites V1 (assumées)

- Granularité module, pas outil : on ne désactive pas un outil isolément.
- Les cartes cockpit ne sont pas encore filtrées par module (nav + outils
  seulement) — ticket futur si besoin.
