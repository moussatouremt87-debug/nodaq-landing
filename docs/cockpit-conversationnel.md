# Cockpit conversationnel (ticket 2.5)

« Combien j'ai dépensé chez Sogedis ce trimestre ? » — posé en français dans
le cockpit, répondu sur les **données réelles** du tenant, avec les sources du
chiffre.

## Le choix qui structure tout : le modèle n'écrit pas de SQL

La tentation évidente est de laisser le modèle produire une requête SQL et de
l'exécuter. C'est aussi la façon la plus rapide d'ouvrir une exfiltration : le
produit fait déjà entrer du texte de tiers (photos de documents, e-mails de
support, avis clients), et ce texte influence le modèle. Une clause `WHERE`
écrite par un modèle influençable est une clause `WHERE` écrite par
l'attaquant.

Ici, le modèle remplit une **requête structurée** contre un catalogue fermé
(`packages/shared/src/dataCatalog.ts`), qu'un compilateur **pur** valide champ
par champ **avant** qu'une ligne ne soit lue :

```
question → requête structurée (modèle) → compileDataQuery (pur, refuse)
         → QueryPlan (colonnes du catalogue UNIQUEMENT)
         → runDataQuery sous withTenant → lignes chiffrées → réponse
```

Ce que cela ferme **par construction**, pas par filtrage :

| Risque | Pourquoi il ne se pose pas |
|---|---|
| Injection SQL | il n'y a pas de SQL à injecter |
| Exfiltration inter-tenant | exécution sous `withTenant` ; le tenant n'est pas un paramètre |
| Fuite par colonne | un champ hors catalogue est un **refus motivé** |
| Fuite par rôle | dataset et champ portent leur propre gating |
| Table hors périmètre | allowlist explicite de modèles Prisma dans l'exécuteur |

## Catalogue (V1)

| Dataset | Contenu | Accès |
|---|---|---|
| `factures_clients` | factures de l'import FEC (client, montant, reste dû, réglée) | **dirigeant** |
| `documents` | classeur (type, statut, date) | membres |
| `stocks` | articles (quantité, seuil ; **coût unitaire = dirigeant**) | membres |
| `mouvements_stock` | entrées/sorties (motif, variation, date) | membres |
| `immobilisations` | biens (catégorie, méthode, base) | **dirigeant** |

Le gating est à **deux niveaux** : un dataset entier peut être réservé au
dirigeant (CA, immobilisations), et un **champ** peut l'être à l'intérieur d'un
dataset ouvert — le coût unitaire d'achat reste dirigeant-only (doctrine 3.3)
alors que la quantité est visible de tous.

La description envoyée au modèle est **filtrée par rôle** : un membre ne se
voit pas proposer un dataset qu'il ne peut pas lire, donc il ne le demande pas.
Et s'il le demande quand même, le compilateur refuse.

## Le refus est une réponse

Un champ inconnu, un dataset réservé, un opérateur incohérent, une période
absurde : le compilateur renvoie un **motif lisible**, transmis au modèle. Il
peut alors reformuler avec les champs proposés — plutôt que de recevoir une
exception opaque et d'**inventer un chiffre**, ce qui est le pire résultat
possible pour un outil de gestion.

Autres refus utiles : un agrégat `sum` sans grandeur, une grandeur sur un
dataset qui n'en porte aucune, un `contient` sur un nombre, une date qui n'en
est pas une.

## Honnêteté des chiffres

- **Unité dite** : les montants du catalogue sont en centimes, et la réponse
  le précise — sans quoi une réponse peut être fausse d'un facteur 100.
- **Troncature dite** : un regroupement limité renvoie `truncated: true`
  plutôt que de présenter un partiel comme un total.
- **Tri par l'agrégat côté base** : « les plus gros » coupe sur la valeur, pas
  sur l'ordre alphabétique — un top 5 tronqué alphabétiquement serait un top 5
  arbitraire présenté comme un classement.
- **Sources affichées** : la réponse du cockpit liste les outils réellement
  appelés. L'utilisateur voit d'où vient le chiffre.

## Surface

`POST /cockpit/ask` (membres) — même boucle d'agent que le chat, donc mêmes
gardes : toolset lié au tenant de session, outils owner-gated, écritures
toujours en file de validation. Seule la restitution change (pas de flux, une
réponse et la liste des outils). Réponse en `cache-control: private, no-store`.

L'outil `query_business_data` est aussi disponible **dans le chat** : la même
capacité, sans nouvelle surface à sécuriser.

## Exactitude : ce que les tests figent

Deux régressions d'exactitude, trouvées en revue, ont chacune leur test :

- **Un texte qui ressemble à une date reste un texte.** Le plan transporte le
  *type catalogue* du champ filtré ; sans lui, un numéro de pièce
  « 2026-01-15 » partait en `Date` et devenait introuvable — un zéro rendu
  comme un fait.
- **Le groupe « non renseigné » n'est pas relégué.** Un `count` groupé trie sur
  la clé primaire (jamais nulle) et non sur la dimension : trier sur une
  dimension nullable donnait un compte de 0 au groupe sans valeur, qui partait
  en dernier et sautait à la coupe — le plus gros groupe tu, à rebours de la
  doctrine « non-attribuées comptées jamais tues » (3.4).

Deux refus d'ambiguïté complètent l'exactitude : une période **et** un filtre
sur la même colonne de date sont refusés (la période écrasait le filtre en
silence, élargissant le chiffre), et une erreur d'exécution devient un refus
générique — un message Prisma rend ses arguments, donc le `where` complet, et
il serait persisté dans la conversation puis renvoyé au modèle.

## Limites assumées (V1)

- **Une dimension de regroupement** à la fois : « CA par client par mois »
  n'est pas exprimable. Les croisements viendront avec un besoin réel.
- **Pas de regroupement par mois** : les dates sont filtrables mais pas
  groupables (il faudrait une troncature de date côté base). La prévision de
  ventes (3.1) couvre déjà la série mensuelle.
- **Pas de jointure** : chaque dataset est une table. Croiser stocks et
  mouvements passe par deux questions.
- **Le catalogue est le périmètre** : ajouter un dataset = éditer ce fichier,
  avec son gating. C'est volontairement un geste explicite.
- **Modules (3.11)** : `query_business_data` n'est pas rattaché à un module.
  Un tenant qui désactive « Stocks » voit la page masquée et les outils stocks
  retirés du toolset, mais peut encore compter ses articles par le cockpit.
  C'est cohérent avec la doctrine 3.11 — les modules ne sont **pas** une
  frontière de sécurité, seulement du confort de navigation — et c'est dit ici
  plutôt que découvert.
- **Fuseau** : les bornes de période sont en UTC. Sur les colonnes horodatées
  (classeur, mouvements), un enregistrement entre minuit et 1 h peut basculer
  d'un jour. Les colonnes `date` pures (FEC, immobilisations) ne bougent pas.
- **Une conversation par question** : chaque appel crée un transcript sous RLS.
  Aucune rétention n'est encore posée dessus (suivi commun avec les
  conversations du chat).
