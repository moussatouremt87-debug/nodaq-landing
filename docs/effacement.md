# Droit à l'effacement (RGPD art. 17) — ce que les purges laissaient derrière

> Trois routes se disaient effaçantes et ne l'étaient qu'à moitié. Ce n'était
> pas une fuite : c'était un produit qui **affirmait plus qu'il ne faisait**.

Aucune de ces trois lacunes n'était une faille d'isolation — tout restait sous
RLS, dans le bon tenant. C'est un problème d'une autre nature, et pas plus
petit : une purge demandée au titre de l'article 17 laissait en base des données
tirées de ce qu'on prétendait avoir effacé.

## La règle : effacer une source efface ce qui en dérive

Une donnée dérivée est une donnée. Un libellé de compte recopié dans une
proposition d'immobilisation, un nom de fournisseur extrait d'une photo, une
adresse recopiée sur une fiche chantier : la source disparue, ces copies
restaient, et plus rien ne permettait même de les relier à quoi que ce soit.

Tout se fait **dans la transaction de la purge**. Un effacement partiellement
appliqué serait le pire des deux mondes : la source effacée, les dérivés
restants, et aucun moyen de recommencer.

## Deux régimes, parce que deux lignes ne valent pas la même chose

Pour les propositions dérivées (`create_fixed_asset` issues du FEC ou du
classeur), `reduceDerivedProposals` applique :

| État de la proposition | Ce qui arrive | Pourquoi |
|---|---|---|
| `pending` | **rejetée** et payload réduit | approuver une proposition dont la source a disparu créerait une immobilisation que plus personne ne peut vérifier |
| déjà décidée | payload réduit, **statut et attribution conservés** | qui a décidé quoi, et quand, n'est pas une donnée dérivée de la source : c'est la trace d'une décision humaine, et effacer une source ne réécrit pas l'histoire |

**Ce que la purge ne touche pas : l'immobilisation déjà créée.** C'est une donnée
métier propre — un actif que l'entreprise possède, saisi par une décision humaine
explicite. La supprimer détruirait de la comptabilité légitime au nom de
l'effacement d'autre chose.

C'est le même patron que `rejectProspectDrafts` (2.12), qui rejette **et** réduit
un brouillon de relance nominatif : rejeter sans réduire laisserait le nom en
base indéfiniment.

## L'identité recopiée sur les affaires

`DELETE /prospects/:id` anonymise `client_name`, `address`, `latitude` et
`longitude` sur les affaires liées — **mais pas sur toutes**, et c'est le cœur du
sujet :

| Statut de l'affaire | Traitement | Fondement |
|---|---|---|
| `PROSPECT`, `DEVIS_ENVOYE`, `PERDUE` | **anonymisée** | aucun contrat n'a jamais existé : rien ne fonde la conservation |
| `ACCEPTEE`, `EN_COURS`, `TERMINEE` | conservée | l'exécution du contrat la fonde ; effacer détruirait la preuve d'un travail réellement effectué |
| `ARCHIVEE` | conservée et **SIGNALÉE** | le statut ne dit plus si un contrat a existé |

L'affaire elle-même **survit** dans tous les cas : c'est un effacement de données
personnelles, pas la destruction d'un historique de chantiers.

### Pourquoi `ARCHIVEE` n'est pas tranchée

L'archivage est la sortie commune des affaires **gagnées et perdues**. Le statut
a donc perdu l'information qui permettrait de décider. Trancher au hasard
détruirait de la donnée contractuelle une fois sur deux — ou conserverait une
adresse sans base une fois sur deux.

Alors on ne tranche pas : la réponse **rapporte** chaque affaire conservée, avec
sa référence, son libellé et son motif, et l'owner termine à la main. C'est la
doctrine maison appliquée à l'effacement : *un refus est une réponse motivée*, et
*ce qui n'est pas fait est dit*. Un effacement qui laisse des données doit dire
lesquelles — sinon personne ne sait qu'il reste du travail.

## Ce que ce ticket ne livre pas

**Le bouton de suppression d'une fiche.** L'écran Prospection dit à l'owner que
*N fiches dépassent la durée de conservation recommandée* et ne lui offre aucun
moyen de les supprimer : `DELETE /prospects/:id` n'est appelée par aucun écran
aujourd'hui. C'est un vrai manque, mais c'en est un autre — une suppression
irréversible mérite sa confirmation, son écran et son ticket, pas un bouton
glissé en fin de celui-ci.

## Tests

`apps/api/test/effacement.test.ts`. Le fil n'est pas « la ligne est-elle partie »
mais « le produit tient-il ce qu'il affirme » : chaque test vérifie qu'un dérivé
précis (libellé, montant, adresse, coordonnées) a bien disparu, et que ce qui
survit — la trace d'une décision, une affaire sous contrat — survit **pour une
raison écrite**. Un effacement sans test est une promesse.
