# Rétention de la file de validation (art. 5.1.e)

> Le produit savait effacer une action **décidée** et effacer ce qui dérive
> d'une **source supprimée**. Il ne savait pas quoi faire d'une proposition que
> personne ne décide jamais.

## Le trou, et pourquoi il n'était pas propre à la dictée

Deux mécanismes de réduction existaient déjà :

| Déclencheur | Ce qu'il traite |
|---|---|
| **décision** (`reduceFinishedPayload`, `reduceQuotePayload`) | le contenu sur lequel portait la décision |
| **effacement de la source** (purge FEC, classeur, prospect — art. 17) | ce qui dérive d'une donnée supprimée |

Reste le cas qu'aucun des deux n'attrape : **jamais décidée, source jamais
effacée**. Un brouillon de relance nomme un client et le montant qu'il doit ;
une proposition de devis dictée en porte le **verbatim intégral**. Ces lignes
restaient en base indéfiniment.

La revue de la dictée l'a nommé sur ce type-là, mais le défaut n'a jamais été
propre à la dictée : il vaut pour les dix types d'action, et depuis toujours.
D'où un balayage, et pas une rustine dans le ticket qui l'a révélé.

## Deux règles qui commandent le reste

**1. Rejeter et réduire vont ENSEMBLE.** Réduire une action encore *en attente*
laisserait dans la file une proposition qu'on ne peut plus lire, donc plus
décider — le défaut que F6 a corrigé, sous une autre forme. Le rejet se
justifie aussi sur le fond : approuver une relance calculée sur un impayé
vieux de trois mois enverrait une lettre fausse, la facture ayant pu être
réglée entre-temps. **Une proposition qui dort n'est plus une proposition.**

**2. Un type inconnu n'est JAMAIS détruit.** Même asymétrie qu'en F6 : un outil
livré avant sa ligne de catalogue verrait sinon ses propositions effacées par
une règle qui ne le connaît pas. Il est **signalé** dans le compte rendu du
balayage ; quelqu'un le classe ; la règle s'applique au tour suivant.

## L'âge se compte sur la dernière ACTIVITÉ, jamais sur la création

Deux routes réécrivent une action en la laissant `pending` : la reprise du
brouillon (`PATCH /pending-actions/:id/draft`) et le rattachement à un chantier
(`PATCH /pending-actions/:id/affaire`). Une proposition née il y a six mois
dont le patron a retravaillé le texte hier est **vivante**.

Compter depuis la création l'aurait rejetée « sans décision » — et le balayage
aurait effacé la phrase qu'il venait d'écrire, en l'accusant de ne s'en être
jamais occupé. L'horloge est donc `updatedAt` (`lastActivityAt` côté règle
pure). Pour une action décidée, cette date est postérieure ou égale à la
décision : la borne d'un an ne peut que se déclencher plus tard, jamais plus
tôt.

## Les horizons, et pourquoi ils diffèrent

Ils ne sont pas dans le code mais dans le catalogue versionné
(`pendingActionCatalog.ts`), à côté des groupes d'onglets de F6. **Deux
critères** : la vitesse à laquelle le contenu devient faux, et ce que le
payload porte de personnel. Ils vont en général dans le même sens — quand ils
divergent, **c'est le plus court qui gagne**.

| Groupe | Horizon | Pourquoi |
|---|---|---|
| relances, prospection | 30 j | nominatif, et un impayé bouge vite |
| devis, avis | 60 j | commercialement mort ; le devis porte le verbatim d'une dictée |
| factures électroniques | 60 j | *les deux critères divergent* — voir ci-dessous |
| écritures, stocks | 90 j | comptablement exact plus longtemps |
| immobilisations | 180 j | un montant d'immobilisation ne bouge pas ; libellé de compte seulement |

