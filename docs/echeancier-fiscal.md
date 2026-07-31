# Échéancier fiscal & social (ticket 2.9)

Quand payer, quand déclarer. Le dernier ticket du sprint réglementaire : après
avoir produit la facture légale (2.3) et l'avoir déposée sur le réseau (2.4),
le produit dit au dirigeant ce qui l'attend le mois prochain.

## Ce n'est pas la veille réglementaire

La confusion serait facile, alors elle est tranchée : **3.7 dit ce qui
s'impose** à l'entreprise (obligations, échéances de réforme, applicabilité par
vertical et effectif). **2.9 dit quand payer**, mois après mois, en fonction du
régime fiscal réel du tenant. L'un est une veille, l'autre un calendrier — et
seul le second produit des **décaissements datés**.

## Doctrine : config versionnée, datée, sourcée

`packages/shared/src/taxCalendar.ts` (`TAX_CALENDAR_VERSION`) porte les règles
de date, chacune avec sa source vérifiée à la date du fichier — même doctrine
que `frenchTax.ts` (2.19), `regulatoryWatch.ts` (3.7) et `rgpdRegister.ts`
(3.9). Les dates d'acompte d'IS ne sont **pas** redupliquées : elles viennent
de `frenchTax.ts`, une seule source.

| Obligation | Règle de date |
|---|---|
| TVA CA3 (réel normal) | mois suivant, **entre le 15 et le 24** selon le SIREN |
| TVA acomptes (simplifié) | 15 juillet (55 %) et 15 décembre (40 %) |
| TVA CA12 (simplifié) | mai, ou 3 mois après une clôture décalée |
| Acomptes IS | 15/03, 15/06, 15/09, 15/12 (CGI 1668) |
| Solde IS | 15 du 4e mois après clôture — **15 mai** si clôture au 31/12 |
| CFE solde / acompte | 15 décembre / 15 juin (acompte si CFE N-1 ≥ 3 000 €) |
| DSN | 5 du mois suivant à partir de 50 salariés, 15 sinon |
| URSSAF trimestrielle | 15/01, 15/04, 15/07, 15/10 |

**La CVAE est absente, et c'est un choix.** Son calendrier de suppression a été
modifié plusieurs fois par les lois de finances successives : publier une date
que nous ne pouvons pas garantir serait pire que de n'en publier aucune.
L'ajouter = éditer ce fichier, avec la source.

## Trois refus, qui font la valeur du calendrier

**1. Ne pas deviner le régime.** `vatRegime` vaut `inconnu` tant que l'owner
n'a rien renseigné, `payrollPeriodicity` vaut `aucune`. Ce ne sont pas des
défauts commodes : ils **bloquent** la génération des échéances
correspondantes, et le trou est écrit noir sur blanc dans `gaps`. Proposer les
échéances d'un régime supposé ferait rater une déclaration ou en préparer une
qui n'existe pas.

**2. Ne pas inventer une date qu'on ne connaît pas.** La date exacte de la CA3
dépend du numéro SIREN et de la forme juridique ; nous ne l'avons pas. La date
affichée est donc la **borne basse** de la fenêtre légale, marquée
`dateIsApproximate: true`, avec la fenêtre complète dans `basis`. Une date
inventée présentée comme certaine vaut moins que rien.

**3. Ne dériver aucun montant.** Le calendrier dit **quand**, pas **combien** —
un test le vérifie littéralement (aucune propriété `amount*` dans la sortie du
moteur). Dériver une TVA due depuis le facturier supposerait une comptabilité
que nous n'avons pas : c'est le même refus qu'en e-reporting (2.4). Les
montants viennent de l'owner, et d'eux seuls.

## Le calendrier n'est jamais stocké

Il est **recalculé à chaque lecture** depuis le catalogue et le profil. Seules
les décisions humaines persistent, dans `tax_deadlines` (RLS + test
d'isolation) : montant déclaré, `paye`, `non_applicable`, note.

Conséquence voulue : changer de régime ne laisse **aucune échéance fantôme**.
Une surcharge qui ne correspond plus à aucune occurrence est simplement
ignorée par `applyTaxOverrides` (testé) — elle ne ressuscite pas une échéance
disparue.

Le revers, assumé : les décisions humaines **survivent**. Un aller-retour de
régime (paie mensuelle → aucune → mensuelle) fait réapparaître les montants
DSN saisis avant, tels quels. C'est le comportement attendu d'un registre de
décisions — les effacer au premier changement de paramètre ferait perdre un
travail de saisie — mais les montants réaffichés datent d'avant et méritent
une relecture. Les bornes SQL (`amount_cents` ≥ 0 et ≤ 100 M€, `note` ≤ 500)
doublent les bornes Zod : un montant négatif écrit hors du chemin API
*diminuerait* le total à décaisser, soit exactement le montant fantôme que ce
ticket refuse.

## Lien trésorerie

`plannedOutflowCents` agrège les échéances **encore à payer dont le montant a
été saisi**. Une échéance sans montant n'y contribue pas et est comptée à part
(`unpricedCount`, jamais tue). C'est la même garde qu'en 2.19
(amortissement ≠ décaissement) : ce qui n'est pas chiffré par un humain ne
touche jamais la trésorerie.

## Surface

| Route | Rôle | Accès |
|---|---|---|
| `GET /echeancier` | échéancier + agrégat à décaisser | owner |
| `GET/PUT /echeancier/profil` | régime fiscal du tenant | owner |
| `PUT /echeancier/deadline` | montant / état d'une occurrence | owner |

Outil agent `check_tax_calendar` **OWNER-ONLY** (le régime fiscal et les
montants d'impôt sont des données de dirigeant) ; page `/echeancier` et carte
cockpit « prochaine échéance ». Réponses en `cache-control: private, no-store`.

Label permanent : *calendrier indicatif issu d'un catalogue versionné — il ne
remplace ni votre expert-comptable ni votre espace professionnel*.

## Limites assumées (V1)

- **Jours ouvrés** : les dates ne sont pas décalées quand elles tombent un
  week-end ou un jour férié. Le report réel dépend du mode de paiement et du
  service ; le faire à leur place introduirait une fausse précision.
- **Pas de télédéclaration** : le produit prépare, l'humain déclare sur son
  espace professionnel. Un dépôt DGFiP automatisé est un ticket à part entière,
  avec la même doctrine HITL que le dépôt PDP (2.4).
- **Pas de rappel automatique** : le socle push (2.17) existe et se branchera
  ici (« échéance dans 7 jours ») quand le regroupement sera arbitré.
