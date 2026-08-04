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

Le filtre juste n'est pas le statut mais le **payload** : une ligne déjà réduite
n'a plus de `sourceRef`, donc elle ne correspond plus. Filtrer sur « tout sauf
rejeté » — pour ne pas repasser sur ce qu'on vient de rejeter — excluait aussi
les propositions **rejetées avant la purge**, c'est-à-dire l'état décidé le plus
fréquent, puisque l'écran pousse explicitement à rejeter. Le cas majoritaire
échappait à l'effacement.

**Ce que la purge ne touche pas : l'immobilisation déjà créée.** C'est une donnée
métier propre — un actif que l'entreprise possède, saisi par une décision humaine
explicite. La supprimer détruirait de la comptabilité légitime au nom de
l'effacement d'autre chose.

**Les agrégats de charges dérivés du journal partent aussi** (`cost_entries` de
source `fec`). L'import lui-même prouve qu'ils lui appartiennent : il les efface
et les réécrit à chaque passage. Les laisser, c'était servir dans la marge, le
cockpit et le brief des charges tirées d'un journal qu'on affirmait avoir effacé.
Les saisies **humaines** (`source: "saisi"`) ne sont pas touchées : ce ne sont
pas des dérivés, ce sont les chiffres du patron.

C'est le même patron que `rejectProspectDrafts` (2.12), qui rejette **et** réduit
un brouillon de relance nominatif : rejeter sans réduire laisserait le nom en
base indéfiniment.

## L'identité recopiée sur les affaires

`DELETE /prospects/:id` anonymise `client_name`, `address`, `latitude` et
`longitude` sur les affaires liées — **mais pas sur toutes**, et c'est le cœur du
sujet :

| Statut de l'affaire | Traitement | Fondement |
|---|---|---|
| `PROSPECT`, `DEVIS_ENVOYE`, `PERDUE` **sans trace d'exécution** | **anonymisée** | aucun contrat n'a jamais existé : rien ne fonde la conservation |
| `ACCEPTEE`, `EN_COURS`, `TERMINEE` | conservée | l'exécution du contrat la fonde ; effacer détruirait la preuve d'un travail réellement effectué |
| `ARCHIVEE` | conservée et **SIGNALÉE** | le statut ne dit plus si un contrat a existé |
| n'importe lequel, **avec trace d'exécution** | conservée et **SIGNALÉE** | des faits contredisent le statut |

### Le statut ne suffit pas à décider

La première version de ce ticket anonymisait sur le seul mot. `PERDUE` semblait
vouloir dire « jamais contractée » — mais `EN_COURS → PERDUE` est un chemin
banal : chantier commencé puis abandonné, client défaillant. Anonymiser là-dessus
détruisait la preuve d'un travail réellement effectué, **l'erreur exacte pour
laquelle `ARCHIVEE` était déjà épargnée**. Le raisonnement valait pour une
famille de statuts et pas pour l'autre.

On regarde donc des **faits**, pas un libellé : pièces imputées non révoquées,
factures rattachées, acomptes encaissés, heures pointées, date de fin réelle. Une
seule suffit à conserver — et à le signaler.

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

## Le contrat, ou l'effacement qui se défait tout seul

Le bloc 2 de 4.2 a introduit une **source de recopie**, et elle a rendu tout ce
qui précède insuffisant. `POST /contrats/:id/occurrences` écrit
`contrats.client_name` sur **chaque affaire générée**. Effacer une fiche
anonymisait donc consciencieusement les affaires existantes pendant que le
contrat, lui, gardait le nom — et le réécrivait sur une affaire neuve au clic
suivant.

Un mois plus tard, la donnée était revenue. **Un nom supprimé qui revient n'est
pas un effacement, c'est un délai** — et c'est la pire forme, parce que
l'exécution s'était déclarée réussie.

### Le lien est saisi, jamais deviné

`contrats.prospect_id` est nullable et **explicite**. Rapprocher un contrat
d'une fiche par correspondance de noms aurait fermé le trou d'un seul coup, et
c'est exactement l'inférence que la doctrine interdit : deux clients homonymes
existent, et effacer le contrat du mauvais détruit la donnée d'un tiers **en
silence**. Le coût des deux erreurs est asymétrique — un contrat hors de portée
reste un problème visible, puisqu'il est compté et annoncé.

