# L'objet Affaire (ticket 4.1)

> « Est-ce que **ce** chantier me rapporte de l'argent — pendant qu'il est encore
> en cours — sans que j'aie rien saisi ? »

Un logiciel de compta répond à « combien j'ai gagné en juin ». L'affaire est ce
qui permet de répondre à la question ci-dessus, qui est la seule que le patron
d'une TPE se pose vraiment pendant qu'il travaille.

## Les deux règles de structure

1. **Tout rattachement est NULLABLE.** Une pièce sans affaire — essence, prime
   d'assurance, abonnement téléphonique — est le cas **majoritaire**, pas un cas
   dégradé. `packages/db/test/affaire-non-regression.test.ts` existe pour que
   toute tentative de rendre `affaireId` obligatoire « pour la propreté » se
   voie immédiatement.
2. **Une affaire ne se supprime jamais.** Des pièces comptables y sont
   rattachées. Il n'existe pas de route `DELETE /affaires/:id` : c'est une
   fonctionnalité *refusée*, pas une fonctionnalité manquante. `ARCHIVEE` range
   l'affaire sans rien détacher.

## Où vit le rattachement, et pourquoi

Le ticket demandait une colonne `affaireId` sur cinq tables. **Trois n'existent
pas** : les transactions bancaires ne sont jamais stockées (elles vivent chez
Qonto/Bridge, on n'en garde qu'un identifiant externe), et ni les lignes de
temps ni les devis n'ont de table.

C'est donc **`affaire_imputations`**, polymorphe et append-only, qui porte le
rattachement dans le cas général :

| Cible | `targetId` | Colonne FK ? |
|---|---|---|
| `classeur_document` | UUID interne | oui |
| `facture` | UUID interne | oui |
| `transaction_bancaire` | identifiant **externe** | impossible |
| `charge` | identifiant applicatif | non |

Une pièce ne peut porter **qu'une imputation active** (index unique partiel sur
`revoked_at IS NULL`) : la même dépense dans deux chantiers, ce sont deux marges
fausses — dans le sens flatteur, celui qu'on ne vérifie pas.

Désimputer **révoque**, ça ne supprime pas : la ligne explique un chiffre a
posteriori et nourrira l'apprentissage de l'imputation automatique (F2).

## Le calcul — `packages/shared/src/affaireMargin.ts`

Déterministe, zéro LLM, zéro réseau, zéro accès base : des nombres entrent, des
nombres sortent. C'est ce qui permet de le tester contre des cas calculés à la
main, et c'est la seule raison d'oser afficher un chiffre au patron.

**La règle qui commande tout le reste : une marge trop belle est pire qu'une
absence de marge.** Elle fait accepter un chantier qui perd de l'argent, et elle
ne se fait remarquer qu'au bilan. D'où une **union discriminée** :

| `kind` | Quand | Ce que l'écran peut afficher |
|---|---|---|
| `donnees_insuffisantes` | aucun coût rattaché | ni marge, ni pourcentage |
| `couts_seuls` | pas de montant devisé | les coûts seulement |
| `marge_borne_superieure` | un coût est **inconnu** | un plafond, dit comme tel |
| `marge` | tout est connu | la marge, **avec ses réserves** |

Même une marge exacte porte un `missing` : elle peut reposer sur une base vide
(`aucune_piece_rattachee`). Un chantier de bâtiment sans la moindre facture a un
chiffre juste et une conclusion fausse — l'écran l'écrit sous le chiffre.

Le champ `marginCents` **n'existe pas** dans les trois premiers cas : un écran
ne peut pas afficher par distraction une marge qui n'a pas été calculée.

### Ce qui n'est pas calculé est dit

