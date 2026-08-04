# Encaissé ≠ acquis

> Le solde du compte n'est pas du résultat. Le devis signé non plus.

**Quatre chiffres**, dont deux encaissés qui ne s'additionnent pas. Ils se
ressemblent sur un relevé bancaire et ne disent pas du tout la même chose :

| | Ce que c'est | Base |
|---|---|---|
| **encaissé — factures réglées** | facturé − résiduel − **retenue encore détenue** | **TTC** |
| **encaissé — acomptes déclarés** | ce que le dirigeant a saisi sur la fiche | **TTC** |
| **engagé** | du travail **vendu**, pas encore livré | HT |
| **acquis** | du travail **livré** — le seul qui a produit du résultat | HT |

Beaucoup de patrons de TPE jugent leur santé au solde. Un acompte de 30 % sur
un chantier qui n'a pas commencé s'y lit comme du bénéfice, et une partie de ce
solde n'appartient même pas à l'entreprise : c'est la TVA.

## Ce que le bloc 2 a rendu facile à rater

Matérialiser douze passages d'un contrat d'entretien crée **douze affaires
devisées d'un coup**. Sommées naïvement, elles font apparaître une année de
chiffre d'affaires le jour du clic — et une marge globale flatteuse sur du
travail qui n'a pas commencé.

*Une marge trop belle est pire qu'une absence de marge.* C'est la raison d'être
de ce bloc, et la raison pour laquelle il vient juste après.

## Deux encaissés, jamais additionnés

C'est le défaut le plus grave que la revue a trouvé, et il allait dans la
direction flatteuse. Dans le bâtiment, une **facture d'acompte** est à la fois
une pièce du FEC réglée à 100 % **et** un acompte que le dirigeant déclare sur
la fiche. Les sommer fait 7 200 € là où 3 600 € sont rentrés.

Rien ne permet de les rapprocher : une déclaration d'acompte ne porte aucun
lien vers la pièce comptable correspondante. On refuse donc de sommer, et
l'écran le dit — c'est la seule réponse honnête tant que le lien n'existe pas.

### La retenue de garantie n'est pas encaissée

`residualCents` **exclut** la retenue par construction (la dérivation FEC la
sort du reste dû), donc `facturé − résiduel` la *contient*. Une facture de
10 000 € avec 500 € de retenue ressortait à 10 000 € encaissés le jour où le
client en versait 9 500 : de l'argent retenu apparaissait sur le compte alors
qu'il n'y est pas.

Mais soustraire `fec_invoices.retained_cents` **ligne à ligne** est faux aussi,
et c'est le piège que le ticket 2.20 avait déjà tranché : cette colonne porte
« la retenue de CETTE pièce », pas la retenue encore due. Une libération se
comptabilise souvent sous sa **propre** pièce, et la facture d'origine garde
son `retained_cents` à vie — les 500 € seraient amputés pour toujours, même une
fois versés.

On soustrait donc le **solde du compte 4117**, déjà calculé et stocké sur
l'import (`fec_imports.retained_cents`) exactement pour cette raison : un solde
n'a rien à rattacher, il est juste par construction.

### Aucun FEC importé ⇒ `null`, pas zéro

« 0 € de factures réglées » à côté d'un acquis non nul se lit « rien n'est
rentré », alors que la vraie réponse est « je n'ai pas de source comptable ».
L'écran affiche « — · aucun FEC importé ».

### Le réglé est agrégé sur TOUT le tenant

Pas seulement sur les factures rattachées à une affaire : le rattachement est
nullable et son absence est le cas **majoritaire**. N'agréger que les factures
rattachées afficherait « encaissé » sur une fraction de l'encaissé, sous un
libellé qui promet le compte en banque.

## Le moteur refuse de calculer un écart

`splitRevenus` ne rend **aucune** différence entre l'encaissé et l'acquis, et
ce n'est pas un oubli. L'un est du TTC, l'autre du HT : leur soustraction
vaudrait à peu près la TVA, c'est-à-dire de l'argent qui n'est pas à
l'entreprise. Un « reste à encaisser » calculé ainsi ferait **arrêter de
facturer trop tôt** — le même piège que `invoicedBasis` ferme déjà dans le
calcul de marge.

Les deux bases voyagent donc **avec** les chiffres (`acquisBasis: "ht"`,
`encaisseBasis: "ttc"`), jusque dans le type TypeScript côté web. Un écran qui
voudrait les soustraire doit le décider explicitement ; il ne peut pas le faire
par distraction.

## Où passe la frontière entre engagé et acquis

| Statut | Compte comme |
|---|---|
| `TERMINEE` | **acquis** |
| `ACCEPTEE`, `EN_COURS` | **engagé** |
| `PROSPECT`, `DEVIS_ENVOYE` | ni l'un ni l'autre — rien n'est signé |
| `ARCHIVEE` **avec date de fin réelle** | **acquis** — ranger n'est pas défaire |
| `PERDUE`, `ARCHIVEE` sans date de fin | nulle part |

