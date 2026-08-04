# Les contrats récurrents

> Une brique **générique** : contrat d'entretien d'un paysagiste, contrat de
> maintenance, forfait mensuel de prestation — c'est la même mécanique. Un
> départ, un pas, une fin éventuelle.

Écrire trois moteurs parce que le vocabulaire diffère, ce serait le
`if (vertical === …)` que l'ADR-007 interdit, déguisé en feature.

## Le moteur est PUR

`packages/shared/src/recurrence.ts` : des dates entrent, des dates sortent.
Zéro base, zéro LLM, **zéro horloge implicite** — `todayIso` est toujours passé
par l'appelant. C'est ce qui permet de tester chaque frontière contre des cas
calculés à la main, et c'est la seule raison d'oser dire à un patron « vous avez
trois passages en retard ».

### Les dates sont des chaînes, jamais des `Date`

Une échéance de contrat est une date **civile** : « le 15 du mois » ne dépend
pas du fuseau de celui qui regarde l'écran. Un `Date` la ferait glisser d'un
jour selon l'heure du serveur — le genre de bug qui ne se voit qu'en
production, un soir d'été. Côté base, les colonnes sont `@db.Date` et les
conversions passent par **midi UTC** : minuit reculerait d'un jour dès qu'un
fuseau négatif entre en jeu.

### L'ancrage est la date de DÉBUT, jamais l'occurrence précédente

Un contrat au 31 janvier donne le 28 février, puis doit revenir au **31** mars.
Un moteur qui itérerait à partir du résultat précédent resterait bloqué au 28
pour toujours : le jour d'ancrage serait perdu au premier mois court. Les deux
comportements — le bornage au dernier jour du mois *et* le retour à l'ancrage —
sont testés, y compris sur un 29 février d'année bissextile.

### Le jour J est DÛ, pas « à venir »

Un passage prévu aujourd'hui est à faire aujourd'hui. Le ranger dans « à venir »
le ferait disparaître du brief le seul jour où il compte.

## Ce que le moteur refuse

| Cas | Réponse |
|---|---|
| pas de date de début | aucune échéance, **motif rendu** — la supposer inventerait des retards |
| début dans le futur | rien de dû, mais `next` est annoncé |
| terme dépassé | `ended: true`, plus rien ne sera dû |
| contrat dormant depuis des années | **tronqué à 24**, et le dit |

**La troncature est dite.** Sans borne, un contrat mensuel oublié depuis six ans
proposerait 72 affaires d'un coup : une file de validation inutilisable et une
base polluée par un clic. Avec une borne muette, le patron croirait avoir tout
rattrapé. Le reste se rattrape au clic suivant plutôt que d'être perdu.

## Matérialiser n'est JAMAIS automatique

C'est le point du ticket. Un générateur de fond qui créerait des chantiers tout
seul remplirait la base de travail que personne n'a décidé de faire, et le
patron découvrirait douze affaires un lundi matin sans savoir d'où elles
viennent. **L'assistant prépare** (le plan est calculé et affiché), **l'humain
valide** (il clique).

`POST /contrats/:id/occurrences` est **idempotent** par `lastOccurrenceDate` :
deux clics ne créent pas deux fois la même intervention. Sans cette borne,
chaque passage du brief re-proposerait les mêmes interventions et le patron
finirait avec douze chantiers pour un seul entretien.

**Et l'idempotence est ATOMIQUE.** La première version lisait le contrat sans
verrou : `withTenant` n'impose aucun niveau d'isolation, donc en READ COMMITTED
deux POST parallèles — un double-clic suffit — lisaient tous deux
`lastOccurrenceDate = null` et matérialisaient *deux fois* les mêmes
interventions. Le test « deux clics » était séquentiel et ne pouvait pas le
voir ; mesuré depuis, sans verrou : **14 affaires au lieu de 7**. Un
`SELECT … FOR UPDATE` sur la ligne du contrat ouvre la transaction, et un test
qui lance vraiment les deux requêtes en parallèle le prouve.

Le curseur **se rembobine à la main** (`PATCH { lastOccurrenceDate: null }`).
Sans ce chemin, une affaire générée par erreur puis archivée ne pouvait plus
jamais être régénérée, et rien ne le disait. C'est une porte volontairement
ouverte : le curseur n'avance jamais tout seul et ne recule jamais tout seul
non plus.

Un contrat `SUSPENDU` ou `TERMINE` répond **409 motivé**, pas 200 avec une liste
vide : suspendre est une décision, et une décision sans effet visible n'en est
pas une. Son plan cesse aussi de compter des retards à l'écran.

## Le montant est PAR PÉRIODE, jamais le total

