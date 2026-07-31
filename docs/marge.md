# Marge (ticket 2.8)

Combien reste-t-il une fois les charges payées ? La question que tout gérant
pose — et la plus facile à mal répondre.

## Le ticket que 2.11 avait refusé de faire à moitié

Le rapport mensuel écartait explicitement la marge, en disant pourquoi :
« une marge calculée sur une partie des charges serait fausse dans le sens
rassurant ». C'est le problème que ce ticket devait résoudre, pas contourner.

Le danger est **asymétrique**. Une charge oubliée ne déplace pas la marge au
hasard : elle la fait toujours paraître **meilleure** qu'elle n'est. Un gérant
qui lit « marge 42 % » alors qu'elle est à 18 % embauche, baisse ses prix,
s'engage — et découvre l'écart des mois plus tard, quand il est cher à
corriger.

D'où la règle du module :

> **Une base de charges incomplète ne produit pas un chiffre.
> Elle produit une BORNE SUPÉRIEURE.**
>
> « Votre marge est **au plus** de 42 % — deux postes ne sont pas renseignés. »

C'est mathématiquement vrai (les charges manquantes ne peuvent que réduire la
marge) et impossible à confondre avec un résultat complet.

La garantie est portée par une **union discriminée** : `marginRatio` n'existe
que sur un niveau `complete`, `maxMarginRatio` sur un niveau
`borne_superieure`. Un consommateur — écran ou modèle — ne peut donc pas
afficher un point là où il n'y a qu'un plafond, même par distraction. Et
l'écran écrit « au plus » **avant** le chiffre.

*(Le code affichait d'abord un `marginRatio` nu dans les deux cas, pendant
qu'un commentaire affirmait le contraire. L'audit l'a relevé ; c'est le genre
d'écart entre la prose et le code qui coûte le plus cher.)*

### Trois raisons de borner, pas une

Un niveau est un plafond dès que **l'une** de ces trois conditions tient :

1. **un poste attendu n'est pas renseigné** ;
2. **des charges de classe 6 qu'aucun poste ne couvre** existent (603
   variation des stocks, 600, 608…) — ce sont des charges *réelles* dont on
   ignore le niveau. Elles sont déduites au niveau exploitation (le plafond se
   rapproche de la vérité) mais interdisent d'annoncer un résultat ;
3. **aucune charge n'est enregistrée sur un mois postérieur** — preuve
   indirecte et bon marché que la comptabilité du mois n'est peut-être pas
   arrêtée. En PME, des charges arrivent avec un ou deux mois de retard, et le
   dernier mois d'un FEC s'arrête souvent en plein milieu. « Les six postes
   sont renseignés » ne vaut pas « le mois est clos ».

La deuxième condition est le défaut central qu'a trouvé l'audit : un compte
non rattaché était compté avec les *exclusions volontaires* et disparaissait.
Un négociant dont le 607 était présent pouvait obtenir un pourcentage **ferme**
alors que ses 603 de déstockage — une charge réelle — avaient été avalés en
silence. `exclu` et `non_rattaché` sont désormais deux verdicts distincts : le
premier se tait (il porte sa raison), le second borne la marge.

## Deux niveaux, empilés

| Niveau | Ce qu'il retranche |
|---|---|
| **Marge brute** | achats consommés, sous-traitance |
| **Marge d'exploitation** | + personnel, services extérieurs, impôts et taxes, autres charges |

Chaque niveau est qualifié séparément : la marge brute peut être complète
pendant que la marge d'exploitation reste un plafond.

## D'où viennent les charges

**Du FEC, en priorité.** Le fichier des écritures comptables est déjà importé
(2.14) et contient les charges réelles. À l'import, les écritures de classe 6
sont agrégées par (mois, poste) — **agrégats seulement** : aucun libellé,
aucun tiers, aucune ligne du journal n'en sort (donnée confidentielle, 2.14).

**De la saisie de l'owner**, pour compléter. Les deux sources coexistent en
base — l'unicité porte sur `(tenant, mois, poste, source)`, donc un import ne
piétine pas une saisie et réciproquement — mais **au calcul, la comptabilité
prime** : pour un même poste, la ligne `fec` l'emporte et la saisie est
ignorée. Sans cette règle, l'owner qui déclare un poste « non renseigné » puis
importe son FEC verrait la charge comptée **deux fois**.

Une charge dérivée du FEC ne se supprime pas à la main (409) : elle
reviendrait au prochain import, et son absence ferait remonter la marge sans
que personne sache pourquoi.

Ce que l'import ne peut ni rattacher ni stocker est **dit** dans les
avertissements du rapport d'import : écritures sans poste de marge, agrégats
hors bornes. Une charge avalée en silence embellit la marge sans laisser de
trace — et les charges dérivées sont validées **avant** l'écriture, pour qu'une
ligne aberrante n'emporte pas tout l'import.

