# F5 — le brief du matin

> Le patron ouvre son téléphone à 7 h, sur un chantier, avant le café. Il lit
> trois lignes et décide de sa journée.

C'est le premier écran de la journée et le plus lu — donc celui où un chiffre
faux fait le plus de dégâts, et celui qu'on cesse d'ouvrir le plus vite s'il
raconte n'importe quoi.

## Zéro LLM, et c'est une décision

Un « brief » est **exactement** l'endroit où la génération de prose est
tentante, et **exactement** l'endroit où une phrase plausible mais fausse est
crue sans vérification. Tout est assemblé à partir de moteurs déterministes déjà
testés : la marge (4.1/F4), l'échéancier (2.9), les impayés (US-8), la file de
validation. `composeMorningBrief` ne calcule rien — elle **décide de ce qui
mérite d'être lu à 7 h**, et dans quel ordre.

## Trois règles

**1. « Rien d'urgent » est un brief.** Le résultat est une union discriminée :
`calme` n'est pas une liste vide qu'un écran pourrait rendre comme un brief
raté. Meubler une matinée calme apprend au patron à survoler — ce qui tue la
feature plus sûrement qu'une journée vide.

**2. Ce qu'on n'a pas pu regarder est dit.** `blindSpots` porte chaque domaine
non examiné et sa raison. Un brief qui omet silencieusement les impayés faute de
facturier connecté laisse croire qu'il n'y en a pas — **le pire mensonge
possible sur cet écran-là**. Les angles morts sont rendus même quand le brief
est `calme`, sinon « rien d'urgent » voudrait dire « rien vu ».

Ce qui y remonte aujourd'hui :

| Angle mort | Source |
|---|---|
| module éteint (affaires, stocks, classeur) | registre 3.11 |
| montants et échéances réservés au dirigeant | rôle `member` |
| aucun import comptable | absence de `fec_imports` |
| limites de la dérivation FEC (retenue non rattachable…) | `warnings` du dernier import |
| régime fiscal non renseigné | `gaps` de l'échéancier (2.9) |
| échéances passées non pointées | occurrences sans annotation humaine |
| affaires au-delà de la borne de lecture, affaires sans marge calculable, coût horaire inconnu | F4 |

Les trois derniers viennent de moteurs qui les nomment déjà sur leur propre
écran : les perdre en route ferait dire au brief « tout va bien » sur des
chantiers dont il ne sait rien.

**3. Chaque ligne mène quelque part.** Une alerte sans action est une source
d'anxiété, pas une information. Toutes les lignes portent un `href`.

## Ce qui remonte, et à quel niveau

| Sévérité | Contenu | Pourquoi |
|---|---|---|
| `urgent` | affaire en perte, impayés, échéance en retard, échéance ≤ 3 j | de l'argent part ou ne rentre pas, et on peut encore agir aujourd'hui |
| `attention` | budget matière dépassé, actions à valider, stock sous seuil, échéance ≤ 7 j | ça dérive, il est encore temps |
| `info` | pièces à vérifier | à savoir, pas à faire |

**Zéro n'est pas une nouvelle** : un domaine à zéro ne produit aucune ligne.
« 0 impayé » est du bruit. Mais « regardé et vide » et « pas regardé » ne se
confondent jamais — le premier ne dit rien, le second déclare un angle mort.

L'ordre est **fixe et stable** : à sévérité égale, l'ordre de composition fait
foi. Deux briefs identiques se lisent à l'identique — un ordre qui bouge d'un
matin à l'autre donne l'impression que quelque chose a changé alors que rien n'a
bougé.

## Rôles

Les montants sont **owner-only**, comme partout ailleurs. Un membre reçoit un
brief réel — actions à valider, pièces à vérifier, alertes de stock — avec un
angle mort explicite : « montants — réservés au dirigeant ». Pas un écran vide,
pas un écran qui ment.

## Une affaire « en perte », précisément

Seules comptent une marge **exacte** négative ou un **plafond** négatif (« même
au mieux, ce chantier perd »). Un plafond **positif** ne dit rien de la réalité
et n'entre pas — même règle que la carte du cockpit (F4), et littéralement la
même fonction (`comparableMargin`) : réécrite ici, elle finirait un jour par
contredire le cockpit sur le même chantier.

Le montant affiché est **la pire** des affaires concernées, pas un total, et il
porte sa base (`amountNote`). « −1 500 € » sous « 3 affaires perdent de
l'argent » se lit comme une somme ; un plafond rendu nu se lit comme une marge
constatée. Le qualificatif voyage **avec** le chiffre, depuis l'API — un écran
qui l'oublierait rendrait un chiffre faux sans jamais planter.

## L'échéancier : deux créneaux, et une annotation qui fait foi

Le calendrier fiscal n'est **pas stocké** : il est recalculé à chaque lecture
depuis le régime du tenant (2.9). La table `tax_deadlines` ne porte que les
décisions humaines. Lire cette table seule — le premier réflexe — laissait le
brief **muet sur une CA3 due dans deux jours** tant que personne ne l'avait
annotée, c'est-à-dire dans le cas nominal.

**Deux créneaux séparés**, jamais un seul : « en retard » et « à venir » sont
deux problèmes distincts, et n'en garder qu'un laissait une pénalité vieille de
deux mois occuper la place de la déclaration due après-demain.

**« En retard » exige une annotation humaine.** Une occurrence que personne n'a
pointée est `prevu` par défaut : impossible de la distinguer d'une échéance
déclarée impayée. Sans cette garde, la CA3 payée en juin mais jamais annotée
criait « en retard de 55 jours » tous les matins — et un brief qui hurle au loup
chaque matin, on cesse de l'ouvrir en trois jours. Le silence n'est pas une
omission : les occurrences passées non pointées partent en **angle mort**, avec
de quoi agir.

**Une date approximative reste approximative.** La date d'une CA3 dépend du
SIREN ; le calendrier rend la borne **basse** de la fenêtre légale. Elle n'est
donc jamais annoncée « en retard » avant la largeur de cette fenêtre
(`APPROXIMATE_DUE_DATE_SLACK_DAYS`), et la phrase renvoie à l'espace
professionnel plutôt que d'affirmer « dans 2 jours ».

Le regard en arrière est borné à `BRIEF_LATE_LOOKBACK_DAYS` (deux mois) : au-delà,
ce n'est plus l'information du matin, et ça reste visible sur l'écran Échéancier,
qui n'est pas borné.

## Ce que F5 ne livre pas

**La notification push.** Le module `notifications` (2.17) existe et saurait
l'envoyer, mais un push qui réveille à 7 h engage bien plus qu'une page : heure
d'envoi, fuseau, jours ouvrés, préférence par utilisateur, et surtout la
question de ce qui mérite de sonner. Ça vaut son propre ticket, pas un
branchement glissé en fin de celui-ci.