**Pas de prorata**, et c'est délibéré. On pourrait vouloir dire « ce chantier
est à moitié fait, donc la moitié est acquise » — mais rien dans le produit ne
sait où en est un chantier : il n'existe pas de lignes de temps, et
l'avancement n'est pas saisi. Un pourcentage inventé serait exactement le
chiffre flatteur que ce moteur existe pour empêcher.

**Archiver fait baisser le chiffre acquis, et c'est une sous-estimation
ASSUMÉE.** `status` est une colonne unique : ranger une affaire terminée écrase
`TERMINEE`, donc son montant sort de l'acquis.

Le rattrapage par `actualEndDate` a été implémenté **puis retiré**. Ce champ est
libre, et `POST /affaires/:id/archiver` accepte n'importe quel statut de départ
— `PERDUE` compris. Une affaire abandonnée dont quelqu'un a saisi la date
d'arrêt aurait alors compté à **100 % du devis** en acquis : une sur-estimation
invisible et flatteuse, exactement ce que ce module existe pour interdire.

*Jamais d'inférence quand le coût des deux erreurs est asymétrique* : entre une
sous-estimation qui se voit et une sur-estimation qui ne se voit pas, on garde
la première. Le vrai remède est une colonne `completedAt` posée à la transition
vers `TERMINEE` — un fait, pas une déduction. **C'est le prochain ticket de ce
domaine.**

**L'encaissé déclaré, lui, est compté quel que soit le statut** : un acompte reçu sur
une affaire finalement perdue est quand même sur le compte. C'est précisément
la différence entre « ce que j'ai » et « ce que j'ai gagné ».

## Ce qui n'est pas calculé est DIT

- **`sansDevis`** : une affaire signée sans montant devisé a une valeur de
  travail inconnue. La compter zéro donnerait un acquis sous-estimé **présenté
  comme exact**, sans que personne sache de combien il manque. Elle est donc
  comptée à part, et `exact` passe à `false`.
- **`ignorees`** : au-delà de la borne de lecture, les affaires non examinées
  sont annoncées plutôt que silencieusement absentes — **et `exact` tombe**.
  La borne est généreuse à dessein : la troncature sacrifierait d'abord
  l'acquis, puisque les affaires terminées sont les plus anciennes, donc les
  premières coupées par un tri décroissant sur la création.
- **Module `affaires` éteint** ⇒ `409` motivé, jamais un zéro. « 0 € gagné »
  rendu sur un module éteint se lirait comme une mauvaise année.

## Une requête distincte de celle des marges

`loadAffairesMargins` ne lit que les affaires **ouvertes** (`EN_COURS`,
`ACCEPTEE`). Réutiliser sa requête aurait donné un acquis **structurellement
nul** — un chiffre faux qui ne se serait jamais fait remarquer, puisqu'il
aurait eu l'air d'un démarrage tranquille. `loadRevenusSplit` charge donc **tous** les
statuts — y compris `PERDUE`, pour que l'acompte non remboursé d'une affaire
abandonnée reste compté dans l'encaissé déclaré — avec sa propre borne.

## Autorisations

`GET /affaires/revenus` est **owner only**, comme tout agrégat financier du
tenant (prévision de trésorerie, page marge, `/affaires/marges`).

## Ce que ce bloc ne livre pas

**La reconnaissance du revenu à l'avancement.** Ce serait la bonne réponse
comptable pour un chantier long, et elle est hors de portée tant que
l'avancement n'est pas une donnée saisie ou dérivable. Le jour où elle
existera, la frontière `TERMINEE` deviendra un cas particulier de la règle
générale — pas une exception à retirer.

**Le rapprochement de l'encaissé avec la banque.** L'encaissé se déduit
aujourd'hui des acomptes déclarés et du résiduel des factures FEC. Les
transactions bancaires ne sont pas stockées (elles vivent chez Qonto/Bridge),
donc « encaissé » veut dire « ce que la compta dit encaissé », pas « ce que le
compte montre ». La nuance mérite d'être écrite le jour où un écran prétendra
autre chose.

**Le rattachement d'un acompte déclaré à sa facture.** C'est ce qui permettrait
de rendre un seul chiffre d'encaissé au lieu de deux. Il faudrait un lien
explicite saisi ou dérivé — et le dériver par correspondance de montants serait
exactement l'inférence que la doctrine interdit.

**L'acquis vaut le DEVIS, jamais le facturé.** Une affaire terminée avec
avenants, facturée 12 000 € pour un devis de 10 000 €, rend 10 000 €
d'acquis. Choix déterministe : le devis est la seule valeur du travail que le
produit connaisse de façon certaine.

**Les avoirs et remboursements.** Un avoir lettré sur la même pièce annule son
résiduel, si bien que la facture ressort **intégralement encaissée** : de
l'argent rendu au client reste compté comme rentré.

**La TVA.** Elle n'est ni calculée ni déduite : elle est simplement la raison
pour laquelle les deux bases ne se soustraient pas. Un jour où le produit
saura le taux réel de chaque pièce, un « encaissé HT » deviendra calculable —
jusque-là, l'inventer serait un chiffre faux.
