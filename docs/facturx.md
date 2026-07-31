# Factur-X — génération et lecture (ticket 2.3)

Le format légal de la réforme française de la facturation électronique.
`packages/facturx` produit et relit des factures **Factur-X 1.0** : un PDF
dont la page est la facture lisible et dont la pièce jointe `factur-x.xml`
est la même facture, en CII (UN/CEFACT D16B). Sur l'état exact de la
conformité du conteneur, voir « Conteneur PDF » — la réponse est nuancée,
et elle est dite.

## Doctrine — tout ce que la loi fixe est une config versionnée

`src/profiles.ts` (`FACTURX_RULES_VERSION`) porte les valeurs normatives :
URNs de profil, codes de type de document (UNTDID 1001), catégories de TVA
(UNTDID 5305), barème des taux français, catégories d'opération. Une faute
sur un URN rend la facture non conforme : aucune de ces valeurs n'est écrite
en dur ailleurs. Même doctrine que `frenchTax.ts` (2.19) et
`regulatoryWatch.ts` (3.7) — **le calendrier de la réforme reste dans 3.7**,
jamais dupliqué ici.

| Profil | URN | Émis en V1 |
|---|---|---|
| MINIMUM | `urn:factur-x.eu:1p0:minimum` | **non** (schéma propre, e-reporting) |
| BASIC WL | `urn:factur-x.eu:1p0:basicwl` | **non** (schéma propre) |
| BASIC | `urn:cen.eu:en16931:2017#compliant#…:basic` | oui |
| EN 16931 | `urn:cen.eu:en16931:2017` | oui (défaut B2B) |

MINIMUM et BASIC WL sont catalogués comme **faits normatifs** mais ne sont
pas émis : ils ont leur propre schéma, plus étroit, et produire un document
en forme EN 16931 sous leur URN revendiquerait une conformité que nous
n'avons pas. `buildCiiXml` refuse explicitement. Ils arriveront avec le
raccordement PDP (2.4), qui est leur usage réel.

## Générateur CII — pur

`buildCiiXml(invoice, profile)` : mêmes entrées, mêmes octets. L'ordre des
éléments est **normatif** en CII, donc le document est assemblé
explicitement plutôt que par un mapper générique. Tout texte tiers (nom de
client, désignation) passe par un échappement XML — un `<` non échappé
produirait une facture invalide, un `<` fabriqué serait une injection.
Montants stockés en centimes partout, convertis une seule fois à la
sérialisation.

## Arithmétique : une SEULE ventilation

Les règles `BR-CO-*` d'EN 16931 sont à **tolérance zéro**. Calculer la TVA
deux fois — une par ligne pour l'audit, une par taux pour le XML — produisait
des factures qui passaient notre audit et échouaient la norme (3 lignes de
33,33 € à 20 % : 3 × 6,67 = 20,01 contre 66,66 × 20 % = 20,00). Il y a donc
**une seule** ventilation (`vat.ts`), partagée par l'auditeur et le
sérialiseur : ce qui est validé est exactement ce qui est écrit.

## Audit de conformité — AVANT émission

`auditInvoice(invoice)` est déterministe et bloque ce qui ne doit pas
exister : totaux incohérents avec les lignes, TVA qui ne correspond pas aux
taux, TTC ≠ HT + TVA, taux hors barème français, SIRET absent ou mal formé
(clé de Luhn vérifiée, pas seulement la longueur — le **SIREN des deux
parties** est une mention ajoutée par la réforme), catégorie de TVA
incompatible avec son taux (exonéré à 20 % est une contradiction), montant
dû différent de TTC − acompte (BR-CO-16), montants négatifs (un avoir se
déclare en type 381, non implémenté), numéro ou date manquants, absence de
mention justificative quand aucune TVA n'est facturée. Chaque signalement porte ses chiffres. Une facture non
conforme est **refusée avec ses motifs**, pas corrigée en silence — mieux
vaut un refus ici qu'un rejet de la plateforme, ou un redressement plus tard.

## Conteneur PDF

