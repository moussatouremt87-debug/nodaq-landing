# Factur-X — génération et lecture (ticket 2.3)

Le format légal de la réforme française de la facturation électronique.
`packages/facturx` produit et relit des factures **Factur-X 1.0** : un
PDF/A-3 dont la page est la facture lisible et dont la pièce jointe
`factur-x.xml` est la même facture, en CII (UN/CEFACT D16B).

## Doctrine — tout ce que la loi fixe est une config versionnée

`src/profiles.ts` (`FACTURX_RULES_VERSION`) porte les valeurs normatives :
URNs de profil, codes de type de document (UNTDID 1001), catégories de TVA
(UNTDID 5305), barème des taux français, catégories d'opération. Une faute
sur un URN rend la facture non conforme : aucune de ces valeurs n'est écrite
en dur ailleurs. Même doctrine que `frenchTax.ts` (2.19) et
`regulatoryWatch.ts` (3.7) — **le calendrier de la réforme reste dans 3.7**,
jamais dupliqué ici.

| Profil | URN | Lignes de détail |
|---|---|---|
| MINIMUM | `urn:factur-x.eu:1p0:minimum` | non |
| BASIC WL | `urn:factur-x.eu:1p0:basicwl` | non |
| BASIC | `urn:cen.eu:en16931:2017#compliant#…:basic` | oui |
| EN 16931 | `urn:cen.eu:en16931:2017` | oui (défaut B2B) |

## Générateur CII — pur

`buildCiiXml(invoice, profile)` : mêmes entrées, mêmes octets. L'ordre des
éléments est **normatif** en CII, donc le document est assemblé
explicitement plutôt que par un mapper générique. Tout texte tiers (nom de
client, désignation) passe par un échappement XML — un `<` non échappé
produirait une facture invalide, un `<` fabriqué serait une injection.
Montants stockés en centimes partout, convertis une seule fois à la
sérialisation.

Un profil sans lignes (MINIMUM, BASIC WL) produit un document **valide pour
ce profil**, jamais une version silencieusement dégradée.

## Audit de conformité — AVANT émission

`auditInvoice(invoice)` est déterministe et bloque ce qui ne doit pas
exister : totaux incohérents avec les lignes, TVA qui ne correspond pas aux
taux, TTC ≠ HT + TVA, taux hors barème français, SIRET absent ou mal formé
(le **SIREN des deux parties** est une mention ajoutée par la réforme),
numéro ou date manquants, absence de mention justificative quand aucune TVA
n'est facturée. Chaque signalement porte ses chiffres. Une facture non
conforme est **refusée avec ses motifs**, pas corrigée en silence — mieux
vaut un refus ici qu'un rejet de la plateforme, ou un redressement plus tard.

## Conteneur PDF/A-3

`buildFacturXPdf()` produit le fichier : page lisible (ou **le PDF existant
du tenant**, simplement complété — on n'impose pas notre mise en page),
pièce jointe `factur-x.xml` marquée `AFRelationship /Data`, et métadonnées
XMP portant l'identification PDF/A-3 niveau B **et le schéma d'extension
Factur-X** (`fx:DocumentType`, `fx:DocumentFileName`, `fx:Version`,
`fx:ConformanceLevel`). Sans ces métadonnées, la pièce jointe n'est qu'un
fichier de plus et le document n'est pas conforme.

## Lecture — la moitié « réception » de l'obligation

`extractFacturXXml(pdf)` relit le XML embarqué. Ce n'est pas un utilitaire
de test : **recevoir** des factures électroniques est la première échéance
(1ᵉʳ septembre 2026) et commence par extraire ce fichier. Un PDF sans
données Factur-X renvoie `null` — jamais un XML fabriqué.

## Routes

| Route | Accès | Rôle |
|---|---|---|
| `POST /factures/facturx` | owner | Audit puis génération (PDF base64 + XML) |
| `POST /factures/facturx/lire` | membres | Extraction du XML d'une facture reçue |

Émettre engage l'entreprise (owner) ; recevoir n'est pas un acte de gestion
(membres). Les données de facturation sont des données client : les erreurs
ne renvoient jamais les champs reçus, et rien n'est journalisé au-delà d'un
nom d'erreur.

## Limites V1 (assumées)

- **Validation par schéma XSD et règles Schematron non embarquée** : l'audit
  couvre la cohérence métier et les mentions françaises, pas la validation
  formelle complète EN 16931. Elle viendra avec le raccordement PDP (2.4),
  qui la fait de toute façon côté plateforme.
- **Placement de la catégorie d'opération** : portée comme note typée en
  attendant que les spécifications externes DGFiP soient figées — la valeur
  est contractuelle, le placement est le nôtre, et c'est dit plutôt que
  présenté comme certain.
- PDF/A-3 sans profil ICC embarqué (OutputIntent) : suffisant pour les
  lecteurs et les plateformes, à compléter si un validateur strict l'exige.
- Pas encore de génération depuis une facture Pennylane/FEC en un clic (la
  route prend une facture normalisée) ni d'avoir (code 381).