**Le cas des factures électroniques** est le seul où les deux critères
s'opposent, et la première version s'était trompée en n'en retenant qu'un. Sur
la justesse, 90 jours se défendaient : une obligation déclarative ne se périme
pas comme un impayé. Mais `submit_einvoice` porte une facture client
**complète** — raison sociale, adresse, SIRET, libellés de lignes : après le
devis dicté, le payload le plus bavard de la file. Lui donner l'horizon des
groupes peu nominatifs, c'était justifier le délai le plus long par l'argument
le plus faux. `report_einvoice_transactions` (agrégats seulement) partage
l'onglet, donc l'horizon : un e-reporting non déposé au bout de deux mois est
de toute façon un problème, pas une proposition.

Même correction sur les **écritures** : `book_invoice` porte le client et le
montant, `submit_reconciliation` les libellés bancaires. Ces 90 jours tiennent
à la lenteur avec laquelle le contenu se périme, pas à une prétendue absence de
données personnelles.

Une action **décidée** garde son contenu `DECIDED_RETENTION_DAYS` (un an, soit
un exercice comptable complet), puis le perd — **sans changer de statut**. Qui
a validé quoi, et quand, est une trace définitive ; ce sur quoi la décision
portait ne l'est pas.

## Ce qui survit à une réduction : rien

Le payload réduit vaut `{ reduced, reducedReason, reducedAt }` — même forme que
la réduction de l'article 17, délibérément.

La tentation était d'en garder « ce qui n'identifie personne » : la provenance,
le nombre de lignes. Aucun écran ne les lit — une action réduite est toujours
décidée (rejeter et réduire vont ensemble) et le panneau de détail ne s'ouvre
que sur les actions en attente. **Garder un champ dont personne ne fait rien,
c'est garder une donnée sans finalité**, ce que l'article 5.1.e interdit
précisément.

## Le balayage

En processus, même patron que le sweep push : timer `unref()` (il ne retient
jamais le process), passage non réentrant, chaque rejet attrapé — une tâche de
fond ne doit pas pouvoir tuer l'API.

Trois propriétés non négociables :

- **il passe par `withTenant`, tenant par tenant.** Un seul `updateMany` global
  avec le client admin serait plus court, et serait la seule écriture du
  produit à contourner la RLS — dans le job le moins surveillé. Un test vérifie
  que balayer A ne touche pas B ;
- **un tenant en erreur n'arrête pas les autres**, et l'erreur remonte par son
  **nom** seulement : le message pourrait citer un payload ;
- **il AVANCE** — la propriété que la première version n'avait pas, détaillée
  juste en dessous.

### Pourquoi il pagine par curseur, et pourquoi le SQL est écrit à la main

`pending_actions` ne perd **jamais** de ligne : réduire ne supprime pas. Une
lecture bornée aux *N plus anciennes* se serait donc figée sur une tête de file
faite de lignes déjà réduites et de **types hors catalogue** — ces derniers
gardant leur place à vie, puisque la règle 2 refuse de les détruire. Passé N,
plus rien de neuf n'aurait jamais été examiné : la rétention se serait arrêtée
pour toujours, sans une erreur ni un compteur pour le dire.

D'où un curseur sur `(createdAt, id)` qui avance quoi qu'il arrive — `createdAt`
seul ne suffit pas, un import en crée plusieurs dans la même milliseconde, et un
curseur non strictement ordonné saute des lignes. Un index dédié
`(tenant_id, created_at, id)` sert ce chemin : sans lui, chaque page retrie tout
l'historique du tenant, donc les plus gros arriérés — ceux qui ont le plus
besoin d'être balayés — seraient les premiers à dépasser le délai de
transaction.

Le curseur **seul** ne suffisait pourtant pas : il traverse *un* passage, il
n'empêche pas la famine. Au-delà de `maxPages × pageSize` lignes, chaque
passage aurait re-balayé la même tête. Il faut donc que la tête **rétrécisse**,
d'où l'exclusion des lignes déjà balayées — et c'est ce filtre qui impose du
SQL explicite :

