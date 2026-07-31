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
marge) et impossible à confondre avec un résultat complet. Le champ
`marginRatio` ne vit jamais seul : chaque niveau porte son `kind`
(`complete` | `borne_superieure`), et l'écran écrit « au plus » **avant** le
chiffre. Un plafond ne peut pas se lire comme un résultat, même en diagonale.

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

**De la saisie de l'owner**, pour compléter. Les deux sources coexistent :
l'unicité porte sur `(tenant, mois, poste, source)`, donc un nouvel import ne
piétine pas une saisie, et une saisie ne masque pas l'import. Une charge
dérivée du FEC ne se supprime d'ailleurs pas à la main (409) : elle
reviendrait au prochain import, et son absence ferait remonter la marge sans
que personne sache pourquoi.

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
- **Pas de stocks dans le calcul.** La variation de stock (comptes 603) n'est
  pas retraitée : sur un mois où l'entreprise stocke beaucoup, les achats
  surestiment le coût des ventes. Dit ici plutôt que découvert.
- **Le coût d'achat des articles (3.3) n'est pas utilisé.** Il ne couvre que
  les articles en stock — l'utiliser comme coût des ventes ignorerait la
  main-d'œuvre et les frais généraux, c'est-à-dire referait l'erreur du
  ticket.
- **Modules (3.11)** : `/marge` n'est rattaché à aucun module ; la page reste
  visible quel que soit le vertical.
