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

**`SUSPENDU` est anonymisé, et c'est un choix.** Une interruption saisonnière
est fréquente en paysage ou en entretien, et on pourrait y voir une exécution
en pause. Mais « suspendu » ne dit pas si la relation reprendra ; conserver
sur cette lecture reviendrait à déduire une base légale d'un mot qui ne
l'affirme pas. Conséquence assumée : à la reprise, les affaires matérialisées
n'auront plus de nom de client — une perte **visible**, que le dirigeant
corrige en deux gestes, contre une conservation invisible qu'il ne verrait
jamais.

Et une conservation **muette** serait un effacement qui ment :
`contratsConserves` rapporte chaque contrat gardé avec son motif.

**`notes` part avec le nom.** Champ libre de 2 000 caractères sur un contrat
dont on vient de juger que rien ne fonde de le garder — « ne pas appeler avant
9 h », « litige sur la facture de mars ». Le lien vers la fiche disparaît la
ligne suivante : ce qui survit ici devient définitivement inatteignable.
L'opposition efface déjà `notes` côté fiche, l'anonymisation des affaires
emporte déjà l'adresse ; laisser celui-ci aurait été une asymétrie sans raison.

### Le chemin par contrat ne vaut que pour les affaires ORPHELINES

Un contrat d'entretien peut servir plusieurs interlocuteurs, et
`PATCH /affaires` accepte un `prospectId`. Une affaire générée par ce contrat
mais rattachée **explicitement** à quelqu'un d'autre appartient à cette autre
personne : l'anonymiser serait le symétrique exact de l'erreur que le refus de
la correspondance de noms cherche à éviter — détruire la donnée d'un tiers au
nom de l'effacement d'un autre. Le chemin par contrat exclut donc les affaires
dont le `prospect_id` est renseigné.

### L'angle mort est compté

`contratsSansFiche` dit combien de contrats portent un nom de client sans lien
vers une fiche. Ce nombre ne prétend **rien** sur la personne effacée — il dit
combien de contrats l'owner doit relire lui-même, parce qu'aucun effacement ne
peut les atteindre.

**Il est compté APRÈS la suppression**, et l'ordre porte la justesse du nombre.
Le `SET NULL` détache à l'instant les contrats **conservés** : ils gardent leur
nom et n'ont plus de fiche, donc ils entrent pleinement dans « ce qu'il reste à
relire ». Compter avant les aurait exclus, et le nombre aurait valu
`réel − contratsConserves` sous un libellé qui promet le total.

Il tombe à zéro à mesure que les contrats sont rattachés — et le rattachement
doit exister **pour l'existant**, sans quoi la garde ne vaudrait que pour les
contrats créés après elle et le compteur ne bougerait jamais. L'écran Contrats
affiche `· sans fiche` sur chacun, propose « Rattacher les noms » dès qu'il en
reste un, et nomme le champ « Fiche client (rend le nom effaçable) » plutôt que
« Client » — un libellé neutre se lirait comme un confort de saisie.

Le formulaire **pré-remplit** le nom depuis la fiche choisie : toute la chaîne
d'effacement fait confiance à ce lien, donc un contrat pointant Dupont mais
nommé Martin ferait anonymiser le nom de quelqu'un d'autre. Pré-rempli, pas
verrouillé — une raison sociale peut légitimement différer d'un nom de personne.

Les fiches sont chargées **à la demande** (ouverture du formulaire ou du mode
rattachement) : elles portent des coordonnées dont cet écran n'a aucun usage.
Une troncature ou un échec de chargement est **dit** — dégrader en liste vide
afficherait « aucune fiche » à un dirigeant qui en a six cents, et il saisirait
un nom définitivement hors de portée en croyant n'avoir pas le choix.

## Ce que ce ticket ne livre pas

~~**Le bouton de suppression d'une fiche — donc le rapport n'a pas de
destinataire.**~~ — LIVRÉ, voir « L'écran » ci-dessous. Ce qui suit reste écrit
comme trace de ce qui manquait : L'écran Prospection dit à l'owner que *N fiches dépassent la
durée de conservation recommandée* et ne lui offre aucun moyen de les supprimer :
`DELETE /prospects/:id` n'est appelée par aucun écran aujourd'hui. Il faut le
dire franchement, parce que ça mord sur le choix ci-dessus : le signalement des
affaires conservées, qui est *toute* la justification de ne pas trancher sur
`ARCHIVEE`, n'est aujourd'hui lisible que par un appel direct à l'API. Rien ne le
persiste non plus — c'est une réponse HTTP, pas une tâche. Une suppression
irréversible mérite sa confirmation, son écran et son ticket ; ce ticket-là devra
porter l'affichage du rapport, sans quoi la garde reste théorique.