> Les deux formulations Prisma disponibles (`not: true`,
> `NOT: { equals: true }`) produisent une comparaison SQL ordinaire. Sur une
> ligne où la clé est **absente**, `payload->'…'` vaut `NULL`, et
> `NULL <> 'true'` vaut `NULL` : la ligne est écartée. Écartées, elles
> l'étaient **toutes** — exactement celles qu'il fallait traiter. Constaté en
> test : `scanned` tombait à zéro et plus rien n'était jamais réduit.

### Le marqueur est `reducedAt`, pas `reduced`

La nuance porte tout le filet de l'article 5.1.e. `reduced: true` est écrit par
**cinq** endroits, et un seul réduit jusqu'au bout :

| Mécanisme | Ce qu'il laisse |
|---|---|
| `reduceFinishedPayload` (`submit_einvoice`) | `invoiceNumber`, `grossCents`, `currency`, `profile`, `label` |
| `reduceFinishedPayload` (relance prospect) | `prospectId`, `stage` — **y compris après une opposition** |
| `reduceQuotePayload` | `source`, `lines`, `unmatchedCount` |
| `reduceDerivedProposals` (art. 17) | `reducedReason` |
| `rejectProspectDrafts` (2.12) | `prospectId` |
| **ce balayage** | **rien** |

S'exclure sur `reduced` aurait rendu ces résidus **structurellement
inatteignables** : la borne d'un an ne les aurait jamais revus, alors qu'elle
existe précisément pour eux, et le paragraphe « rien ne survit » ci-dessous
aurait été faux. `reducedAt` n'est écrit que par ce balayage : lui seul
s'exclut lui-même, et tout ce qu'un autre mécanisme a laissé derrière repasse
devant la règle.

**Contrepartie, et elle se dit** : une ligne purgée au titre de l'article 17
porte `reducedReason` mais pas `reducedAt`. À un an, le balayage la reprend et
**écrase** « source effacée (purge FEC) » par « décidée il y a N jours… ». La
cause précise du rejet disparaît donc au bout d'un an, ne laissant que le fait.
C'est accepté : à cette échéance la ligne ne porte plus rien, et conserver la
provenance d'une réduction dont il ne reste aucun contenu n'a plus d'objet.

### Ce que la tête ne perd pas

Le filtre fait rétrécir la tête pour les lignes **balayées**, pas pour celles
que la règle ne réduira jamais : types hors catalogue (signalés, jamais
détruits) et actions décidées de moins d'un an. Au-delà de
`RETENTION_MAX_PAGES × RETENTION_PAGE_SIZE` = 50 000 lignes de ce genre chez un
même tenant, rien de plus récent n'est examiné. C'est borné, idempotent, et
**dit** : `truncated` remonte, avec les tenants concernés nommés.

Bénéfice second, qui vaut d'être dit : **le payload n'est plus chargé du tout**.
Le verdict ne dépend que du type, du statut et des dates ; faire transiter des
brouillons nominatifs et des verbatims de dictée par la mémoire d'une tâche de
fond pour n'en lire qu'un booléen, c'était manipuler du contenu sensible sans
finalité. La RLS s'applique identiquement : on est dans `withTenant`, sous
`app_user`.

**Une page = une transaction courte**, avec son propre `timeoutMs`. Le tenant
entier en une seule transaction aurait été la plus longue du produit : elle
aurait dépassé le délai par défaut sur les gros arriérés, et le rollback aurait
annulé le passage *entier* — les tenants les plus en retard auraient été
exactement ceux qu'on ne balaie jamais.

Si la borne de pages est atteinte, une dernière requête vérifie qu'il **reste
vraiment** quelque chose avant de poser `truncated: true` — un tenant dont le
nombre de lignes tombe pile sur la borne est complet, et un avertissement de
famine crié à tort dévalue le seul signal qui compte. Le journal le dit alors
en `warn`, **avec les tenants concernés nommés** : un tenant affamé seulement
compté « quelque part » est signalé mais introuvable, donc jamais réparé.

