# Import FEC — le connecteur fichier universel (ticket 2.14)

Le FEC (Fichier des Écritures Comptables, art. A47 A-1 du LPF) est le format
que **tout logiciel de comptabilité français doit savoir exporter**. L'importer
dans nodaq peuple le cockpit et l'employé Compta avec les **vraies créances**
d'une entreprise — sans connecteur, sans OAuth : un cabinet exporte le FEC d'un
dossier en 2 minutes, nodaq montre ses impayés dans la foulée.

## Utilisation

/connecteurs → carte **« Import FEC »** → choisir le fichier (`.txt`, tabulation
ou « | », 50 Mo max). Réservé au rôle **owner**. Le rapport affiche : écritures
analysées, clients, factures, impayés (nombre + montant), avertissements.

- **Idempotent** : ré-importer le même fichier (même empreinte SHA-256) ne
  change rien et le signale.
- **Remplacement** : un fichier différent remplace intégralement l'import
  précédent (les factures dérivées sont re-calculées de zéro).
- **Rejet franc** : un FEC invalide (en-tête non conforme, dates/montants
  malformés, déséquilibre débit/crédit) est refusé en bloc avec un rapport
  ligne à ligne — jamais d'ingestion partielle.

## Ce qui est dérivé (`packages/fec`)

- Comptes clients **411** + compte auxiliaire → clients.
- Débits 411 groupés par **PieceRef** → factures (les crédits de la même pièce
  = règlements partiels).
- **Lettrage** (`EcritureLet`) → facture soldée. Non lettrée + **échéance
  estimée** (date de pièce + 30 j — le FEC ne contient pas l'échéance réelle)
  strictement dépassée → **impayé**.
- Les factures dérivées sont servies à l'employé Compta et au cockpit via
  l'interface Pennylane existante (repli automatique du registre quand aucun
  Pennylane n'est connecté) : relances, scoring et validation fonctionnent
  sans modification.

## Confidentialité (données `confidentiel` par nature)

- Le fichier est parsé **en mémoire** ; **le brut n'est pas conservé** (V1,
  minimisation) — seule son empreinte SHA-256 sert l'idempotence.
  L'archivage Object Storage fr-par viendra avec l'infra bucket dédiée.
- **Aucune ligne du journal** n'apparaît dans les logs, les erreurs ou les
  réponses API — uniquement des compteurs, des numéros de ligne et des
  messages génériques.
- Tables `fec_imports`/`fec_invoices` : `tenantId` + RLS + tests d'isolation.
- Le badge connecteur affiche « importé » (statut `file`) — jamais
  « connecté » : rien n'est branché.
- **Conservation / effacement (art. 17)** : les données dérivées vivent
  jusqu'au prochain import (remplacement intégral) ou jusqu'à suppression
  explicite — bouton « Supprimer les données importées » de la carte
  (`DELETE /connectors/fec`, owner), qui purge imports, factures dérivées et
  connecteur fichier.

## À ne pas faire

- Générer un FEC (jamais notre rôle) ou l'utiliser comme import comptable
  complet : seule la dérivation créances clients est couverte (V1).
- Poser le statut connecteur `file` ailleurs que via l'endpoint d'import.

## Retenue de garantie — jamais un impayé (US-8, ticket 2.20)

Dans le bâtiment, le client retient contractuellement 5 % du marché jusqu'à la
levée des réserves, souvent un an après la réception. **Ce n'est pas un
impayé** : c'est une somme non encore exigible, prévue au contrat.

Comptablement, la retenue vit au **4117 « Clients — Retenues de garantie »**.
Or `4117` est une **subdivision de `411`** — et la dérivation des créances
filtrait sur le préfixe `411`. La retenue était donc :

1. agrégée à la facture, ce qui **gonflait le montant facturé** de 5 % ;
2. non lettrée jusqu'à la libération, ce qui laissait la facture **ouverte** ;
3. comptée dans `overdueCents`, donc **candidate à une relance**.

Relancer un bon client sur sa retenue de garantie est la faute qui coûte le
plus cher en crédibilité devant un artisan : elle prouve en une phrase que
l'outil ne connaît pas son métier.

### Ce qui a changé

