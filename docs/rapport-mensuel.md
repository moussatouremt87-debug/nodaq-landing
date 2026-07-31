# Rapport mensuel & anomalies (ticket 2.11)

Un mois se termine, le gérant veut savoir ce qui s'est passé : combien
facturé, quel encours échu, quel client pèse trop, et surtout **ce qui sort de
l'ordinaire**. C'est le premier ticket du produit qui **synthétise** au lieu
d'extraire.

## Le risque change de nature

Jusqu'ici le danger était la fuite (données confidentielles) ou l'injection
(texte de tiers). Ici c'est l'**affirmation**. Un rapport qui décrète « votre
chiffre d'affaires s'effondre » sur trois factures, ou qui signale une anomalie
qui n'en est pas une, détruit la confiance plus sûrement qu'un rapport vide —
et un gérant qui a vu deux fausses alertes ne lit plus la troisième.

D'où la règle du module : **une anomalie est un écart MESURÉ, pas un jugement.**

Le modèle ne décide jamais qu'il y a anomalie. Une fonction pure
(`monthlyReport.ts`) compare des chiffres à des seuils **versionnés et datés**
(doctrine 2.19/3.7/3.9) et produit une phrase française déjà chiffrée ; le
modèle ne fait que la relayer. Chaque anomalie porte :

| Champ | Rôle |
|---|---|
| `observed` | la valeur constatée |
| `reference` | ce à quoi elle est comparée |
| `threshold` | le seuil franchi — affiché, donc **contestable** |
| `sampleSize` | l'échantillon derrière la comparaison |
| `reason` | la phrase française, chiffres inclus |

Un verdict sans son calcul ne se conteste pas. Ici, l'écran montre le calcul.

## Les quatre règles (`ANOMALY_RULES_VERSION`)

| Anomalie | Déclencheur | Seuil |
|---|---|---|
| `ca_en_baisse` | CA du mois vs moyenne des 3 mois précédents | −20 % |
| `facture_inhabituelle` | plus grosse facture du mois vs **médiane** sur 12 mois | ×3 |
| `concentration_client` | part du CA sur un seul client | 40 % |
| `impayes_en_hausse` | encours échu vs mois précédent | +30 % |

**Médiane, pas moyenne**, pour la facture inhabituelle : avec une moyenne, une
grosse facture ferait bouger sa propre référence et se masquerait elle-même.

La fenêtre de la médiane est adossée au **mois analysé**, jamais à la date de
consultation : le rapport de mars doit dire la même chose en avril et en
décembre. Une fenêtre calée sur « aujourd'hui » ferait changer un verdict sans
qu'aucune donnée ait bougé.

## Ce que le rapport REFUSE de conclure

Chaque règle qui ne s'exécute pas **le dit** dans `notEvaluated` — parce
qu'une règle silencieuse se lit comme « rien à signaler », et qu'un feu vert
qu'on n'a jamais calculé est pire qu'une absence de rapport :

1. **Historique insuffisant.** Une baisse « vs les 3 mois précédents » quand il
   n'y en a qu'un est une invention. La règle n'est pas évaluée.
2. **Dénominateur nul.** « +∞ % » n'est pas un constat.
3. **Échantillon trop petit** (moins de 6 factures sur 12 mois) : pas de
   médiane, donc pas de « facture inhabituelle ». Médiane à zéro : idem.
4. **Aucun impayé le mois précédent** : pas de « hausse » sans référence.
5. **Aucun CA retenu sur le mois**, ou **aucune facture rattachée à un
   client** : la concentration n'est pas « sans anomalie », elle est *non
   évaluée*.

Deux refus supplémentaires vivent dans la route et l'outil :

- **Le mois en cours est refusé**, avec son motif. Comparer trois semaines à
  des mois pleins produirait une « baisse » qui n'est que du calendrier. Le
  défaut est donc le dernier mois **complet**.
- **Hors fenêtre de lecture** (au-delà de 24 mois) : refus motivé plutôt qu'un
  rapport vide qui se lirait comme un mois sans activité.

Un refus est une **réponse**, pas une erreur : le modèle reformule au lieu
d'inventer un chiffre (même doctrine que le cockpit conversationnel 2.5).

## Ce qui est écarté du calcul, et compté