`buildFacturXPdf()` produit le fichier : page lisible **paginée** (ou **le
PDF existant du tenant**, simplement complété — on n'impose pas notre mise
en page), pièce jointe `factur-x.xml` marquée `AFRelationship /Data`, et
métadonnées XMP portant le **schéma d'extension Factur-X**
(`fx:DocumentType`, `fx:DocumentFileName`, `fx:Version`,
`fx:ConformanceLevel`) qui rendent le fichier reconnaissable.

La page lisible et le XML doivent décrire la **même** facture : c'est la
définition de Factur-X. Le rendu pagine donc au lieu de tronquer, et les
totaux comme les mentions légales ne peuvent pas se retrouver hors page.

⚠️ **Le fichier ne revendique PAS `pdfaid:part 3` (PDF/A-3).** Il n'en est
pas un tant que les polices ne sont pas embarquées et qu'il n'y a ni
OutputIntent ni `/ID` — et nous n'avons pas de validateur (veraPDF) en CI
pour le prouver. Annoncer une conformité invérifiable serait pire que ne
rien annoncer. Le marquage PDF/A-3 strict est un ticket dédié ; en
attendant, le XML — qui porte la valeur légale et que la plateforme
consomme — est le livrable conforme.

## Lecture — la moitié « réception » de l'obligation

`extractFacturXXml(pdf)` relit le XML embarqué. Ce n'est pas un utilitaire
de test : **recevoir** des factures électroniques est la première échéance
(1ᵉʳ septembre 2026) et commence par extraire ce fichier. Un PDF sans
données Factur-X renvoie `null` — jamais un XML fabriqué.

Le fichier lu vient d'un **tiers** : la décompression est bornée
(`maxOutputLength`), un flux qui se déplierait au-delà du plafond est refusé
proprement plutôt que d'allouer d'abord et d'échouer ensuite. Un PDF de
quelques centaines de kilo-octets peut porter un flux se dépliant en
centaines de méga-octets, et le process est partagé par tous les tenants.

## Routes

| Route | Accès | Rôle |
|---|---|---|
| `POST /factures/facturx` | owner | Audit puis génération (PDF base64 + XML) |
| `POST /factures/facturx/lire` | membres | Extraction du XML d'une facture reçue |

Émettre engage l'entreprise (owner) ; recevoir n'est pas un acte de gestion
(membres). Les données de facturation sont des données client : les erreurs
ne renvoient jamais les champs reçus, et rien n'est journalisé au-delà d'un
nom d'erreur.

## Limites V1 (assumées, liste complète)

- **Validation XSD et Schematron non embarquée** : l'audit couvre
  l'arithmétique, la cohérence catégorie/taux et les mentions françaises,
  pas la validation formelle complète EN 16931. Elle viendra avec le
  raccordement PDP (2.4), qui la fait de toute façon côté plateforme.
- **Pas un PDF/A-3 vérifié** (voir ci-dessus) : polices standard non
  embarquées, pas d'OutputIntent ni de `/ID`, XMP non synchronisé avec
  `/Info`. La revendication a été retirée plutôt qu'affichée sans preuve.
- **Catégorie d'opération** : portée en note **textuelle**, sans
  `SubjectCode` — cette liste de codes (UNTDID 4451) est fermée et
  n'accueille pas nos valeurs, y écrire « PS » garantirait un échec de
  validation. Placement à revoir quand les specs DGFiP seront figées.
- **Profils MINIMUM / BASIC WL non émis** (voir tableau).
- **Avoirs (type 381) non pris en charge** : les montants négatifs sont
  bloqués par l'audit plutôt que sortis en type 380 (un avoir mal typé).
- **Moyens de paiement (BG-16 / IBAN) non émis** : le destinataire ne peut
  pas encore payer automatiquement depuis la facture.
- **Date de livraison** émise uniquement si le tenant la fournit — elle
  n'est jamais déduite de la date d'émission (ce serait fabriquer une
  donnée fiscale).
- **`unit`, `currency`, `countryCode` non validés** contre leurs listes de
  codes (Rec. 20 CEE-ONU, ISO 4217, ISO 3166) : échappés donc inoffensifs,
  mais non contrôlés.
- **PDF de base non vérifié** : quand le tenant fournit sa propre mise en
  page, rien ne garantit qu'elle décrit la même facture que le XML.
- Pas encore de génération en un clic depuis une facture Pennylane/FEC (la
  route prend une facture normalisée).
