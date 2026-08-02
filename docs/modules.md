# Modules — la frontière du produit (ticket 3.11, pivot ADR-007)

Chaque tenant active les modules qui correspondent à son métier. Depuis le
**pivot du 2026-08-02** ([ADR-007](adr/ADR-007-pivot-assistant-operationnel.md)),
ce registre porte aussi la **frontière du produit** : c'est lui — et lui seul —
qui éteint les modules de l'ancienne direction, sans supprimer une ligne de code.

## Catalogue = config versionnée (doctrine 2.19)

`packages/shared/src/moduleCatalog.ts` — `MODULE_CATALOG_VERSION` datée. Chaque
module porte son titre, sa description, sa page (`href`, **optionnelle** : un
module peut n'avoir que des outils d'agent ou une carte cockpit) et **ses outils
agent** (`tools`).

`defaultOn` prend trois formes :

| Valeur | Sens |
|---|---|
| `"tous"` | **socle** — actif partout |
| `"aucun"` | **hors socle** — éteint partout, réactivable en un clic |
| liste de verticaux | défaut par vertical |

**Socle** : `classeur`, `rh`.
**Hors socle** (pivot) : `stocks`, `immobilisations`, `reglementaire`, `avis`,
`rgpd`, `facturation_electronique`, `prevision_ventes`, `signaux_clients`,
`silae`.

Le **cœur n'est pas un module** : cockpit, chat, file de validation,
connecteurs, notifications et les outils compta (trésorerie, relances, OCR…)
ne sont jamais désactivables.

### Éteint n'est pas supprimé

Un module hors socle garde **tout son code, ses données et ses tests**. Seuls la
navigation et le toolset de l'agent le perdent — et, par conséquence, les
routes adossées à un outil du toolset répondent alors **409 « module
désactivé »** (voir §3 : `/reglementaire`, `/avis/*`, `/rh/*`). Rallumer le
module les fait répondre à nouveau, à l'identique. Les suites de tests de ces modules **rallument explicitement leur
module** dans leur mise en place — c'est ce qui prouve, à chaque exécution, que
la réactivation fonctionne.

Un test qui échoue parce qu'un module est éteint signale un **filtrage
incomplet**, pas un test à supprimer. C'est ainsi qu'a été trouvé le compteur
d'alertes de stock du cockpit : calculé en SQL direct, il ne passait pas par le
toolset et s'affichait encore module éteint.

## Moteur pur `resolveModules`

État effectif = défaut du catalogue, surchargé par les choix explicites de
l'owner — chaque état porte sa **source** (`defaut_vertical` | `hors_socle` |
`choix`), jamais un module qui disparaît sans explication. Dire « défaut du
vertical » d'un module éteint partout serait faux : `hors_socle` nomme la vraie
raison, et l'écran Réglages affiche « hors du socle — activable ici ».
Surcharges inconnues ou non booléennes ignorées.

Le **fail-open** protège l'agent d'un profil manquant : sans profil, le SOCLE
répond. Il ne rallume jamais un module hors socle — leur extinction est une
décision produit, pas un accident de configuration.

## Effet réel d'une désactivation

1. **Navigation** : la page du module sort du menu (shell, filtrage par
   préfixe d'URL, fail-open en cas d'erreur réseau — la visibilité est du
   confort produit).
2. **Agent** : les outils du module sortent du toolset (`buildToolset` lit le
   profil et filtre — même mécanique fail-closed que le gate owner : absent
   du routage ⇒ `unknown tool`). Sans profil : le socle répond (un profil
   manquant n'ampute jamais l'employé virtuel). En revanche une **erreur DB** dans
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
- Page **Réglages → Modules** : bascules avec source affichée (« votre choix »,
  « défaut du vertical », « hors du socle — activable ici ») + rappel qu'aucune
  donnée n'est supprimée.

## Limites V1 (assumées)

- Granularité module, pas outil : on ne désactive pas un outil isolément.
- Les cartes cockpit adossées à un OUTIL suivent le module (la prévision des
  ventes disparaît avec `prevision_ventes`, par dégradation normale). Celles
  calculées en direct doivent être gardées à la main : `isModuleActive()` côté
  API — c'est le cas des alertes de stock.