La borne qui empêche la marge de mentir. Un contrat à 200 €/mois enregistré
comme « 2 400 € » se retrouverait devisé **en entier sur la première
intervention générée** : une marge flatteuse sur un chantier, et onze chantiers
à zéro. *Une marge trop belle est pire qu'une absence de marge.*

Chaque affaire générée porte donc le montant de sa période, et son libellé porte
la **date** (« Entretien Dupont — 2026-07-15 ») : douze affaires au même nom
seraient indiscernables dans une liste, et le patron ne saurait pas laquelle il
vient de faire.

## Le rattachement reste NULLABLE

`affaires.contrat_id` est nullable **sans exception** (règle de structure n°1) :
la grande majorité des affaires n'ont pas de contrat.

La clé étrangère composite `(tenant_id, contrat_id)` porte
`ON DELETE SET NULL ("contrat_id")` — **la liste de colonnes PostgreSQL 15+ est
obligatoire**. Sans elle, `SET NULL` annule *toutes* les colonnes référençantes,
donc aussi `tenant_id`, ce qui sortirait l'affaire de son tenant. Constaté
expérimentalement en 4.1 ; un test de bout en bout vérifie qu'après suppression
d'un contrat, l'affaire survit, détachée, **et toujours dans son tenant**.

## Dans le brief : `attention`, pas `urgent`

Une échéance de contrat non planifiée n'est pas de l'argent qui part
aujourd'hui, c'est un engagement pris qui glisse. En `urgent`, la ligne
concurrencerait une affaire en perte — et un brief où tout est urgent ne
hiérarchise plus rien, donc ne sert plus à rien.

La **date du plus ancien passage** figure dans le libellé : « 3 passages à
planifier » sans date se lit « cette semaine », alors que le plus ancien peut
dater de mars. Zéro échéance ne produit aucune ligne : le brief ne dit que ce
sur quoi il y a quelque chose à faire.

Les contrats échus sont visibles **des membres aussi** : cette ligne ne porte
aucun montant, c'est du planning. La cacher ferait du brief un écran de
dirigeant, alors que le travail, c'est l'équipe qui le fait.

## Autorisations

Même gabarit que les affaires : **lecture ouverte aux membres** (savoir qu'un
passage est dû fait partie du travail de terrain), **écriture réservée au
dirigeant** (le montant par période est une donnée commerciale).

## Une seule horloge civile

Les routes des contrats calculaient « aujourd'hui » avec
`new Date().toISOString().slice(0, 10)` — c'est-à-dire en **UTC** — pendant que
le brief calcule une date civile `Europe/Paris`. Entre minuit et 2 h à Paris,
le brief annonçait donc une échéance due que la liste des contrats et la
matérialisation refusaient encore de voir. `todayCivilIso()` est désormais la
seule horloge du domaine.

De même, une date d'entrée est vérifiée comme **existant au calendrier**, pas
seulement comme ayant la bonne forme : `new Date("2026-02-30")` ne lève pas, il
reporte silencieusement au 2 mars. Un contrat « tous les 30 février » aurait été
accepté puis aurait planifié ses passages en mars.

## Ce que ce bloc ne livre pas

**La proposition automatique en file de validation.** On pourrait déposer une
`pending_action` par échéance due plutôt que d'attendre un clic sur la fiche du
contrat. C'est défendable, mais ça double le nombre de chemins qui créent des
affaires, et il faut d'abord voir si le clic depuis le brief suffit.

**Le prorata et l'indexation.** Un contrat qui démarre en cours de mois, une
revalorisation annuelle indexée : deux règles de facturation qui appellent leurs
propres bornes de justesse, et qui n'ont rien à faire dans un moteur de dates.

**Un chemin d'effacement pour `client_name` et `notes`.** Ce sont des données
personnelles nouvelles, et il n'existe pas de `DELETE /contrats` — cohérent avec
« aucune suppression », mais l'effacement d'un prospect (art. 17) n'anonymise
aujourd'hui que les affaires, pas les contrats, qui ne lui sont pas liés. Un nom
effacé côté prospect peut donc être **réécrit sur une affaire** au prochain clic
de matérialisation. Rattacher un contrat à un prospect fermerait proprement le
trou ; le faire par correspondance de noms serait exactement l'inférence que la
doctrine interdit. **Limite connue, à traiter dans son propre ticket.**

**La migration en deux fichiers.** La convention (et le précédent 4.1) sépare la
création de table de la migration RLS. Ici tout est dans
`20260804110000_contrats` : la RLS est correctement posée et forcée — vérifié en
base — mais la lecture en diff y perd.

**Encaissé ≠ acquis**, le troisième bloc de 4.2 : un contrat encaissé d'avance
n'est pas un contrat exécuté, et c'est exactement le genre de confusion qui rend
une marge trop belle.
