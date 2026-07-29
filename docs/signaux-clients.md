# Signaux clients — churn / upsell (ticket 3.4)

Analyse **par client** de la cadence, de la récence et de la tendance des
montants sur 24 mois de factures clients, mappée sur des segments
actionnables — même philosophie que la prévision des ventes : un modèle
déterministe, auditable, où **chaque verdict est justifié par ses chiffres**
(le LLM n'invente jamais un nombre, il restitue la `reason` calculée).

## Segments (premier critère satisfait, dans cet ordre)

| Segment | Critère | Lecture métier |
|---|---|---|
| `nouveau` | première facture ≤ 90 j | trop tôt pour juger la régularité |
| `a_risque` | ≥ 3 factures ET silence > max(2 × cadence, 60 j) | client régulier devenu silencieux → churn, à rappeler |
| `en_croissance` | ≥ 3 factures ET panier moyen 2ᵉ moitié ≥ 1,2 × 1ʳᵉ moitié | opportunité de montée en gamme (upsell) |
| `fidele` | ≥ 3 factures, régulier et récent | socle du CA |
| `ponctuel` | 1-2 factures sans régularité | pas de signal exploitable |

La cadence est la moyenne des intervalles entre factures ; la récence est en
jours depuis la dernière facture. Chaque client sort avec `invoiceCount`,
`totalCents`, `lastInvoiceDate`, `recencyDays`, `cadenceDays` et une `reason`
française auto-portante. Tri : `a_risque` d'abord, puis `en_croissance`,
`fidele`, `nouveau`, `ponctuel` — et CA décroissant à segment égal.

## Sources de données

L'interface Pennylane alimente le modèle via le champ `customer { id, name }`
des factures : connecteur Pennylane réel, fixtures du tenant démo (M. Bernard
= cas « à risque » du kit), ou **import FEC** (référence client native des
comptes 411/CompAux). Une facture **sans référence client** est comptée dans
`unattributedInvoices`, jamais écartée en silence : l'analyse annonce ce
qu'elle ne couvre pas.

## Modèle (`mcp-servers/actions/src/customerSignals.ts`, pur)

- Zéro réseau, zéro base : l'appelant fournit les factures
  (`fetchInvoiceWindow`, 24 mois, bornée pages + délai, `truncated` signalé).
- Même discipline que `buildMonthlySeries` : `safeParse` par ligne (une ligne
  malformée est écartée, jamais une exception), montants stricts, EUR
  uniquement, brouillons/annulées exclus.

## Accès (owner only)

CA par client + **noms de clients (PII)** = même statut que les listes de
factures : `analyze_customer_signals` est dans `OWNER_ONLY_TOOLS`, invisible
pour un membre ou un expert-comptable. Lecture seule
(`requiresValidation: false`) : l'outil n'écrit rien — la relance d'un client
à risque passe par les outils d'écriture existants et leur file de
validation. Sortie bornée à 100 clients — bornage **signalé**
(`customersTruncated`), `totalCustomers` reste exact. La fenêtre de 24 mois
est appliquée par le modèle lui-même (minimisation) : une facture plus
ancienne n'entre jamais dans l'analyse, même si la collecte l'a ramenée.

## À ne pas faire

- Exposer un segment, un nom de client ou un CA par client à un rôle
  non-owner.
- Présenter une analyse tronquée (`truncated`) ou partielle
  (`unattributedInvoices` élevé) comme exhaustive.
- Déclencher une action (relance, mail) directement depuis ce signal : HITL
  obligatoire, comme partout.