### Quand il tourne

Il est **inconditionnel**, à la différence du push : une obligation de
conservation limitée ne dépend pas d'une clé VAPID présente. Une installation
qui oublierait de le brancher garderait des brouillons nominatifs pour
toujours, sans que rien ne le signale.

Mais « inconditionnel » ne veut rien dire si le premier passage n'a lieu qu'au
bout de 24 heures : une API redéployée plus souvent que ça — le cas normal en
phase de livraison — n'aurait jamais balayé une seule fois. D'où un **passage
au démarrage** (30 s après le boot, pour ne pas lui disputer le démarrage), en
plus du timer. Le refaire à chaque démarrage ne coûte qu'une lecture : le
passage est idempotent, une action déjà réduite rend « garder ».

### Ce qu'il écrit, et ce qu'il n'écrase pas

**Ce qui est fait est DIT** : chaque passage journalise ses compteurs (dont le
nombre de lignes *examinées*, dénominateur des deux autres, et le nombre de
tenants en **échec**) et les types non classés — jamais un payload. Un balayage
qui rejette cent propositions en silence serait indistinguable d'une perte de
données.

Un passage qui n'a rien fait ne se journalise pas — **sauf s'il a échoué
quelque part**. Un échec muet et un tenant propre se ressemblent trop : sans le
compteur `failed`, un tenant dont la rétention tombe à chaque passage resterait
indiscernable d'un tenant à jour, indéfiniment. L'erreur remonte avec son nom
**et l'identifiant du tenant** (un UUID opaque, pas une donnée) : sans lui,
l'échec est visible mais le coupable introuvable, donc jamais réparé.

Écriture **conditionnelle sur ce qui a été lu — statut ET `updatedAt`**. Le
statut seul ne suffisait pas : les deux routes de reprise citées plus haut
écrivent en laissant `pending`, donc une reprise arrivée entre la lecture et
l'écriture serait passée à travers le filtre et le balayage aurait écrasé le
texte tout juste enregistré. `updatedAt` bouge à chacune de ces écritures :
le comparer rend la course visible, et **le clic humain gagne**.

Cette propriété est **éprouvée**, pas seulement affirmée. La lecture d'une page
ne pose aucun verrou (`SELECT` sans `FOR UPDATE`), donc la course est réelle :
un point d'interception réservé au test (`onPageRead`, jamais passé en
production) laisse une écriture concurrente, sur une autre connexion, se
valider entre la lecture et l'écriture. Vérifié dans les deux sens — en
remplaçant la garde par `where: { id }`, ce test, et lui seul, échoue.

## À l'écran : « Rejetée automatiquement », pas « Rejetée »

Un rejet machine laisse `validatedBy` nul — une décision humaine le renseigne
toujours. L'historique de la file lit ce champ et écrit **Rejetée
automatiquement**, avec « sans décision humaine » en guise de date.

Sans ça, le dirigeant voyait « Rejetée » sur un dossier qu'il n'a jamais
ouvert : on lui faisait porter un refus qu'il n'a pas prononcé, et on lui
laissait croire qu'il avait tranché.

**Le libellé ne nomme pas la cause, et c'est délibéré.** Trois chemins rejettent
sans validateur : la rétention (ce ticket), la purge d'une source (art. 17) et
l'opposition d'un prospect (2.12). Une première version écrivait « Expirée » sur
les trois — elle remplaçait un mensonge par un autre. La cause vient du
**motif**, que l'API expose désormais à côté du statut :

| | |
|---|---|
| exposé | `reducedReason` — **owner seulement, sur l'historique seulement** |
| jamais exposé | le payload ; `payload` n'est même pas dans le `select`, Postgres projette le seul champ utile |
| motifs possibles | phrases figées côté serveur (« source effacée (purge FEC) », « sans décision ni reprise depuis N jours… ») — aucun contenu client |