- **TTC jamais converti en HT.** Sans le taux réel de la pièce, appliquer 20 %
  « parce que c'est le taux courant » fabrique un coût faux sur chaque facture à
  10 % ou 5,5 % — et le bâtiment en est plein. Les montants TTC sont comptés et
  affichés à part. Le classeur ne connaît que le TTC : une pièce rattachée
  depuis le classeur tombe donc dans ce cas, et l'écran l'explique.

  Mais **elles ne sont pas ignorées pour autant** : la borne supérieure retranche
  leur coût HT *minimal* (TTC ÷ 1,20, le taux le plus élevé donnant le HT le plus
  petit). C'est une déduction, pas une supposition, et l'erreur ne peut aller que
  dans le sens prudent. Les ignorer donnait « marge au mieux = le devis entier »
  dans le flux le plus courant du produit — le « 100 % de marge » interdit deux
  paragraphes plus haut, réétiqueté.

- **Reste à facturer : deux bases ne se soustraient pas.** Le facturé vient des
  débits du compte 411, donc du **TTC** ; le devis est du **HT**. Les soustraire
  sous-estimerait le reste d'environ la TVA, et le patron arrêterait de facturer
  trop tôt en croyant avoir tout facturé. Tant qu'on n'a pas de facturé HT,
  `remainingToInvoiceCents` vaut `null` et l'écran dit pourquoi.
- **Zéro heure DÉCLARÉE ≠ heures inconnues.** La première donne une marge
  exacte, la seconde une borne supérieure.
- **Acomptes** : de la trésorerie encaissée, jamais de la marge acquise.
- **Retenue de garantie** : exclue du reste à facturer et affichée à part.
  Relancer un client sur sa retenue est la faute qui coûte un client (US-8).

### Trois chiffres déclarés

Faute de source dans le produit, `hours_worked`, `estimated_material_cents` et
`deposits_cents` sont **déclarés** par le dirigeant, et nullables. « Non
renseigné » et « zéro » sont deux réponses différentes.

Le coût horaire chargé vit dans `tenant_profiles.hourly_cost_cents`, `NULL` par
défaut et jamais deviné : tant qu'il manque, la marge est une borne supérieure
et la fiche dit pourquoi.

## La référence

`2026-014`, unique **par tenant**. Un compteur en UN ordre SQL
(`INSERT … ON CONFLICT DO UPDATE … RETURNING`) : le verrou de ligne sérialise
les créations simultanées. `count() + 1` donnerait deux fois le même numéro à
deux créations concurrentes — d'où le test à vingt créations parallèles.

Le compteur étant une **ligne** et non une séquence, une transaction annulée
rend son numéro : la numérotation est continue. Prix assumé : les créations d'un
même tenant se sérialisent le temps d'une transaction.

## Rôles

Lire une affaire et y **rattacher** une pièce : tous les membres. C'est
l'employé de terrain qui photographie une facture et la rattache au chantier ;
le lui interdire viderait la promesse du produit.

Les **montants** et la marge : owner uniquement, comme le cockpit et la page
marge. **Asymétrie assumée** : un membre peut *écrire* le montant d'une
imputation (il tient la facture en main) sans pouvoir le *relire* — la réponse
lui renvoie `amountCents: null`. Un membre reçoit un refus motivé (`margeRefus`), jamais un zéro muet, et
la liste affiche « réservé au dirigeant » plutôt qu'un tiret qui se lirait
« zéro euro ».

## Le vocabulaire

`packages/shared/src/affaireVocabulary.ts` : chantier (BTP), mission (services),
affaire (défaut). Exhaustif par construction — ajouter un vertical sans lui
donner de mot ne compile pas. **Aucune feature ne teste le vertical** ; elle
appelle `affaireWords(vertical)`.

Provisoire et dit : les cinq verticaux actuels héritent de l'ancienne
segmentation (3.7) et ne recouvrent pas la cible du pivot. Le ticket 4.2 apporte
les vrais packs, et ce fichier est son point d'absorption.

## Données personnelles

