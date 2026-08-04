# Les packs verticaux

> « Un vertical = **un fichier de données**, jamais une ligne de code métier. »
> — ADR-007, règle d'architecture qui conditionne toute la suite.

Un `if (vertical === "batiment")` dans une feature transforme un produit en
cinq produits à maintenir : le jour du pack traiteur, on repaie chaque
occurrence. Une feature appelle `affaireWords(vertical)` ou `verticalLabel()`
et ne sait rien de plus. **Si un pack semble exiger du code, c'est le moteur
qu'il faut étendre.**

## Ce que 4.1 avait laissé ouvert

`affaireVocabulary.ts` (4.1) s'annonçait lui-même comme provisoire : ses cinq
verticaux étaient ceux de l'ancienne segmentation (industrie/BTP, retail,
négoce, services) et **ne recouvraient pas la cible du pivot**. Il disait
attendre 4.2 comme « point d'absorption, pas concurrent ». C'est fait :
`verticalPacks.ts` le remplace et porte désormais l'identité, le libellé et le
vocabulaire de chaque métier.

Conséquence concrète, qui était le vrai défaut : **un paysagiste ou un traiteur
ne pouvait pas se déclarer.** Il n'existait pas dans la liste, l'écran lui
proposait « Autre », et il repartait avec les obligations de personne.

## Dix verticaux, et non cinq

La cible du pivot en compte cinq. Les cinq anciens **restent**, et ce n'est pas
de la timidité :

1. **Ils sont en base.** `tenant_profiles.vertical` porte un `CHECK` : retirer
   une valeur, c'est refuser la prochaine écriture de la fiche d'un tenant qui
   existe — un 500 le jour où il touche à son effectif.
2. **Ils portent des obligations légales.** `information-prix` (Code de la
   consommation, art. L112-1) est rattachée à `retail`/`negoce`. Les supprimer
   retirerait silencieusement une obligation à un commerçant, par effet de bord
   d'une refonte de découpage **commercial**.

Le coût des deux erreurs est asymétrique : un vertical de trop dans une liste
se voit et se corrige, une obligation disparue ne se voit pas.

| Vertical | Libellé | Mot | Cible |
|---|---|---|---|
| `batiment` | Bâtiment / travaux | chantier | ✅ |
| `paysage` | Paysage / espaces verts | chantier | ✅ |
| `evenementiel` | Événementiel / traiteur | événement | ✅ |
| `maintenance` | Maintenance / dépannage | intervention | ✅ |
| `services_projet` | Services au projet | mission | ✅ |
| `industrie_btp` | Industrie / BTP (ancien découpage) | chantier | — |
| `services` | Services (ancien découpage) | mission | — |
| `negoce` | Négoce | affaire | — |
| `retail` | Commerce de détail | affaire | — |
| `autre` | Autre | affaire | — |

`inTarget: false` ne veut dire **ni éteint ni déprécié** : le tenant fonctionne
normalement. C'est une information de cadrage produit, pas une frontière de
sécurité et pas un interrupteur.

### Aucune donnée n'est réécrite

Un tenant `industrie_btp` **reste** `industrie_btp`. Le renommer d'office en
`batiment` aurait été tentant — « industrie ET BTP » recouvre largement
« bâtiment » — mais cela reclasserait un industriel en entreprise de travaux
sans que personne l'ait demandé, **et changerait les obligations qui lui sont
affichées**. Le patron reclassera lui-même s'il le souhaite ; le produit ne
décide pas de son métier à sa place.

## Le mot, et son genre

Le vocabulaire porte l'accord, pas l'écran :

| Champ | Rôle |
|---|---|
| `singular` / `plural` | « chantier », « chantiers » |
| `indefinite` / `definite` | « un événement », « l'événement » |
| `newLabel` | « **Nouvel** événement » — masculin devant voyelle |
| `noneLabel` | « Aucune intervention » |

