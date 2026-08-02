# ADR-007 — Pivot : de co-pilote financier à assistant opérationnel des TPE à l'affaire

**Statut** : accepté · **Date** : 2026-08-02 · **Remplace** : la direction produit du
`blueprint-technique-v2.md` (qui reste en place comme trace de l'ancienne cible)

## Contexte

Le produit a été conçu comme un **co-pilote financier pour PME** : impayés, relances,
trésorerie, justificatifs, facturation électronique. Une trentaine de tickets ont été
livrés, testés, audités et déployés sur cette hypothèse.

L'hypothèse était fausse. Ce n'est pas une dérive d'exécution — c'est une erreur
d'analyse de marché, constatée après coup :

- **Pennylane** : ~700 000 clients, ~100 M€ d'ARR, plateforme agréée (ex-PDP)
  immatriculée ; son offre à 24 € HT/mois inclut déjà relances automatisées, prévision
  de trésorerie, rapprochement bancaire et devis signés.
- **Qonto** : 600 000 clients, agents IA en production **avec validation humaine
  explicite sur chaque action critique** — c'est-à-dire notre `pending_actions`, déjà
  déployé à grande échelle.
- **Cegid** (Pulse) et **Sage** déploient leurs propres agents.

Sur la couche compta/finance, nous arrivons derniers, plus chers, sans base installée.

## Décision

**nodaq devient l'assistant opérationnel quotidien des TPE à l'affaire.**

> L'utilisateur ne saisit rien. Il dicte, il photographie, il valide.
> L'assistant prépare, l'humain valide, le système apprend.

Le changement d'axe tient en une phrase : **les outils existants s'organisent par
période et par compte ; nous nous organisons par affaire.** Un logiciel de comptabilité
répond à « combien j'ai gagné en juin ». Nous répondons à « est-ce que **ce** chantier
me rapporte de l'argent, pendant qu'il est encore en cours ».

**Cible** : TPE de 3 à 15 salariés dont le travail s'organise en affaires — bâtiment,
paysage, événementiel, maintenance, services au projet. **Hors cible** : encaissement
immédiat (coiffure, commerce), micro-entrepreneurs, PME de 20+ déjà sous ERP.

**Pourquoi ce terrain est tenable** : les ERP qui savent calculer une marge de chantier
exigent une saisie complète — un patron à 47 h/semaine ne saisit pas, donc leurs données
sont fausses. Les outils que les artisans utilisent réellement ne calculent rien. Le pari
est que **l'affaire se remplit toute seule**, parce que l'agent impute depuis la banque,
les photos et les plannings.

## Conséquences

### Ce qui ne change pas — aucune règle n'est assouplie

Souveraineté (`route()`/`routeChat()`, jamais un SDK fournisseur) · isolation
multi-tenant à deux couches (RLS + `withTenant`, chaîne d'autorisation complète) ·
human-in-the-loop (`pending_actions` — **devenu un argument produit**) · secrets ·
mémoire par tenant sans réentraînement · TDD et gate RGPD.

### Ce qui survit dans le code

Socle multi-tenant et RLS · classifier et routage souverain · agent-runtime et outils
MCP · file de validation · registre de modules (3.11) · webhooks · notifications push ·
support e-mail · classeur photo et mémoire tenant · import FEC et connecteurs bancaires
— ces deux derniers désormais en **sources de données**, plus en finalité.

### Ce qui est éteint — par le registre, jamais par suppression

**Aucune ligne de code n'est supprimée.** L'extinction passe par
`defaultOn: "aucun"` dans `packages/shared/src/moduleCatalog.ts`, et rien d'autre.
Trois raisons : c'est réversible en un clic, la CI reste verte, et ce code reste un
actif dans une discussion avec un éditeur.

| Module | Tickets d'origine |
|---|---|
| `stocks` (stocks + prix matières) | 3.2, 3.3 |
| `immobilisations` | 2.19 |
| `reglementaire` | 3.7 |
| `avis` | 3.8 |
| `rgpd` | 3.9 |
| `facturation_electronique` | 2.3, 2.4 |
| `prevision_ventes` | 3.1 |
| `signaux_clients` | 3.4 |
| `silae` | 3.10 |

Les connecteurs Sellsy, Sage et EBP (2.1, 2.2) **n'ont jamais été implémentés** : il n'y
a rien à éteindre. Les connecteurs existants sont Pennylane, Qonto, Bridge, Silae, PDP,
plus le connecteur fichier FEC.

Restent au socle : `classeur` et `rh`. Le cœur (cockpit, chat, file de validation,
connecteurs, notifications) **n'est pas un module** et ne peut pas être éteint.

### Limite explicite : éteindre n'est pas fermer

Un module éteint perd sa page dans la navigation et ses outils dans le toolset de
l'agent. **Les autorisations de ses routes API sont inchangées** : c'est une surface
produit, pas une frontière de sécurité. Un owner qui appelle directement
`POST /factures/soumettre` obtient toujours une réponse.

Nuance à connaître : les routes **adossées à un outil du toolset** (`/reglementaire`,
`/avis/reputation`, `/rh/plan`…) répondent `409 « module désactivé »` — non par
autorisation, mais parce que leur outil a disparu du routage. `GET /rgpd` dégrade son
audit à `null`. Les routes CRUD directes, elles, répondent normalement. Aucune de ces
trois formes n'est un contrôle d'accès.

### Effet sur les tests

Les suites des modules éteints **rallument explicitement leur module** dans leur mise en
place. Ce n'est pas un contournement : c'est ce qui prouve, à chaque exécution, que
l'extinction est réversible et que la fonctionnalité est intacte. Un test qui échouerait
parce qu'un module est éteint signalerait un filtrage 3.11 incomplet — et c'est ainsi
qu'ont été trouvés **deux** chemins directs qui ignoraient le registre : le compteur
d'alertes de stock du cockpit (SQL direct) et les jeux de données `stocks`,
`mouvements_stock` et `immobilisations` du **cockpit conversationnel** (2.5) — le chat
restait une porte ouverte sur des modules dont la page et les outils avaient disparu.
Les deux sont désormais gardés, et le second refuse avec un motif.

## Suite

**4.1 — Objet Affaire** (colonne vertébrale : rattachements nullables, calcul de marge
déterministe et honnête) · **4.2 — Packs verticaux** (5 métiers livrés en **données**,
plus les briques génériques récurrence/contrats et encaissé ≠ acquis) · **F1 à F6**.

**Règle d'architecture qui conditionne la suite** : *un vertical = un fichier de données,
jamais une ligne de code métier.* Un `if (vertical === 'btp')` dans une feature
transforme un produit en cinq produits à maintenir.