Sans cette dérivation, la marge reposerait sur une saisie mensuelle que
personne ne tient à jour — et l'oubli est précisément ce qui l'embellit.

## Le rattachement des comptes est une config, pas du code

Quel compte PCG entre dans quel poste décide de ce qui compose une marge.
C'est donc une **config versionnée datée sourcée** (`costCategories.ts`,
doctrine 2.19/3.7/3.9), source : PCG, règlement ANC n° 2014-03, classe 6.

Le **préfixe le plus long gagne** : `611` (sous-traitance, coût *direct*) doit
primer sur `61` (services extérieurs, exploitation). Sans cette règle, une
charge directe tomberait au mauvais niveau et la marge brute serait
surévaluée — l'erreur exacte que le ticket combat.

Quatre familles sont **exclues, chacune avec sa raison** (les taire ferait
croire à un oubli) : charges financières (66), exceptionnelles (67),
**dotations aux amortissements (68 — amortissement ≠ décaissement, même garde
qu'en 2.19)**, et impôt sur les bénéfices (69, qui se calcule après la marge).

## Ce que le rapport refuse de conclure

- **Aucun chiffre d'affaires** : pas de ratio, un pourcentage sans
  dénominateur n'existe pas. Dit dans `notEvaluated` (même refus qu'en 2.11).
- **Le mois en cours est refusé**, et pour une raison propre à la marge : les
  charges arrivent en comptabilité *après* les ventes, donc un mois entamé
  montre un chiffre d'affaires sans ses charges. Le résultat serait
  systématiquement trop beau. Défaut : le dernier mois **complet**.
- **Un poste hors catalogue est ignoré** par le moteur — et refusé par un
  `CHECK` en base, sinon il serait ni compté dans la marge, ni signalé comme
  manquant : le pire des deux mondes.

Un montant **négatif** est accepté : sur un mois, les avoirs obtenus peuvent
dépasser les achats. Le ramener à zéro fabriquerait une charge inexistante.

## Cohérence du chiffre d'affaires

Une **lecture tronquée** du facturier est signalée (`revenueTruncated`) : elle
change le *dénominateur*, donc le pourcentage lui-même — pas seulement la liste
des charges. Et un facturier indisponible n'affiche pas « 0,00 € » : un chiffre
d'affaires inconnu n'est pas un chiffre d'affaires nul.

Le CA suit la **même séquence de décisions** que la prévision (3.1) et le
rapport mensuel (2.11) — `normalizeSaleInvoice` : brouillons, avoirs et
factures annulées écartés, devise étrangère jamais convertie, montant
malformé rejeté. Deux marges qui divergeraient du CA affiché ailleurs seraient
pires qu'une absence de marge.

## Surface

| Route | Rôle | Accès |
|---|---|---|
| `GET /marge?month=YYYY-MM` | marge du mois | **OWNER** |
| `GET` · `PUT /marge/charges` | charges du mois, saisie | **OWNER** |
| `DELETE /marge/charges/:id` | supprime une saisie (pas une dérivation) | **OWNER** |

Owner-only de bout en bout : c'est la donnée financière la plus sensible du
produit — la masse salariale agrégée y figure via le poste personnel. L'outil
`analyze_margin` est dans `OWNER_ONLY_TOOLS` (fail-closed), et la route passe
par ce **même outil**. `cache-control: private, no-store` partout. Table
`cost_entries` sous RLS avec test d'isolation et preuve par désactivation de
la policy.

## Limites assumées (V1)

- **« Temps réel » veut dire mensuel.** Une marge à la journée supposerait des
  charges rattachées au jour ; la comptabilité ne fonctionne pas comme ça, et
  un lissage arbitraire fabriquerait des variations qui n'existent pas.
- **Pas de marge par chantier ni par client.** Il faudrait imputer chaque
  charge à une affaire — c'est un choix de gestion analytique que le produit
  ne peut pas deviner depuis un FEC.
- **Pas de retraitement de la variation de stock.** Les comptes 603 ne sont
  rattachés à aucun poste : ils comptent comme « charges non rattachées », ce
  qui **borne** la marge au lieu de la fausser. L'effet est réel dans les deux
  sens — sur un mois de stockage les achats surestiment le coût des ventes, sur
  un mois de déstockage ils le sous-estiment et embellissent la marge — d'où la
  borne plutôt qu'un chiffre.
- **Le coût d'achat des articles (3.3) n'est pas utilisé.** Il ne couvre que
  les articles en stock — l'utiliser comme coût des ventes ignorerait la
  main-d'œuvre et les frais généraux, c'est-à-dire referait l'erreur du
  ticket.
- **Modules (3.11)** : `/marge` n'est rattaché à aucun module ; la page reste
  visible quel que soit le vertical.
