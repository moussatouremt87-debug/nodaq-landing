# Avis clients / e-réputation (ticket 3.8)

Suivi des avis clients (Google, autres plateformes) et préparation de réponses
publiques — avec la même doctrine que le reste du produit : registre en base
sous RLS, analyse déterministe expliquée, **réponse générée en tier souverain
et TOUJOURS validée par un humain avant d'exister**, publication plateforme
manuelle en V1.

## Registre — `customer_reviews` (RLS)

Avis **enregistrés dans NODAQ** (pas un flux temps réel — le label le dit) :
`source` (`manuel|google|autre`, CHECK), `externalId` (dédup d'import),
`authorName` (PII), `rating` (CHECK 1..5), `text`, `reviewedAt`, et la
réponse validée (`replyText`/`repliedAt`). Unicité
`(tenantId, source, externalId)` : re-importer le même export ne duplique
jamais. Policy `tenant_isolation` + test d'isolation avec preuve.

- **Lecture** : tous les membres — **y compris `accountant`** : choix ASSUMÉ
  (les avis sont déjà publics en ligne, nom d'auteur compris) ; si un tenant
  veut restreindre, c'est un ticket, pas un défaut d'implémentation.
- **Écriture du registre** (saisie, import ≤ 500, suppression) : owner-only.
- **Conservation / effacement (RGPD)** : les avis sont conservés tant qu'ils
  existent sur la plateforme d'origine ; une demande d'effacement de l'auteur
  s'honore via le bouton « Supprimer » de la page (owner) — la suppression
  est définitive (pas de corbeille).
- **API Google Business Profile** (lecture + publication) = connecteur futur ;
  aucun scraping.

## Analyse — modèle pur `reputation.ts`

`analyzeReputation(reviews, now)` — déterministe, zéro I/O, zéro LLM. Les
**noms d'auteurs et les textes n'entrent jamais** dans le modèle ni dans sa
sortie : notes, dates et statut de réponse seulement, alertes par id d'avis.

- Note moyenne, répartition 1..5, taux de réponse.
- Tendance : moyenne 6 derniers mois vs 6 précédents (les deux fenêtres
  doivent avoir des avis — jamais une tendance fabriquée), verdict
  `en_hausse|en_baisse|stable` (± 0,3).
- Alerte : avis ≤ 2/5 de moins de 30 jours sans réponse.
- Zéro avis = rapport vide honnête (`averageRating: null`).

## Réponse à un avis — HITL de bout en bout

Outil `draft_review_reply` (`requiresValidation: true`) :

1. L'avis est relu en base (`withTenant`) ; un avis déjà répondu = refus.
2. Brouillon via `route()` (catégorie `confidentiel`, tier souverain, audit
   hashé). **Minimisation : seuls la note et le texte partent au modèle** —
   jamais le nom de l'auteur ; consigne de réponse générique (pas de PII, pas
   de montant).
3. `pending_action` type `record_review_reply` — le brouillon vit dans la
   file de validation, éditable avant approbation (même flux que les
   relances).
4. **Exécuteur réel** : à l'approbation, la réponse est enregistrée sur
   l'avis (`replyText`), **jamais un écrasement** (un avis déjà répondu reste
   tel quel — idempotent). La page affiche la réponse « à publier sur la
   plateforme » : le copier-coller est le geste de publication V1.

## Outils, routes, UI

- `analyze_reputation` (lecture seule, tous rôles — agrégats sans PII ni CA).
- Routes : `GET /avis`, `POST /avis` (owner), `POST /avis/import` (owner,
  dédup), `DELETE /avis/:id` (owner), `GET /avis/reputation`,
  `POST /avis/:id/reponse` (membres — la file gate l'exécution, doorbell push
  2.17 branchée).
- Page **Avis clients** : synthèse (moyenne, tendance, alertes négatifs),
  liste avec étoiles et réponses validées, saisie owner ; onglet « Avis »
  dans la file de validation.

## Limites V1 (assumées)

- Pas de connecteur plateforme : import/saisie manuels, publication
  copier-coller (l'exécuteur enregistre, il ne publie pas).
- Analyse sans NLP des textes (sentiment = la note) ; résumés thématiques
  souverains = ticket futur.
- `GET /avis` non paginé (take 200) — pagination avec le connecteur.