Un écran qui testerait `singular === "affaire"` pour décider d'ajouter un « e »
réintroduirait une règle de langue dans une feature. « Une événement » devant
un client coûte la crédibilité de tout l'écran, donc le genre vit dans la
donnée.

**Inconnu, vide ou nul → « affaire ».** Le mot neutre est le seul honnête. Ne
jamais deviner à partir du nom de l'entreprise ou de ses pièces : se tromper de
mot devant un client est gratuit et ridicule.

## La décennale suit les travaux, pas la nomenclature

`garantie-decennale` passe de `["industrie_btp"]` à
`["batiment", "paysage", "maintenance", "services_projet", "industrie_btp"]`.

Le sens de l'erreur commande le choix : **ne pas rappeler la décennale à qui la
doit est bien pire que la rappeler à qui ne la doit pas** — son absence est un
délit (code des assurances, art. L243-3), le rappel de trop se lit et s'ignore.
Le texte de l'obligation porte d'ailleurs sa propre nuance (« *dont la
responsabilité décennale **peut** être engagée* »).

**Le critère n'est pas « pose des briques ».** Une première version excluait
`services_projet` au motif qu'il « ne construit pas d'ouvrage » — c'est
exactement le critère que l'art. 1792-1 1° du code civil écarte : est réputé
constructeur « *tout architecte, entrepreneur, **technicien** ou autre personne
liée au maître de l'ouvrage par un contrat de louage d'ouvrage* ». Un maître
d'œuvre, un bureau d'études ou un économiste de la construction doit la
décennale sans toucher une truelle. Le critère retenu est donc le **lien
contractuel avec un maître de l'ouvrage**.

L'incohérence était interne : `maintenance` — le cas le plus discutable des
cinq, la jurisprudence renvoyant souvent les équipements installés sur existant
à la responsabilité contractuelle de droit commun — était inclus au nom de
l'asymétrie, pendant que `services_projet` était exclu au nom d'un critère
que le code civil contredit. Le même raisonnement rendait deux verdicts
opposés.

| Vertical | Décennale | Pourquoi |
|---|---|---|
| `batiment`, `industrie_btp` | ✅ | sans discussion |
| `paysage` | ⚠️ ✅ | murs de soutènement et terrasses sont des ouvrages — mais voir la réserve ci-dessous |
| `maintenance` | ✅ | une intervention en relève dès qu'elle touche à l'ouvrage |
| `services_projet` | ✅ | recouvre maîtrise d'œuvre et bureaux d'études (art. 1792-1 1°) |
| `evenementiel` | ❌ | chapiteaux, scènes et structures démontables ne sont pas des ouvrages |

**Réserve, et elle vaut d'être écrite** : l'item vise l'**assurance**
(C. assur. art. L241-1), dont l'obligation est restreinte par l'**art.
L243-1-1** — voirie, réseaux divers, canalisations et ouvrages d'infrastructure
en sont exclus, sauf s'ils sont accessoires d'un bâtiment. Cela touche
précisément une partie des exemples avancés pour `paysage` : « être un ouvrage
au sens de 1792 » n'est pas « entrer dans l'obligation d'assurance ». On garde
`paysage` — l'asymétrie commande, et un paysagiste qui adosse une terrasse à
une maison est bien dans l'obligation — mais le justificatif ne doit pas se
lire comme une certitude.

De même, `services_projet` recouvre plus que la maîtrise d'œuvre et les
bureaux d'études : conseil, communication, informatique au projet y entrent
aussi. L'inclusion tient par le « **peut** être engagée » du texte, pas par une
applicabilité universelle.

