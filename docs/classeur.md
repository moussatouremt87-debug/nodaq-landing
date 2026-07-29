# Classeur documentaire photo (ticket 2.16)

Photographier un reçu, une facture fournisseur ou une note de frais depuis son
téléphone, et laisser l'employé virtuel la classer : extraction des champs par
le **tier souverain vision**, classement par mois, **rapprochement bancaire**
en 1 clic, et corrections journalisées qui préparent l'apprentissage.

## Utilisation

/classeur → « Ajouter un document » (photo JPEG/PNG/WebP, 8 Mo max — l'appareil
photo s'ouvre directement sur mobile). Tout **membre** peut capturer et
corriger (l'employé de terrain photographie ses reçus) ; le **rapprochement
bancaire et la suppression** sont réservés à l'owner (mêmes règles que la
trésorerie : données bancaires = tiers délégué exclu).

- **Dédup par empreinte SHA-256** : re-photographier le même fichier ne crée
  rien et le signale.
- **Statuts** : `a_verifier` (extraction automatique) → `verifie` (champs
  confirmés/corrigés) → `rapproche` (lié à une transaction bancaire).
- **Échec du modèle** : le document est classé quand même, champs vides à
  saisir — jamais de photo perdue.

## Extraction (souveraineté)

- La photo part **UNIQUEMENT** par `packages/llm.route()` avec le nouveau
  support d'images (data-URI, allowlist MIME stricte — jamais de SVG).
- **Catégorie `confidentiel` PAR CONSTRUCTION** : dès qu'une image est
  présente, `route()` durcit la catégorie (le classifieur texte ne voit pas le
  contenu de l'image) — une photo ne peut jamais atteindre le tier frontier,
  même avec l'opt-in tenant.
- L'audit hashé couvre **texte + images** ; le contenu du document n'apparaît
  jamais dans les logs, les erreurs ou les réponses d'outils.
- Modèle : le groupe `sovereign-fast` existant (Mistral Small 3.2 sur Scaleway
  Generative APIs) est **multimodal** — aucun nouveau fournisseur.

## Stockage (V1 assumée)

La photo vit dans PostgreSQL (`classeur_documents.photo`, colonne `Bytes`),
région fr-par, sous **RLS + test d'isolation** — servie par une route binaire
authentifiée (`GET /classeur/documents/:id/photo`, `nosniff`, jamais dans une
réponse JSON). La bascule vers l'Object Storage arrivera avec l'infra bucket
(même suivi que l'archivage FEC).

- **Quota** : 500 documents par tenant (8 Mo max chacun) — borne le stockage
  et les appels vision. L'auth est vérifiée **avant** la lecture du corps.
- **Conservation / effacement (art. 17)** : les documents vivent tant que le
  compte est actif ; suppression owner par document (photo comprise), à tout
  moment. Purge automatique par ancienneté : à définir avec la politique de
  conservation produit (suivi).
- **DPIA / registre** : 2.16 est le premier flux qui envoie des documents
  bruts confidentiels à un modèle (endpoint mutualisé Scaleway Generative
  APIs, souverain). À refléter au registre des traitements ; le tier Managed
  Inference dédié (`confidential`) reste la cible.

## Rapprochement bancaire

Candidats = transactions **débit** au montant TTC **exact** (centimes), triés
par proximité de date (±7 j = « date proche »), top 5 — via le client Qonto
existant (fixtures en mode démo). Confirmation 1 clic → statut `rapproche` +
`matchedTransactionId`. Détachable à tout moment.

## Apprentissage (fondation V1)

`originalExtraction` est **figée** au premier classement ; chaque correction
est journalisée en **append-only** (`corrections[] {by, at, fields}`). C'est
le futur jeu d'apprentissage (comparaison extraction/verité terrain) — le
réentraînement effectif est un ticket V2.

## À ne pas faire

- Servir la photo dans une liste ou un JSON (route binaire dédiée uniquement).
- Appeler un modèle vision hors `route()` (la garde de souveraineté est là).
- Ouvrir le rapprochement (labels/montants bancaires) à un rôle non-owner.