La décision « cette facture compte-t-elle dans un chiffre d'affaires ? » vit
dans **une seule fonction partagée** avec la prévision de ventes (3.1),
`normalizeSaleInvoice`. Partager deux constantes ne suffisait pas : c'est la
*séquence* de décisions qui doit être unique, sinon un écran tolère « eur » là
où l'autre l'écarte, et le même mois affiche deux CA.

- **Brouillons, devis, factures annulées et avoirs** : ce ne sont pas des
  ventes → `excludedCount`.
- **Devise étrangère** : comptée à part (`unusableCount`), **jamais convertie**
  à un taux inventé.
- **Montant malformé** : écarté par le parseur strict — « 12abc » lu comme
  12 € entrerait dans le rapport comme une donnée sûre.
- **Factures non rattachées à un client** : comptées au CA, jamais attribuées.
  Elles **diluent** la part du premier client, donc `unattributedCount` et son
  montant sont affichés *et* rappelés dans la phrase de l'anomalie — tues,
  elles feraient passer une vraie concentration sous le seuil.
- **Fenêtre de lecture tronquée** (`windowTruncated`) : l'ordre de tri du
  fournisseur n'étant pas contractuel, la coupe peut amputer le mois **cible**
  lui-même. Les anomalies ne sont pas masquées — les taire serait aussi
  trompeur — mais elles sont **marquées**, dans leur propre phrase et dans la
  carte qui les affiche.

## Une convention dite plutôt que cachée

L'encours échu est le statut **d'aujourd'hui**, rapporté au mois d'**émission**
de la facture. Une facture récente a eu moins de temps pour tomber en retard :
le mois courant est donc structurellement défavorisé. Le biais joue **contre**
l'alerte (jamais en sa faveur), et la phrase le dit — « factures émises ce
mois-ci aujourd'hui en retard de paiement ».

Les statuts d'échéance (`late`, `overdue`, `unpaid`) sont une **liste
partagée** avec la relance : ne reconnaître que `late` afficherait « 0 €
d'impayés » comme un constat alors que ce serait un défaut de correspondance
— une affirmation fausse, pas une absence de données. `pending` en est
volontairement absent : une facture non encore exigible n'est pas un impayé.

## Surface

| Route | Rôle | Accès |
|---|---|---|
| `GET /rapports/mensuel?month=YYYY-MM` | rapport du mois | **OWNER** |

Owner-only de bout en bout : le rapport porte le chiffre d'affaires, l'encours
échu et le **nom du premier client** (PII) — même statut que les factures dont
il est tiré (3.4). L'outil `build_monthly_report` est dans `OWNER_ONLY_TOOLS`
(fail-closed : hors du toolset pour un membre, donc *unknown tool*), et la
route passe par ce **même outil** — une seule implémentation, donc un seul jeu
de seuils. Réponse en `cache-control: private, no-store`.

Page `/rapports` : sélection du mois (bornée au dernier mois complet),
chiffres, anomalies avec leur calcul, et une section **« Non évalué »** aussi
visible que les anomalies.

## Limites assumées (V1)

- **Pas de marge.** Le rapport parle CA, pas résultat : le coût d'achat
  (`unitCostCents`, 3.3) ne couvre que les articles en stock, pas la
  main-d'œuvre ni les frais généraux. Une marge calculée sur une partie des
  charges serait fausse dans le sens rassurant. C'est le ticket 2.8.
- **Pas d'envoi automatique.** Le rapport se consulte ; le pousser chaque mois
  par e-mail suppose le socle d'envoi validé (doctrine 2.18) — ticket à part.
- **Seuils non paramétrables.** Ils sont dans une config versionnée : un seuil
  qui bouge change ce qui est signalé, ça se relit et se date. Les rendre
  réglables par tenant viendra avec l'historique qui permet de les justifier.
- **Pas de comparaison N-1.** Douze mois glissants sont lus ; comparer mars à
  mars de l'an dernier demande une fenêtre de 24 mois et une gestion de la
  saisonnalité — la prévision (3.1) est le bon endroit pour ça.
- **Modules (3.11)** : `/rapports` n'est rattaché à aucun module ; la page
  reste visible quel que soit le vertical. La route renvoie tout de même 409 si
  l'outil disparaît du toolset — dit ici plutôt que découvert.