Deux détails de forme qui sont des décisions :

- **le champ est ABSENT pour un non-owner**, pas nul. `reducedReason: null` se
  lit « aucun motif, donc rien n'a été retiré » — faux, là où la vraie réponse
  est « pas de votre ressort » ;
- **pas de booléen `reduced` à côté.** Une première version en exposait un que
  l'écran ne lisait jamais : le « champ dont personne ne fait rien » que ce
  ticket refuse par ailleurs.

Et surtout, `payload` **n'est plus sélectionné du tout**. La première version
le chargeait pour l'owner — jusqu'à 550 payloads complets, brouillons
nominatifs et verbatims de dictée compris, à chaque ouverture de la file, pour
n'en lire qu'une phrase. C'est mot pour mot ce que le balayage refuse de faire ;
l'argument ne vaut pas moins sur le chemin chaud de l'API.

`rejectProspectDrafts` (2.12) n'écrit pas de motif : sa ligne est alors dite
réduite **sans motif**, plutôt que de lui en inventer un. Lui en donner un est
un correctif qui appartient à son ticket, pas à celui-ci.

## Ce que ce ticket ne livre pas

**Le réglage par tenant.** Les horizons sont les mêmes pour tous. Un artisan
qui voudrait garder ses devis six mois n'a pas de bouton. C'est délibéré :
proposer un réglage de rétention, c'est proposer de l'allonger, et il faudrait
alors une borne haute, une justification par finalité et un écran qui les
explique. Le défaut doit d'abord être juste.

**La purge des `agent_conversations`**, toujours ouverte : les transcriptions
de l'employé virtuel peuvent citer un chiffre du journal ou un nom, et aucun
mécanisme ne les atteint. Autre nature, autre ticket.

**Un test de l'ordonnanceur.** `startRetentionSweep` balaie **tous** les
tenants : l'éprouver dans la base de test mutilerait les fixtures des autres
suites. Même raison qu'en 2.17, où `startPushSweep` n'a pas de test non plus.
Ce qui est testé, c'est `sweepTenantRetention` — la totalité de la logique de
rétention ; restent donc sans filet le passage au démarrage, la non-réentrance,
l'agrégation de `truncatedTenants` et « un tenant en erreur n'arrête pas les
autres ». C'est le chemin par lequel la rétention existe en production, et le
dire vaut mieux que le laisser croire couvert.

**Un verrou entre instances.** Le balayage démarre dans **chaque** instance
d'API, comme le sweep push. Les écritures restent sûres (la garde
conditionnelle rend le second passage sans effet), mais N instances multiplient
les lectures et les lignes de journal. Une élection ou un verrou consultatif
attendra qu'il y ait plus d'une instance.

**Un identifiant de dépôt survivant à la réduction d'un `submit_einvoice`.**
Après réduction, plus rien ne dit *quelle* facture a été abandonnée. Conserver
le numéro serait défendable — c'est un identifiant, pas une donnée personnelle
— mais aucun écran ne le lirait aujourd'hui, et rouvrir une exception au « rien
ne survit » pour une donnée sans lecteur est exactement ce que la section
ci-dessus refuse. À reprendre le jour où un écran en a l'usage.

**La fraîcheur des écrans après un passage.** Le bus d'invalidation
(`fraicheur-donnees.md`) vit dans le navigateur : une tâche de fond côté
serveur ne peut pas le déclencher. Un onglet de validation resté ouvert
pendant un balayage montre son ancienne liste jusqu'au prochain chargement.
Conséquence bornée — le balayage ne touche que des actions sans activité depuis
un mois au moins, donc jamais celle que quelqu'un est en train de lire — mais
elle est réelle, et la refermer suppose un canal serveur → client que le
produit n'a pas.