*(La limite sur les transcriptions d'agent, qui figurait ici, est traitée
ci-dessous.)*

## Les transcriptions d'agent : effacer une source les efface TOUTES

`agent_conversations.messages` porte le fil **complet**, résultats d'outils
compris. Un `analyze_margin` y dépose des noms de chantiers et des montants, un
`list_overdue_invoices` des noms de clients et ce qu'ils doivent, une recherche
de prospection des coordonnées. C'est la donnée la plus concentrée du produit,
dans sa forme la moins structurée — et aucune des trois purges n'y touchait.

### Pourquoi toutes, et pas « celles qui citent la source »

Aucun lien n'existe entre un transcript et une source : les résultats d'outils
sont des chaînes opaques, jamais indexées. Les retrouver imposerait de chercher
un nom dans du texte libre — exactement l'inférence que la doctrine interdit, et
en plus peu fiable. Un homonyme, une troncature, une reformulation du modèle, et
l'effacement se croit complet en laissant la donnée.

*Le coût des deux erreurs est asymétrique.* Ce qu'on détruit en trop : la
possibilité de **reprendre** une conversation. Ce qu'on laisserait en moins : le
nom d'une personne qui vient d'exercer son droit à l'effacement.

Et le premier coûte moins qu'il n'y paraît — voir ci-dessous.

### Ce que « reprendre une conversation » vaut réellement

L'identifiant de conversation ne vit que dans un `useRef` de l'écran de chat. Il
n'est **persisté nulle part** : aucune route ne liste les conversations, aucun
écran n'en affiche l'historique. Un simple rechargement de page rend donc le
transcript **définitivement inatteignable** — plus personne, jamais, ne pourra le
lire par le produit.

Une donnée que personne ne peut plus lire et que rien n'efface n'est pas un
historique : c'est un dépôt.

### Les quatre chemins le disent

`DELETE /connectors/fec`, `DELETE /prospects/:id`, `POST /prospects/:id/opposition`
et `DELETE /classeur/documents/:id` rendent tous `conversationsEffacees`.

La suppression d'une pièce a **cessé de rendre `204`** pour cela, et c'est la
revue qui a eu raison : c'est la plus banale des quatre — corriger une photo
prise de travers n'est pas une demande d'effacement — et détruire au passage les
conversations de toute l'équipe sans un mot, douze fois pour douze pièces mal
classées, était le seul silence que ce ticket avait laissé passer.

**L'opposition n'est pas l'article 17**, mais c'est le même raisonnement :
`list_prospection_followups` a déposé dans le fil les coordonnées que
l'opposition vient d'effacer de la fiche. Minimiser la fiche en laissant sa copie
dans un fil illisible ne minimise rien.

### Un 404 ne détruit rien

`DELETE /prospects/:id` décide son 404 **après** le commit. La purge partait
avant le contrôle d'existence : un `DELETE` sur un identifiant inconnu — un
double-clic, un rejeu après un 200 réussi — détruisait toutes les transcriptions
du tenant puis répondait « prospect not found ». Les deux autres routes énonçaient
cet invariant et le respectaient ; celle-ci le violait, et aucun test ne passait
par ce chemin. Il en existe un désormais.

### Deux couches, pas une

La purge filtre sur `tenantId` **en plus** de la RLS. Un `deleteMany({})` nu ne
tenait que par une seule couche, alors que toutes les suppressions voisines des
mêmes blocs filtrent déjà — et la signature accepte n'importe quelle transaction,
donc rien au niveau du type n'aurait empêché un futur appelant de vider tous les
tenants. Deux tests d'isolation le vérifient, et ils rougissent si la purge passe
un jour par le client admin — la tentation d'un job « global ».

## Rétention des transcriptions (art. 5.1.e)

Effacer une source ne suffit pas : une conversation dont *aucune* source n'est
jamais effacée restait en base à vie. `CONVERSATION_RETENTION_DAYS` (30 jours,
config versionnée datée dans `packages/shared/src/conversationRetention.ts`) lui
donne un terme, et le balayage quotidien existant s'en charge.

**Trente jours est délibérément généreux** au regard de l'usage réel : la reprise
meurt avec l'onglet, donc la fenêtre utile se compte en heures. La marge couvre
un poste laissé allumé, un congé, une reprise tardive — sans qu'aucune décision
de conservation ne repose sur une supposition. Le bon réglage se verra le jour où
le produit offrira un historique : la fenêtre deviendra alors un vrai choix
produit, pas une borne de sécurité.

**Supprimée, pas réduite** — l'inverse du choix fait sur la file de validation.
Une `pending_action` garde sa ligne parce qu'elle porte la trace d'une
**décision** humaine. Une transcription n'en porte aucune : les actions qu'elle a
préparées vivent dans la file avec leur propre trace, et la métadonnée
d'exécution (outils appelés, latence, issue) est déjà tracée hors base. Garder
une ligne vidée n'apporterait qu'un compteur — une donnée sans finalité, ce que
l'article 5.1.e interdit précisément.