`classifyReceivableAccount` (config versionnée datée sourcée PCG,
`packages/shared/src/receivableAccounts.ts`) sépare désormais trois natures :
`retenue` (4117), `client` (411), `hors_clients`. Le préfixe le plus long
l'emporte — sinon la retenue redevient une créance ordinaire.

| Grandeur | Contenu |
|---|---|
| `amountCents` | montant du **marché**, sous les deux conventions de comptabilisation (voir ci-dessous) |
| `residualCents` | part **exigible** restant due, retenue **exclue** |
| `retainedCents` | la retenue elle-même — conservée, jamais effacée |
| `settled` | jugé sur les seules lignes **exigibles** : la retenue, non lettrée par nature, ne peut plus à elle seule faire passer une facture réglée pour ouverte |

`overdueCents` et `overdueCount` excluent la retenue, donc le statut renvoyé
par l'interface facturier est `paid` — et c'est ce statut qui décide d'une
proposition de relance.

### Deux conventions, un seul montant facturé

La retenue se comptabilise de deux façons, toutes deux courantes :

- **a) par transfert** — la facture débite `411` de 10 000, puis une OD crédite
  `411` de 500 et débite `4117` de 500. La retenue est **carvée** du débit :
  l'additionner compterait les 5 % deux fois.
- **b) directement** — la facture débite `411` de 9 500 **et** `4117` de 500
  dans la **même écriture**, face au `706`. Il n'y a rien à carver : ne
  sommer que les débits `411` ampute le montant facturé de la retenue, donc le
  CA (2.11/3.1) et le dénominateur de la marge (2.8) — et l'aval déduit alors
  la retenue une **seconde** fois, ce qui efface une créance réelle. C'est
  exactement l'erreur que ce ticket corrige, à l'envers.

Le discriminant est l'**écriture**, pas la pièce : au sein d'une même écriture,
la contrepartie du débit `4117` est-elle un crédit client **du même montant** ?
Oui ⇒ transfert (déjà carvé). Non ⇒ comptabilisation directe, le débit `4117`
fait partie du facturé. `amountCents` vaut 10 000 € dans les deux cas.

Le montant, et pas seulement la présence d'un crédit : une écriture de vente
peut porter un escompte au crédit du client, qu'il ne faut pas prendre pour un
transfert. **Limite assumée** : un acompte imputé du **même montant** que la
retenue est, lui, indiscernable d'un transfert — le montant facturé est alors
sous-évalué de la retenue (le solde exigible, lui, reste juste). L'erreur va
dans la direction prudente : elle minore le CA et la marge, elle ne les
embellit pas.

### La garde ne s'arrête pas au FEC

Sortir la retenue du solde ne suffit pas : sur un chantier **non réglé**, la
facture reste bien en retard — mais pour l'exigible seulement. L'interface
facturier porte donc deux champs **à côté** de `amount` (le montant du marché,
qui fait le CA et ne doit pas être réécrit) : `retained_amount` et
`residual_amount`, le solde restant dû **déjà net** de la retenue et des
règlements partiels. Quand ce solde est connu, il fait foi — sans lui, une
relance repart du montant facturé et réclame une somme déjà encaissée (une
facture réglée mais **non lettrée** reste `pending` chez le facturier, cas
fréquent en PME). Et le redéduire de la retenue compterait les 5 % deux fois.
Une seule fonction en tire les conséquences, `claimableCents`
(`mcp-servers/actions/src/salesForecast.ts`, à côté de `normalizeSaleInvoice`
pour la même raison : deux écrans qui trancheraient séparément réclameraient
10 000 € ici et 9 500 € là pour la même facture) :

- **`draft_dunning`** ne réclame que l'exigible ; le brouillon est rédigé sur ce
  montant, la file affiche les trois chiffres (réclamé / facturé / retenu), et
  une facture dont le solde n'est **que** de la retenue provoque un **refus
  motivé** — jamais une relance à 0 € qu'un humain validerait sans comprendre.
- **Rapport mensuel (2.11)** : l'encours échu se compte sur l'exigible. Compter
  la retenue ferait monter « les impayés » sans qu'un seul client soit en
  retard, et la règle `impayes_en_hausse` pousserait à relancer là-dessus. Une
  facture échue dont il ne reste rien à réclamer sort de l'encours **et le
  dit** (`overdueNotClaimableCount`) : un retrait muet est une donnée qui
  disparaît.

