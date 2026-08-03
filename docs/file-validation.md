# F6 — la file de validation, recentrée

> L'assistant prépare, le patron valide. C'est l'argument produit, et la file
> est l'endroit où il se tient ou s'effondre.

La file existait déjà (1.6) et fonctionnait. Le pivot (ADR-007) l'a laissée
derrière : elle parlait encore le vocabulaire de l'ancienne direction, et elle
ignorait le pivot du nouveau modèle. F6 la recentre sur deux choses — **l'affaire
et le socle** — sans toucher à ce qui décide.

## 1. Recentrée sur l'affaire

Une action à valider dit désormais **à quel chantier elle se rapporte**.

Avant, l'owner lisait « Relance — Facture 2026-124 » et devait deviner. Sur un
produit dont la règle n°1 est que l'affaire est le pivot du modèle, c'était le
seul écran qui l'ignorait.

**Le rattachement est NULLABLE, comme tous les autres.** Une action de frais
généraux — essence, assurance, cotisation — n'a pas de chantier, et c'est le cas
majoritaire au démarrage. « Aucun » est une réponse, pas un oubli à corriger.
Il se **détache** aussi : un rattachement se corrige, il ne se subit pas.

**Ce lien ne compte JAMAIS dans la marge.** Une décision n'est pas un coût ;
seule `affaire_imputations` porte de l'argent. Si rattacher une relance changeait
la marge d'un chantier, le chiffre le plus regardé du produit deviendrait faux au
premier classement — un test le vérifie explicitement.

**Owner-only, et pas par frilosité.** Le payload d'une action est owner-gated
(1.5) : un membre ne peut pas *voir* ce que l'action contient. Lui demander de la
classer serait lui demander de classer à l'aveugle. C'est l'inverse exact de
l'imputation d'une pièce (4.1), ouverte à tous parce que l'employé de terrain,
lui, a la facture sous les yeux.

**Modifiable tant que l'action est en attente**, comme le brouillon : après
décision, la ligne est une trace, et une trace ne se réécrit pas.

Deux couches d'isolation, comme partout : RLS **et** clé étrangère composite
`(tenant_id, affaire_id)`. La RLS ne contraint que `tenant_id` ; l'intégrité
référentielle contourne la RLS par conception Postgres. Sans la clé composite, la
file du tenant A pourrait pointer un chantier de B — invisible en lecture, mais
c'est un oracle d'existence sur les affaires du voisin.

Le lien se lit **dans les deux sens** : la fiche du chantier compte ce qui attend
une décision dessus. Une marge qui dérive pendant que trois relances dorment dans
la file, c'est deux écrans qui savent chacun la moitié de l'histoire.

## 2. Recentrée sur le socle

Les onglets viennent désormais du catalogue (`pendingActionCatalog.ts`), pendant
du registre de modules (3.11).

La liste écrite en dur dans l'écran avait cessé d'être vraie :

- **cinq types d'action sur dix n'avaient aucun onglet**
  (`record_prospect_contact`, `submit_einvoice`, `report_einvoice_transactions`,
  `create_fixed_asset`, `adjust_stock`) — ces actions n'existaient que dans
  « Toutes », introuvables dès que la file dépassait un écran ;
- un onglet « Avis » subsistait alors que le module `avis` est **hors socle**
  depuis le pivot : un filtre vers un module dont la page a disparu.

### La règle qui commande tout le reste

**Une action en attente n'est JAMAIS masquée.** Le registre gouverne les
**onglets**, pas les actions.

Une action préparée avant l'extinction de son module reste une décision à
prendre. La cacher la bloquerait pour toujours, sans un mot, pendant que le
compteur de la navigation continuerait de la compter — un badge « 3 » sur une
file qui en montre 2. Éteindre un module retire une surface produit ; ça n'annule
pas un engagement déjà pris.

Donc : un groupe **sans** action ne montre pas d'onglet (un onglet à zéro est du
bruit) ; un groupe **avec** des actions montre son onglet, module éteint ou non,
et l'écran **dit** que le module est éteint. Un invariant le vérifie : la somme
des onglets égale la file.

Un type d'action **inconnu** du catalogue tombe dans « Autres » et reste visible.
Le défaut penche du côté visible, délibérément : un outil livré avant sa ligne de
catalogue doit rester décidable. Mal rangée, une action reste une action ;
masquée, elle est perdue.

## Ce que F6 ne change pas

**Rien de ce qui décide.** La validation 1 clic, l'idempotence (double clic =
409, jamais un double envoi), l'édition du brouillon avec sa piste d'audit
append-only, l'attribution légale à un humain : intacts. F6 ajoute du contexte
autour de la décision, il ne touche pas à la décision.

**Le rattachement automatique.** Le moteur de suggestion existe (F2, photo →
affaire) et saurait proposer un chantier pour une action. Mais une suggestion
écrite d'office sur une action que l'owner s'apprête à valider en un clic, c'est
exactement l'inférence que le produit refuse : le coût des deux erreurs n'est pas
symétrique. Ne pas rattacher laisse un travail visible ; rattacher au mauvais
chantier fausse une marge en silence. Ça vaut son propre ticket, avec le même
traitement qu'en F2 — proposé, jamais écrit.