**L'âge se compte sur la dernière activité**, jamais sur la création : le runtime
réécrit la ligne à chaque tour, donc une conversation entretenue depuis des mois
est *active*, pas ancienne.

Et **reprendre est une activité**. `@updatedAt` n'était écrit qu'à la persistance
finale : une conversation dormante depuis 31 jours, rouverte à l'instant, restait
éligible pendant tout le tour — donc supprimable sous les doigts de
l'utilisateur, précisément ce que la règle affirmait écarter. Le runtime touche
désormais la ligne à la reprise.

**Une seule expression de la règle.** Une première version portait un
`conversationVerdict` en TypeScript pendant que le balayage supprimait en SQL :
les deux divergeaient sur la borne exacte, et les tests du moteur pur étaient
verts contre du code que la production n'exécutait pas. Il ne reste que
`conversationCutoff`, que le SQL consomme.

**Paginé comme le reste.** Un `deleteMany` sur un arriéré de dizaines de milliers
de fils serait la plus longue transaction du produit, et son rollback annulerait
le passage entier — donc les tenants les plus en retard seraient exactement ceux
qu'on ne balaierait jamais. Ici la pagination n'a pas besoin de curseur : chaque
page retire ses lignes, donc la suivante avance par construction.

**Le compteur du cockpit change de sens, donc de nom** : `kpis.conversationsRecentes`.
« Aucun écran ne l'affiche aujourd'hui » n'était pas une raison suffisante de
garder l'ancien nom — l'argument périme au premier écran qui l'affiche.

**La troncature des transcriptions a son propre drapeau.** Partagé avec celui des
propositions, le journal aurait dit « des actions n'ont pas été examinées » pour
un arriéré de transcriptions — envoyer chercher au mauvais endroit. Et il se pose
sur un **sondage** de ce qui reste, pas sur « la dernière page était pleine » :
un nombre de lignes tombant pile sur un multiple de la page aurait crié au loup.

**Le passage se journalise dès qu'il supprime.** Le garde-fou « un passage qui n'a
rien fait ne se journalise pas » ignorait `conversationsSupprimees` : un passage
détruisant cinquante mille transcriptions sans réduire une seule proposition
sortait sans laisser de trace. Le seul compteur qui compte des lignes *détruites*
était le seul à ne pas être écrit.

## Une conversation effacée pendant un tour d'agent

Le transcript est chargé au début du tour et écrit à la fin. Une purge ou un
balayage intercalé fait donc disparaître la ligne sous le tour en cours. Deux
règles s'appliquent alors, et elles tirent en sens opposés :

- **ne pas la ressusciter** : un `create` de repli réécrirait, *après*
  l'effacement, la donnée qu'on venait d'effacer ;
- **ne pas perdre la réponse** : elle est déjà calculée, des `pending_action` ont
  pu être créées pendant le tour, et laisser l'erreur remonter les laisserait en
  file sans que l'utilisateur sache pourquoi son message a « échoué ».

Le runtime rend donc la réponse **sans transcript**, et l'écran repart sur une
conversation neuve. Il remet aussi son identifiant à zéro sur toute erreur :
sans cela, après une purge, chaque message suivant du même onglet repartait avec
un identifiant mort et l'écran affichait la même erreur indéfiniment, jusqu'à un
rechargement manuel que rien ne suggérait.

**Ce qui reste ouvert** : un tour *sans* identifiant qui se termine par un
`create` après une purge écrit une transcription contenant la donnée qu'on vient
d'effacer. La fenêtre est celle d'un tour d'agent. La fermer demande de pouvoir
invalider un tour en vol — c'est ce que le bus d'événements du ticket 4.4
apporterait. C'est dit ici plutôt que corrigé au jugé.

## L'écran, enfin

`DELETE /prospects/:id` a existé pendant quatre tickets sans qu'**aucun écran
ne l'appelle**. L'API savait effacer la fiche, anonymiser les affaires qui en
dérivent, tarir la recopie des contrats, purger les transcriptions — et rendre
la liste **motivée** de ce qu'elle avait dû conserver. Ce compte rendu est toute
la justification de ne pas trancher sur les cas ambigus, et il n'avait pas de
destinataire : la garde restait théorique.

**La confirmation dit ce qui va se passer**, pas « êtes-vous sûr » — et elle dit
le **rayon réel**, pas une version rassurante.