Le chiffre d'affaires, lui, garde le montant du marché : c'est bien ce qui a
été facturé.

### Le total est un SOLDE, pas une somme de factures

Une libération se comptabilise souvent sous sa **propre** pièce (`débit 512 /
crédit 4117`) : elle n'est rattachable à aucune facture. Additionner les
retenues portées par les factures continuerait donc d'annoncer « X € de retenue
en cours » sur des sommes **déjà encaissées**.

Le total affiché est le **solde du compte 4117**, planché à zéro par seau de
solde. Un solde n'a rien à rattacher : il est juste par construction, quelle
que soit la pièce sous laquelle la libération a été passée. Seules les lignes
que la dérivation a **reconnues** comme retenue y entrent — une ligne `4117`
laissée en créance ordinaire est déjà comptée dans les impayés, l'ajouter ici
l'annoncerait une seconde fois.

Seules les lignes **reconnues** comme retenue y entrent — plus les mouvements de
**sortie** du même compte, qui sont alors des libérations. Un débit non reconnu,
lui, est déjà compté dans les impayés : l'ajouter ici annoncerait la même somme
deux fois, en créance et en retenue.

L'écran n'affiche **pas** de nombre de factures concernées : une libération
comptabilisée sous une autre pièce n'étant rattachable à aucune facture,
« 1 000 € en cours (2 factures) » pourrait compter une facture dont la retenue
est déjà encaissée. Le solde, lui, est juste — il reste la seule vérité
affichée, et le **fait** qu'une retenue soit en cours est dit à tout membre
(le montant reste owner-only).

Le seau est le **compte auxiliaire** quand la comptabilité en tient un : un
client sur-libéré ne masque alors pas la retenue d'un autre. **Sans
auxiliaire**, toutes les retenues vivent sur le même compte, le seau est unique
et une libération excessive peut y compenser la retenue d'un autre client :
c'est une limite du plan comptable, et elle est **dite** (avertissement dédié,
émis seulement quand le risque est réel — plusieurs pièces *et* une libération)
plutôt que promise résolue.

La colonne par facture reste, elle, ce qu'elle dit : la retenue **constatée sur
cette pièce**. Une libération comptabilisée séparément n'y est pas déduite —
c'est pourquoi la mesure du cockpit s'appelle `retenue_constatee_sur_la_facture`
et porte cette limite dans son libellé.

Une libération non encaissée rend la somme **exigible**. Quand elle est
comptabilisée sous sa propre pièce, cette pièce sort avec un **montant facturé
nul** (ce n'est pas une vente, elle n'entre donc pas au CA) mais un solde
restant dû, à **sa** date d'échéance.

La reverser dans la facture d'origine paraissait plus propre — sauf qu'une
facture ne porte qu'**une** échéance : la somme libérée héritait de celle de la
facture, et une levée de juillet ressortait « en retard de 146 jours » à
l'instant même de son enregistrement. Relancer un bon client sur une somme
exigible depuis quatre jours, c'est la faute du ticket un cran plus loin.

La relance sait la réclamer parce qu'elle juge la lisibilité sur le **solde
restant dû**, pas sur le montant facturé. Le rapport mensuel (2.11) la compte
dans son **encours** du mois de **sa** date — jamais au CA : une écriture peut
n'être pas une vente et porter quand même un solde exigible. L'en écarter
faisait dire deux chiffres d'impayés différents au rapport et au connecteur
pour la même donnée, et la rangeait à l'écran parmi les brouillons et les
avoirs. Le mois de **référence** est nourri par le même chemin : le nourrir
d'un côté seulement sous-évaluerait la référence, gonflerait la hausse et
déclencherait `impayes_en_hausse` sur un artefact comptable — c'est-à-dire
pousserait à relancer, ce que ce ticket ferme.

Le montant doit être **nul**, pas seulement « non positif » : un avoir ne
devient pas un impayé parce qu'il porterait un solde.

