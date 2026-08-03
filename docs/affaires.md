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
| `marge` | tout est connu | la marge |

Le champ `marginCents` **n'existe pas** dans les trois premiers cas : un écran
ne peut pas afficher par distraction une marge qui n'a pas été calculée.

### Ce qui n'est pas calculé est dit

- **TTC jamais converti en HT.** Sans le taux réel de la pièce, appliquer 20 %
  « parce que c'est le taux courant » fabrique un coût faux sur chaque facture à
  10 % ou 5,5 % — et le bâtiment en est plein. Les montants TTC sont comptés et
  affichés à part. Le classeur ne connaît que le TTC : une pièce rattachée
  depuis le classeur tombe donc dans ce cas, et l'écran l'explique.
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
marge. Un membre reçoit un refus motivé (`margeRefus`), jamais un zéro muet, et
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

## Ce que 4.1 ne livre pas

Dictée → devis (F1), suggestion automatique d'imputation (F2), marge dans le
cockpit (F4), brief du matin (F5), relances de devis (F3), sous-affaires, lots,
situations de travaux.

Et, non prévu par le ticket mais constaté ici : **le détachement depuis le
classeur** renvoie à la fiche de l'affaire, faute d'exposer l'identifiant
d'imputation sur le document. Le rattachement, lui, se fait bien depuis le
classeur en un geste.
