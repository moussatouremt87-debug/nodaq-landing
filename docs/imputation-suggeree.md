# F2 — photo → imputation suggérée

> « L'affaire se remplit toute seule » ne tient que si elle ne se remplit
> **jamais de faux**.

Une dépense rattachée au mauvais chantier fabrique **deux** marges fausses :
celle qui l'encaisse et celle qui la perd. Aucune des deux ne se remarque, et
les deux sont montrées au patron comme des chiffres à lui. C'est cette asymétrie
qui dicte tout le reste.

## Trois décisions

**1. Le moteur ne crée jamais d'imputation.** `GET /classeur/documents/:id/affaires-suggerees`
propose ; il n'écrit pas. Une imputation `AUTO` non confirmée entrerait dans le
calcul de marge de 4.1 — un coût que personne n'a validé déciderait d'un chiffre
affiché. L'acceptation passe par la route d'imputation normale.

**2. L'abstention est une réponse.** Quatre motifs, tous explicites :

| `why` | Situation |
|---|---|
| `aucune_affaire_ouverte` | proposer un chantier terminé détruirait la confiance d'un coup |
| `piece_illisible` | ni fournisseur ni date lus sur la photo |
| `signaux_partages` | plusieurs chantiers ouverts couvrent la même date — le cas **normal** d'un artisan |
| `aucun_signal` | rien ne relie la pièce à quoi que ce soit |
| `deja_rattachee` | la pièce a déjà son affaire ; re-suggérer inviterait à la double imputation |

Ne rien proposer laisse un problème **visible** : l'utilisateur impute à la
main, comme avant. Proposer au hasard rend le problème **muet**.

**3. Chaque suggestion porte ses raisons, en clair.** Une proposition qu'on ne
peut pas contester est une proposition qu'on valide par réflexe.

## Les signaux, par ordre de force

1. **Historique du tenant** — « vous avez déjà rattaché ce fournisseur ici »,
   avec son compte de preuves. C'est le seul signal que l'utilisateur a produit
   lui-même. Dérivé **à la lecture** des imputations non révoquées, jamais
   stocké, jamais partagé entre tenants (règle 7).
2. **Période** — la pièce tombe dans les dates du chantier, avec quinze jours de
   tolérance : un fournisseur qui facture en fin de mois compte encore.
3. **Affaire unique** — il n'y en a qu'une d'ouverte. Signal faible, affiché
   comme tel, et **jamais utilisé pour départager** plusieurs affaires.

À égalité parfaite sur l'historique, les deux affaires sont proposées : trancher
au hasard serait pire que demander.

## La mesure

`source` distingue **`CONFIRMEE`** (l'humain a validé une proposition) de
**`MANUELLE`** (il a choisi seul). L'écart entre les deux est la seule mesure
honnête de F2 — et elle existe dès le premier jour parce que 4.1 a prévu la
colonne. **`AUTO` reste inutilisé** : rien n'écrit sans validation humaine.

## Zéro LLM

Le rapprochement est déterministe et testé contre des cas écrits à la main. Le
modèle souverain a déjà fait sa part en lisant la photo (2.16) ; lui demander en
plus de deviner le chantier ajouterait du coût, de la latence et une erreur
qu'on ne saurait pas expliquer.

## Limite assumée

**Aucun rapprochement géographique.** Le ticket 4.1 stocke `address` et les
coordonnées d'une affaire « pour F2 », mais l'extraction d'une photo ne rend
aucune adresse de chantier — au mieux celle du **fournisseur**, qui ne dit rien
du lieu des travaux. Le signal n'existe donc pas encore ; il attend une source
qui le porte vraiment (une dictée, un relevé GPS au moment de la photo), pas une
approximation qui aurait l'air de marcher en démonstration.
