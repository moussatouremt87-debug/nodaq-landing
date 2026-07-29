# Suivi des stocks + alertes (ticket 3.2)

Le matériel du dépôt (câble, disjoncteurs, gaine…) suivi dans nodaq : tout
membre ajuste les quantités (l'employé de terrain sort du matériel), l'owner
gère le référentiel, et les articles sous leur seuil remontent en alerte —
dans le cockpit, la page Stocks et le chat de l'employé.

## Modèle

- `stock_items` : article (nom unique par tenant, unité, quantité, seuil
  d'alerte) — RLS + tests d'isolation.
- `stock_movements` : journal des entrées/sorties (delta ≠ 0, motif, auteur =
  user de session ou approbateur HITL) — **append-only par convention
  applicative** (aucune route ne modifie/supprime un mouvement ; la
  suppression d'un article par l'owner emporte son historique en cascade).
  **La quantité ne se modifie jamais directement** : chaque changement passe
  par un mouvement ; plancher à zéro et plafond appliqués **atomiquement**
  dans l'update conditionnel (deux sorties concurrentes ne franchissent
  jamais le zéro).
- « Sous seuil » = seuil > 0 **et** quantité ≤ seuil (un article neuf à 0
  avec un seuil naît donc en alerte : il est à approvisionner).

## Rôles

| Action | Rôle |
|---|---|
| Consulter | tout membre (accountant compris) |
| Ajuster (mouvements) | owner, member — pas l'expert-comptable (tiers délégué) |
| Créer/modifier articles et seuils, supprimer | owner |

Le stock n'est **pas** une donnée financière : pas de gate owner-only sur la
lecture (contrairement à la trésorerie/CA).

## Alertes

- **Cockpit** : compteur « Stocks sous seuil » (tout membre) — carte visible
  seulement s'il y a des alertes.
- **Page /stocks** : bandeau récapitulatif + ⚠ par article.
- **Chat** : outil `check_stock_alerts` (lecture seule, tous rôles).

## Ajustement par l'agent (HITL, règle n°4)

L'outil `adjust_stock` **prépare** une `pending_action` (article, delta,
motif, quantité avant) — il n'exécute jamais. L'exécuteur (le premier
exécuteur RÉEL du registre) applique le mouvement à l'approbation : plancher
à zéro (stock insuffisant ⇒ action `failed`, quantité intacte), mouvement
journalisé. Payload invalide ⇒ message générique (jamais d'écho Zod).

## À ne pas faire

- Modifier `quantity` sans créer de `stock_movement` (l'historique est la
  vérité).
- Exposer `createdBy` dans les réponses API (métadonnée interne).