Le lien `prospectId` est une **clé étrangère composite** `(tenant_id, prospect_id)` :
l'intégrité référentielle contourne la RLS, donc sans elle une affaire pouvait
pointer la fiche d'un autre tenant. Idem pour `(tenant_id, affaire_id)` sur les
imputations — c'est la **deuxième couche** exigée par le CLAUDE.md, la RLS ne
contraignant que `tenant_id`.

`DELETE /prospects/:id` (droit à l'effacement) efface la fiche ; l'affaire
survit, `prospect_id` à `NULL`. L'**opposition**, elle, ne supprime pas : elle
minimise. Ce sont deux régimes distincts.

`affaires.client_name`, `address` et les coordonnées GPS sont une **copie
indépendante** de l'identité et de l'adresse — souvent le domicile — de la
personne. La clé composite met `prospect_id` à `NULL`, mais la copie, elle,
survivait intacte : effacer la fiche en gardant l'adresse n'est pas un
effacement. L'effacement anonymise donc aussi ces colonnes, **selon le statut**,
et le détail est dans [`docs/effacement.md`](effacement.md).

Effacer une pièce du classeur **révoque** son imputation : sans cela, la fiche
continuerait d'afficher un coût pour une pièce disparue, que plus personne ne
peut vérifier.

## F4 — la marge de chaque chantier dans le cockpit

`GET /affaires/marges` (owner-only, module-gated) rend **trois groupes séparés**,
jamais un classement unique :

| Groupe | Contenu |
|---|---|
| `aSurveiller` | marge connue **négative**, ou budget matière dépassé — le pire en tête |
| `chiffrables` | marge **EXACTE** et positive — rien d'autre n'est « dans le vert » |
| `sousReserve` | plafond positif : « au mieux X », marge réelle **inconnue** |
| `nonChiffrables` | ni marge ni plafond — **nommées**, avec leur cause |

Le quatrième groupe existe parce que ranger un plafond positif avec les
rentables était une faute — et c'est le **flux nominal** : coût horaire non
renseigné, heures inconnues ou pièces en TTC suffisent à produire un plafond
proche du devis entier, pendant que la marge réelle est négative. Compté avec
les saines, ça donnait « 3 chantiers dans le vert » sur trois chantiers dont on
ne sait rien. La carte écrit **« au mieux X »**, jamais « marge X ».

Chaque ligne non chiffrable porte **sa** cause, dérivée de son `missing` : un
coût horaire manquant produit un *plafond*, jamais une absence de calcul —
l'accoler à toutes les affaires sans marge attribuait une cause fausse.

Le périmètre est dit à l'écran (`EN_COURS` + `ACCEPTEE`), et `ignorees` compte
les affaires ouvertes au-delà de la borne de lecture (100). La troncature garde
les plus **récentes** : les écartées sont donc les plus anciennes encore
ouvertes — celles qui traînent, statistiquement les plus à risque. C'est dit
sur la carte plutôt que masqué par un simple compteur.

Le coût est **borné et indépendant du nombre d'affaires** : quatre requêtes
(compte, affaires, imputations, factures), jamais une par chantier. Et **un seul
moteur** : la marge du cockpit et celle de la fiche viennent du même
`computeAffaireMargin`, avec un test qui échoue si les deux divergent.

> **Limite** : le dépassement de budget matière ne peut pas se déclencher sur une
> affaire sans devis — le moteur rend `couts_seuls` avant de calculer l'écart.
> Ces affaires sont nommées dans `nonChiffrables`, mais leur dérive de budget
> n'est pas détectée.

## Ce que 4.1 ne livre pas

Dictée → devis (F1), suggestion automatique d'imputation (F2), marge dans le
cockpit (F4), brief du matin (F5), relances de devis (F3), sous-affaires, lots,
situations de travaux.

Et, non prévu par le ticket mais constaté ici : **le détachement depuis le
classeur** renvoie à la fiche de l'affaire, faute d'exposer l'identifiant
d'imputation sur le document. Le rattachement, lui, se fait bien depuis le
classeur en un geste.