Les verticaux de l'**ancien** découpage ne sont pas re-scopés : `services` y est
un fourre-tout indifférencié (coiffeur et bureau d'études au même endroit), et
rescoper une segmentation qu'on ne propose plus dépasse ce ticket.

Un test itère sur les **dix** verticaux avec le tableau attendu écrit en clair.
La version précédente n'en testait que deux : elle serait restée verte si
`batiment` avait disparu de la règle — sur l'obligation dont l'absence est un
délit. Un scope d'obligation légale se fige valeur par valeur, comme un taux.

## Deux listes, et ce qui les tient ensemble

`VERTICALS` (TypeScript, pour `z.enum`) et le `CHECK` SQL de `tenant_profiles`
sont **dupliqués par nécessité** : le `CHECK` est une défense en profondeur,
il attrape ce qu'un chemin d'écriture oublié laisserait passer.

Un test vérifie leur synchronisation — désormais **en lisant la contrainte
effective de la base** (`pg_get_constraintdef`). La version précédente lisait le
fichier de migration `20260730000000_tenant_profiles` en dur : elle figeait la
*première* définition de la contrainte, donc elle serait devenue rouge à la
première migration qui l'altère, **en accusant le code** alors que la base et le
TypeScript seraient d'accord. Un test qui se trompe de coupable est pire qu'un
test absent.

Dans l'autre sens, `Record<Vertical, VerticalPack>` rend l'oubli impossible à la
compilation : **ajouter un vertical sans lui écrire de pack ne compile pas**.

Et une troisième garde, statique celle-là : tout écran qui construit un
sélecteur de métier doit rendre **les deux groupes**. Une fonction juste ne
sert à rien si un écran n'en rend qu'une moitié — c'est la régression qui a été
commise puis corrigée pendant ce ticket, et ses conséquences sont invisibles à
l'exécution (rien ne casse, une obligation légale devient simplement
inatteignable). `VERTICAL_PACKS_VERSION`, en revanche, n'est lu que par ses
tests : contrairement à la veille réglementaire, aucune réponse d'API ne
l'expose, faute d'un lecteur qui en ferait quelque chose.

## Choisir son métier est dans le SOCLE

Le vertical ne se déclarait que depuis la page **Veille réglementaire** — un
module hors socle, éteint par défaut. Autrement dit : un maçon devait d'abord
rallumer un module qui ne l'intéresse pas pour pouvoir dire qu'il est maçon, et
tout le bénéfice des packs restait inaccessible à l'installation.

D'où `/reglages/metier`, dans le socle. La veille, elle, reste hors socle : ce
qui rejoint le socle, c'est le **choix du métier**, parce qu'il pilote le
vocabulaire de la moitié du produit et les défauts de modules.

Les deux écrans appellent la même route. `headcountOverride` y est facultatif,
donc enregistrer son métier ne touche **pas** l'effectif déclaré dans la veille.

## Ce que ce ticket ne livre pas

**Les briques génériques récurrence / contrats**, et **encaissé ≠ acquis** :
les deux autres blocs de 4.2, chacun son ticket.

**La révision du périmètre d'`information-prix`.** L'art. L112-1 vise aussi les
prestataires de services, donc un traiteur ou un paysagiste chez le particulier
sont concernés — mais le libellé de l'item est rédigé « point de vente »
(« étiquetage, vitrine, rayons »), et l'élargir supposerait de le réécrire.
C'est une lacune de catalogue **antérieure** à ce ticket, pas une régression ;
elle est dite plutôt que corrigée à la va-vite, parce que toucher au texte
d'une obligation légale demande sa propre vérification.

**Des réglages métier au-delà du vocabulaire.** Un pack ne porte aujourd'hui
qu'identité, libellé et mots. La tentation était d'y ajouter des catégories de
coûts par défaut ou des phases-types : rien ne les lit encore, et un champ que
personne ne consomme est un champ qu'on ne peut pas vérifier — il se périme en
silence jusqu'au jour où quelqu'un s'y fie. Ils viendront avec la feature qui
en aura besoin.

**La reclassification assistée** des tenants sur l'ancien découpage. Ils
gardent leur vertical et leur écran ; aucun bandeau ne leur propose de passer à
`batiment` ou `services_projet`. C'est un choix de métier, pas une migration.
