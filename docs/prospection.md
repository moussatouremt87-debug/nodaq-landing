# CRM & prospection (ticket 2.12)

Un petit CRM : des fiches prospects, un pipeline en six étapes, un journal des
contacts, et une liste « qui relancer cette semaine ». Rien d'un Salesforce —
une PME de huit personnes n'en veut pas.

## Le risque change encore de nature

C'est le **premier ticket qui stocke les données de personnes qui ne sont pas
clientes**. Elles n'ont rien signé, parfois rien demandé. Le risque n'est donc
ni l'injection (2.7) ni l'affirmation (2.11) : c'est la **légitimité de la
détention**.

Trois gardes, structurelles et non des options d'affichage :

### 1. Provenance obligatoire

`source` est exigée à la création, dans un enum fermé — pas de valeur par
défaut, pas de fiche dont on ne saurait pas dire d'où elle vient. C'est ce qui
permet d'informer la personne si elle le demande (art. 14) et de justifier
l'intérêt légitime.

**`achat_fichier` est volontairement absent du catalogue.** La licéité d'un
fichier acheté se juge fichier par fichier — origine, information des
personnes, opposition déjà recueillie. Le produit ne la légitime pas d'avance
par une case à cocher. Refusé par Zod *et* par un `CHECK` en base.

### 2. L'opposition est une sortie, pas un filtre

Un prospect opposé (art. 21) est écarté **par le moteur lui-même**, en tête de
boucle, avant toute construction de liste. Il ne peut réapparaître ni par un
tri, ni par un filtre, ni par une pagination — un simple `optedOut` masqué à
l'affichage aurait fini par ressortir dans une requête bien tournée.

S'opposer déclenche une minimisation immédiate : e-mail, téléphone et notes
sont effacés, et les comptes rendus du journal sont vidés. Ce qui reste est le
strict nécessaire pour **ne plus recontacter la personne** — supprimer la fiche
entière la laisserait être réimportée le mois suivant. C'est une liste
d'exclusion, pas un dossier.

Trois portes dérobées sont fermées, chacune testée : un `PATCH` ne peut pas
remettre un e-mail sur une personne opposée (409), un contact ne peut pas être
consigné sur elle (409), et l'exécuteur de relance **rejoue** le garde à
l'approbation — la personne a pu s'opposer entre la préparation et la
validation.

L'opposition n'est **pas réversible depuis le produit** : la lever exigerait la
preuve d'un nouvel accord, que le produit n'a aucun moyen de recueillir ici.

### 3. La rétention est dite

Au-delà de **36 mois sans contact**, la fiche est **signalée**. Le produit ne
purge jamais en silence — et ne garde jamais sans le dire.

Source : CNIL, « Durées de conservation — prospection commerciale »
(https://www.cnil.fr/fr/conservation-des-donnees), consultée le 2026-07-31.
Config versionnée datée, même doctrine que 2.19/3.7/3.9.

## Relancer : un délai écoulé, jamais une intention supposée

En continuité de 2.11, « à relancer » est une règle **déterministe** : jours
écoulés depuis le dernier contact vs seuil de l'étape. Chaque ligne porte sa
phrase chiffrée et son seuil.

| Étape | Relance après |
|---|---|
| `nouveau` | 7 jours |
| `contacte` | 14 jours |
| `qualifie` | 21 jours |
| `devis_envoye` | 10 jours |
| `gagne` / `perdu` | — (hors pipeline actif) |

Le **dernier contact n'est pas une colonne** : il est dérivé du journal
append-only `prospect_interactions` (doctrine 2.9/2.16b). Un champ modifiable à
la main aurait fini par mentir — et il aurait décidé, seul, qui est relancé.

## Minimisation : décider qui relancer ≠ savoir comment le joindre

Le modèle pur `buildProspectionPlan` ne **reçoit même pas** l'e-mail, le
téléphone ni les notes — sa signature d'entrée ne les comporte pas. Ce n'est
pas une consigne de prompt qu'on peut contourner, c'est une frontière de type.
Test littéral : le plan sérialisé ne contient jamais d'arobase.

Le brouillon de relance suit la même règle : le prompt reçoit le prénom/nom,
la société et l'étape — rien d'autre. Et il lui est interdit d'inventer un
prix, une remise, un délai ou une référence : une relance chiffrée engagerait
commercialement sans que personne l'ait décidé.

## Ce que fait l'approbation — et ce qu'elle ne fait pas

`draft_prospect_email` prépare, ne poste rien. À la validation, l'exécuteur
consigne le contact au journal et renvoie `sent: false`.

**Le produit enregistre la validation humaine, pas une preuve d'envoi** : il
n'a aucune API de messagerie en V1, et la note du journal le dit mot pour mot
(« Brouillon validé (envoi manuel) »). Le texte validé vit dans ce journal —
donc il suit la vie de la fiche et disparaît avec elle — pendant que le payload
de la file est réduit une fois l'action terminée.

## Surface

| Route | Rôle | Accès |
|---|---|---|
| `GET /prospects` · `POST /prospects` | liste, création | membres |
| `PATCH /prospects/:id` | étape, notes, coordonnées | membres |
| `POST` · `GET /prospects/:id/interactions` | journal des contacts | membres |
| `POST /prospects/:id/opposition` | opposition (art. 21) | membres |
| `DELETE /prospects/:id` | effacement définitif | **owner** |
| `GET /prospection/suivi` | plan de relance | membres |

**Membres et non owner-only**, contrairement aux signaux clients (3.4) :
prospecter est le métier d'un commercial, et une fiche prospect ne porte aucun
chiffre d'affaires. L'effacement définitif, lui, reste au dirigeant. Toutes les
réponses en `cache-control: private, no-store`.

Deux tables sous RLS (`prospects`, `prospect_interactions`) avec leurs tests
d'isolation, plus les `CHECK` de défense en profondeur : étape et provenance
dans le catalogue, bornes de longueur, et une opposition qui ne peut pas
exister sans sa date.

## Limites assumées (V1)

- **Aucun enrichissement externe.** Ni scraping, ni annuaire, ni base achetée :
  toute donnée est saisie par un humain qui sait d'où elle vient. C'est ce qui
  rend la colonne `source` honnête.
- **Aucun envoi.** Pas d'API de messagerie : le brouillon se copie. Brancher un
  opérateur suppose le socle d'envoi validé (doctrine 2.18) — ticket à part.
- **Pas de purge automatique.** Les fiches expirées sont signalées, la
  suppression reste un geste humain. Une purge silencieuse effacerait un jour
  ce qu'il ne fallait pas.
- **Pas de désinscription en libre-service.** L'opposition est enregistrée par
  l'entreprise quand la personne la demande ; un lien de désabonnement suppose
  un canal d'envoi, donc le même ticket que ci-dessus.
- **Pas de rapprochement avec les clients existants** (facturier, 3.4) : un
  prospect devenu client reste deux fiches. Le lien demande une identité
  d'entreprise fiable (SIREN), qui n'est pas saisie ici.
- **Modules (3.11)** : `/prospects` n'est rattaché à aucun module ; la page
  reste visible quel que soit le vertical.