La clé étrangère est composite `(tenant_id, prospect_id)` — l'intégrité
référentielle contourne la RLS — avec la **liste de colonnes** PostgreSQL 15+
`ON DELETE SET NULL ("prospect_id")` : sans elle, `SET NULL` sur une FK
composite annulerait aussi `tenant_id`, qui est `NOT NULL`.

### Deux chemins vers les affaires, tous deux explicites

La matérialisation copie désormais `prospect_id` **en même temps** que le nom :
copier une identité sans copier le moyen de l'effacer fabrique de la donnée
orpheline à chaque clic. Restent les affaires générées **avant** ce ticket, qui
ne portent que leur `contrat_id` : la recherche par fiche ne les voyait pas, et
l'effacement se déclarait complet en les laissant nominatives. Le chemin
*fiche → contrat → affaires* les rattrape — deux liens explicites, pas une
correspondance de noms.

### Ce qui fonde de garder un contrat

Même logique que les affaires : on conserve sur un **fait**, jamais sur un
libellé.

| Fait | Conservé parce que |
|---|---|
| statut `ACTIF` | relation en cours d'exécution (art. 17.3.b) — l'effacer casserait la prestation que la personne reçoit encore |
| a produit une affaire elle-même conservée | même exécution ; anonymiser le contrat en gardant l'affaire nominative ne protégerait personne et détruirait la pièce qui explique d'où vient ce chantier |

Et une conservation **muette** serait un effacement qui ment :
`contratsConserves` rapporte chaque contrat gardé avec son motif.

### L'angle mort est compté

`contratsSansFiche` dit combien de contrats portent un nom de client sans lien
vers une fiche. Ce nombre ne prétend **rien** sur la personne effacée — il dit
combien de contrats l'owner doit relire lui-même, parce qu'aucun effacement ne
peut les atteindre. Il tombera à zéro à mesure que les contrats seront
rattachés ; l'écran Contrats affiche `· sans fiche` sur chacun, et son
formulaire nomme le champ « Fiche client (rend le nom effaçable) » plutôt que
« Client », parce qu'un libellé neutre se lirait comme un confort de saisie.

## Ce que ce ticket ne livre pas

**Le bouton de suppression d'une fiche — donc le rapport n'a pas de
destinataire.** L'écran Prospection dit à l'owner que *N fiches dépassent la
durée de conservation recommandée* et ne lui offre aucun moyen de les supprimer :
`DELETE /prospects/:id` n'est appelée par aucun écran aujourd'hui. Il faut le
dire franchement, parce que ça mord sur le choix ci-dessus : le signalement des
affaires conservées, qui est *toute* la justification de ne pas trancher sur
`ARCHIVEE`, n'est aujourd'hui lisible que par un appel direct à l'API. Rien ne le
persiste non plus — c'est une réponse HTTP, pas une tâche. Une suppression
irréversible mérite sa confirmation, son écran et son ticket ; ce ticket-là devra
porter l'affichage du rapport, sans quoi la garde reste théorique.

**Les transcriptions d'agent.** `agent_conversations` persiste les échanges
complets de l'employé virtuel, qui peuvent citer un chiffre du journal, un nom de
fournisseur ou un nom de prospect. Aucune des trois purges n'y touche. C'est une
limite connue, et elle est d'une autre nature : purger une conversation, c'est
décider ce qu'il advient d'un fil de discussion dont une partie n'a rien à voir
avec la source effacée. Son propre ticket.

## Tests

`apps/api/test/effacement.test.ts`. Le fil n'est pas « la ligne est-elle partie »
mais « le produit tient-il ce qu'il affirme » : chaque test vérifie qu'un dérivé
précis (libellé, montant, adresse, coordonnées) a bien disparu, et que ce qui
survit — la trace d'une décision, une affaire sous contrat — survit **pour une
raison écrite**. Un effacement sans test est une promesse.
