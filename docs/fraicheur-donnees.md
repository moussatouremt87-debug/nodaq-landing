# Fraîcheur des données (ticket 2.21 A)

> « Un cockpit qui ment est pire qu'un cockpit vide. »

L'employé Compta exécute une action, la base change — et l'écran continue
d'afficher les chiffres d'avant jusqu'à un rechargement manuel. En démonstration,
« attendez, je rafraîchis » détruit la promesse d'un assistant qui travaille
pendant qu'on le regarde.

Tout vit dans `apps/web/lib/freshness.ts` (config versionnée, `FRESHNESS_RULES_VERSION`)
et `apps/web/lib/useFreshness.ts` (branchement React).

## Le diagnostic, cause par cause

Le ticket annonçait trois causes. Une seule tient, et pas telle qu'énoncée —
c'est écrit en tête de `freshness.ts` pour que personne ne re-corrige les deux
autres :

1. **Cache client non invalidé** — vrai, mais chaque écran se rafraîchissait
   déjà après SA propre mutation. Ce qui manquait, c'est le rafraîchissement
   quand l'écriture vient d'**ailleurs** : l'agent dans le chat, un autre écran,
   un collègue.
2. **Exécution asynchrone** — faux. `POST /pending-actions/:id/approve` exécute
   puis répond : le 200 arrive après l'écriture métier, il n'y a rien à attendre.
3. **Agrégats recalculés ailleurs** — faux. Trésorerie, marge et impayés sont
   dérivés **à la lecture**. Ils sont périmés par les mêmes écritures, donc ils
   figurent dans la correspondance — mais aucun recalcul différé n'existe.

## Les deux moitiés du mécanisme

**Un écran déclare les VUES qu'il affiche**, jamais la liste des mutations du
produit :

```ts
const freshness = useFreshness(["cockpit"], load);
```

Il se recharge alors quand un événement périme l'une de ses vues, quand l'onglet
reprend le focus, et quand le réseau revient — sans jamais « penser » à le faire.

**Un écran qui écrit émet un événement**, après le succès :

```ts
await decidePendingAction(id, decision);
emitDomainEvent(decision === "approve" ? "action.validee" : "action.rejetee");
```

Le lien entre les deux est `EVENT_VIEWS` : ajouter un écran, c'est ajouter une
ligne de config, pas relire toutes les écritures du produit.

## Règles

- **Émettre APRÈS le succès, jamais dans un `finally`.** Sur un 403 ou un 409
  rien n'a été écrit ; annoncer une validation ferait recharger tout le produit
  pour rien et laisserait croire que quelque chose a changé.
- **L'horodatage n'avance qu'en cas de succès.** Afficher « à jour à l'instant »
  après un refetch raté est exactement le mensonge que ce ticket corrige.
  « Jamais rafraîchi » et l'état périmé (au-delà de `STALE_AFTER_MS`) sont **dits**.
- **Une seule réponse a le droit d'horodater : la dernière.** `createLoadGuard()`
  sérialise les chargements concurrents (bus + focus + bouton) ; sans lui, une
  réponse lente réaffiche des chiffres plus vieux en les déclarant frais.
- **Les événements ne portent AUCUNE donnée métier** : seulement « quelque chose
  de cette nature a changé ». Le flux SSE du chat ne transporte que des noms
  d'outils (minimisation 2.17/1.6), et c'est suffisant.
- **Le bus est en mémoire, par onglet.** Il ne synchronise pas deux onglets ni
  deux appareils : le retour de focus s'en charge.

## `MUTATION_EFFECTS` : le registre qui empêche l'oubli

Chaque helper d'écriture de `lib/api.ts` y est classé :

| Valeur | Sens |
|---|---|
| `["evenement", …]` | l'écran qui l'appelle DOIT émettre (le choix exact dépend parfois du résultat) |
| `"selon_outils"` | l'événement se déduit des outils réellement exécutés par l'agent (`eventForTool`) |
| `null` | aucune vue **partagée** n'en dépend — l'écran qui écrit est le seul à afficher la donnée |

Un `null` est une affirmation, pas une échappatoire : il dit « personne d'autre
ne regarde cette donnée ». Le mettre à tort produit un écran faux ailleurs.

## Ce que la CI garde

Dans `apps/web/test/freshness-wiring.test.ts` et `freshness.test.ts` :

- toute écriture de `lib/api.ts` est **classée** dans `MUTATION_EFFECTS` (la
  liste est **dérivée** du fichier, jamais recopiée) ;
- le registre ne décrit pas d'écriture disparue ;
- tout écran qui appelle une mutation non-`null` émet un événement ;
- tout événement déclaré est réellement émis quelque part ;
- tout outil d'agent `requiresValidation: true` (`TOOL_POLICIES`) porte un
  événement — sinon on recrée le bug pour ce seul outil, silencieusement ;
- la nav est abonnée à `validation` et `nav`.

Ces gardes sont **statiques** : elles prouvent qu'un appel n'a pas disparu, pas
qu'il part au bon moment. C'est dit, et c'est la limite du dispositif.

## Non livré (et pourquoi)

- **Test E2E navigateur** : aucun harnais Playwright dans le dépôt. Remplacé par
  les gardes statiques ci-dessus — qui ne sont pas un E2E et ne sont pas
  présentées comme tel.
- **« Un échec rejouable »** : rejouer un `send_dunning` qui a échoué *après*
  l'envoi relancerait le client une seconde fois. Cela demande une clé
  d'idempotence par exécuteur — son propre ticket, pas une case à cocher.