Une libération saisie **sans auxiliaire** alors que la retenue en portait un
tomberait dans un autre seau et ne compenserait jamais : quand le compte de
retenue n'a qu'**un seul** tiers reconnu, la sortie lui revient (une seule
candidate n'est pas une supposition). Sinon elle est écartée du solde, et c'est
dit — le total peut alors être surévalué d'autant.

### Ce que le produit ne prétend pas savoir

La **date de libération** est contractuelle : elle n'existe nulle part dans un
FEC. Le produit ne l'invente pas (`releaseDateKnown: false`) ; la saisir est un
ticket à part. Une retenue est donc affichée pour son montant et son nombre,
sans échéance — dire « libérable le … » sans le savoir serait exactement le
genre d'affirmation que le reste du produit s'interdit.

Une retenue **négative** est refusée en base (CHECK) : elle signalerait une
libération sur-comptabilisée, qui doit être vue et non absorbée en silence.
Dans la dérivation, elle est ramenée à zéro **et comptée dans un
avertissement** — la ramener en silence contredirait la garde annoncée.

### Une reconnaissance qui refuse de deviner

Le préfixe `4117` ne suffit pas à lui seul. Sous le schéma courant
« 411 + code client », le client n° 70003 porte le compte `41170003`,
**indiscernable** d'un `4117` + code : classer ses créances en « retenue » les
sortirait des impayés, et un vrai dû disparaîtrait en silence — pire que la
relance abusive qu'on corrige.

Une retenue n'est donc reconnue que si la pièce porte **aussi une créance
ordinaire au débit**, dont elle a pu être carvée. Le débit, et pas la simple
présence d'une ligne 411 : quand l'OD de transfert porte sa **propre**
référence de pièce (convention fréquente), le groupe ne contient que la
contrepartie au crédit — il n'y a là aucune facture à alléger.

Quand la pièce ne porte **aucune** ligne `411` ordinaire, deux situations sont
**indiscernables** : un plan « 411 + code client » (le client n° 70003 porte le
compte `41170003`, il n'y a aucune retenue) ou une vraie retenue orpheline.
L'avertissement dit donc le **fait** et sa **conséquence** — la ligne est
traitée comme une créance ordinaire, rien n'est déduit des impayés — sans
trancher la cause. Un diagnostic inventé, répété à chaque pièce, use la
confiance aussi sûrement qu'un chiffre faux.

### Sans comptabilité auxiliaire : la limite, plutôt que la devinette

Sans **compte auxiliaire**, la facture vit au `411000` et sa retenue au
`411700` : deux « clients » pour la clé de regroupement (client, pièce), une
seule facture pour l'artisan. La retenue y forme donc une pièce à part, comptée
en créance ordinaire.

Trois versions successives ont tenté de reverser cette pièce dans la facture de
la même référence. **Chacune a été prise en défaut sur un montage réel**, et
toujours dans le même sens : une créance disparaissait, ou changeait de client.
Sous un plan « 411 + code client », rien ne distingue structurellement le compte
`41170003` du client n° 70003 d'un compte de retenue `411700` + code — ni le
préfixe, ni la forme de l'écriture, ni la contrepartie.

L'inférence elle-même est le défaut. Le coût des deux erreurs n'est **pas
symétrique** :

| Erreur | Conséquence |
|---|---|
| ne pas reconnaître une retenue | elle reste dans les impayés — le défaut d'origine, **visible et signalé** |
| la reconnaître à tort | un dû réel disparaît et change de client — **muet**, et faux dans les comptes |

Une retenue n'est donc reconnue que **dans** un regroupement (client, pièce), où
l'identité du tiers est acquise par construction. Sans auxiliaire, la retenue
reste une créance ordinaire — comme avant le ticket — et l'avertissement le dit.

**Limite assumée, et dite.** Quand le transfert porte sa propre référence et
qu'aucun rattachement par pièce n'est possible, la retenue n'est rattachable à
aucune facture : elle reste comptée comme une créance ordinaire, exactement
comme avant le correctif. Le produit ne fait pas semblant — l'import
émet un avertissement nominatif (« N écriture(s) 4117 non rattachée(s) … —
retenue NON déduite des impayés »), et l'écran Connecteurs affiche désormais le
**texte** des avertissements, pas seulement leur nombre : une limite qui change
le chiffre affiché n'a aucune raison d'être invisible. Le rattachement
inter-pièces est un ticket à part.