La revue a trouvé deux écarts entre le texte et la route, tous deux dans la
direction confortable. « Le chat repart à zéro » se lisait spontanément « les
conversations concernant cette personne », alors que `purgeAgentTranscripts`
efface **toutes** les conversations du tenant, de tous les utilisateurs, y
compris sans rapport avec la fiche : faire signer une destruction de données
d'autrui sous un libellé ambigu n'est pas un consentement éclairé. Et « les
contrats liés perdent son nom » était **inconditionnel**, alors qu'un contrat
`ACTIF` ou portant une exécution est conservé — asymétrie d'autant plus visible
que la puce du dessus annonçait déjà la conservation des chantiers. Le compte
rendu rattrape *après* ; la décision se prend *avant*.

Deux effets se taisaient aussi : les `notes` des contrats anonymisés (champ
libre de 2 000 caractères) et le rejet des relances encore en file.

**Le compte rendu reste à l'écran** jusqu'à ce que l'owner le referme : chantiers
conservés avec leur référence et leur motif, contrats conservés, contrats hors de
portée, conversations effacées. Il n'est **pas persisté** — c'est une réponse
HTTP, pas une tâche — et l'écran le dit, plutôt que de laisser un rechargement
emporter une liste à traiter à la main.

**Le rôle est LU, pas supposé.** Le patron optimiste — afficher, retirer sur 403
— convient à un bouton anodin. Pas ici : un membre franchissait une confirmation
détaillée d'action irréversible sur données personnelles pour ne récolter qu'un
403, c'est-à-dire une répétition générale d'un article 17 offerte à qui n'y a pas
droit. La route est owner-only et testée comme telle ; ce n'était pas une faille,
c'était une invitation.

**Le bouton existe aussi sur une fiche opposée.** L'opposition minimise (on garde
de quoi ne plus contacter), l'effacement supprime : une personne qui s'est
opposée puis demande son effacement ne doit pas buter sur un écran qui ne lui
offre plus rien.

### Un compteur qui envoyait chercher sans dire où

L'encart annonçait « N fiches sans contact depuis plus de 36 mois : à supprimer »
sans jamais dire lesquelles. Les fiches périmées sont maintenant **signalées dans
la liste**, là où se trouve le bouton.

Et il a fallu **réviser une décision du 2.12**. Les fiches opposées ET périmées
étaient comptées mais jamais identifiées, au motif que « les nommer contredirait
l'exclusion ». C'était juste des **noms** — une liste nominative d'opposés est la
porte par laquelle ils reviennent dans une campagne — mais faux des
**identifiants**, et le compte seul ne résolvait qu'à moitié le problème qu'il
énonçait : « 3 fiches opposées sont périmées » sans moyen de dire lesquelles
n'est pas un signalement, c'est une inquiétude. `expiredOptedOut` rend donc les
ids, exactement comme `retentionAlerts` et pour la même raison. Un test vérifie
qu'aucun nom n'y figure.

## Tests

`apps/api/test/effacement.test.ts` côté API, et
`apps/web/test/effacement-fiche.test.ts` côté écran — une garde **statique**,
comme `freshness-wiring` : elle ne prouve pas que l'écran s'affiche, elle prouve
que le branchement et l'affichage du compte rendu n'ont pas disparu du code.
C'est exactement la régression qui se produirait sans bruit : l'appel retiré au
détour d'un refactor, l'API toujours verte, et plus personne pour lire ce qui
reste.

**Sa première version était creuse, et la revue l'a démontré par simulation.**
Elle cherchait ses symboles n'importe où dans le fichier : retirer la puce
« conversations » du dialogue la laissait VERTE, parce que
`conversationsEffacees` apparaît aussi dans le compte rendu — donc *après*
l'effacement — et que `window.confirm` sert aussi à l'opposition. Deux symboles
présents dans le même fichier ne prouvent rien de leur proximité. Et chercher
`deleteProspect` était satisfait par la seule ligne d'`import` : une fonction
`effacer` morte, jamais reliée à un `onClick`, passait toute la suite.

Les assertions portent désormais sur le **corps** de `async function effacer`,
délimité en comptant les accolades. Ce qu'on affirme du dialogue ne peut plus
être satisfait par du texte qui vit ailleurs.

**Une trace d'audit** (art. 5.2) est journalisée au succès : des compteurs, et
**jamais le nom** — journaliser l'identité qu'on vient d'effacer serait la
recréer dans les logs. Le compte rendu à l'écran n'étant pas persisté, c'était
sinon la prise de notes de l'owner qui portait seule la redevabilité. Le fil n'est pas « la ligne est-elle partie »
mais « le produit tient-il ce qu'il affirme » : chaque test vérifie qu'un dérivé
précis (libellé, montant, adresse, coordonnées) a bien disparu, et que ce qui
survit — la trace d'une décision, une affaire sous contrat — survit **pour une
raison écrite**. Un effacement sans test est une promesse.
