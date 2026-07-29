# Notifications push mobile (ticket 2.17)

Web Push (PWA) pour deux catégories : **« Actions à valider »** (nouvelles
`pending_actions`, document du classeur traité) et **« Alertes urgentes »**
(creux de trésorerie projeté < 0 à 30 j, factures en retard critique > 30 j).
Pas d'app native : service worker + Push API (VAPID).

## Décisions non négociables (et où elles vivent)

1. **Le payload ne contient JAMAIS de donnée métier.** La livraison transite
   par les services push des navigateurs (FCM/Google, Apple). Garde
   **structurelle**, pas conventionnelle : `PushPayload` (`apps/api/src/push.ts`)
   est un schéma Zod **clos** (`.strict()`) — `{type, count, deepLink}` avec
   deep-link d'allowlist — construit uniquement par
   `buildPushPayload(category, count)` et re-validé à la porte d'envoi. Un nom
   de client ne peut pas entrer dans un payload sans modifier ce fichier.
   Testé (`apps/api/test/push.test.ts`).
2. **Anti-spam par regroupement.** Les événements s'accumulent par
   (tenant, user, catégorie) dans `push_dispatch_states` : une fenêtre de
   15 min (actions ; alertes = envoi au prochain sweep) → UNE notification
   avec compteur, et **pas de re-notification tant que la file n'a pas été
   ouverte** (ouvrir `/pending-actions` ou le cockpit marque « vu », remet le
   compteur à zéro et réarme).
3. **Opt-in par appareil, préférences par type.** Défaut OFF : un appareil
   n'existe qu'après le geste explicite de l'utilisateur. `push_subscriptions`
   (RLS + test d'isolation) ; réglage/révocation par appareil, scopés à
   l'utilisateur de session. Les clés de subscription **entrent et ne
   ressortent jamais** (aucune réponse ne contient endpoint/p256dh/auth).
4. **iOS = PWA installée requise.** L'écran Réglages > Notifications détecte
   iOS Safari hors PWA et affiche le guide « Ajouter à l'écran d'accueil »
   AVANT toute demande de permission (sinon échec silencieux).

## Architecture du dispatch

Postgres porte l'état de regroupement ; un **sweep en process** dans l'API
(60 s) envoie ce qui est dû et re-évalue les conditions d'alerte toutes les
heures (uniquement pour les tenants ayant au moins un appareil avec alertes
actives — via le **même toolset owner lié au tenant** que le cockpit, chaîne
souveraine incluse). Endpoints morts (410/404) supprimés à l'envoi ; échec
transitoire → retenté au sweep suivant.

> **Pourquoi pas BullMQ ?** Aucun Redis n'est provisionné (local, CI,
> staging). L'envoyeur est injectable et le sweep est une fonction : le swap
> vers BullMQ (jobs différés) se fera sans toucher les appelants quand
> l'infra Redis existera — follow-up assumé.

## Déclencheurs V1

| Événement | Catégorie | Destinataires |
|---|---|---|
| `pending_action` préparée (OCR, relance, stock) | actions | owners (validateurs) |
| Document du classeur traité | actions | l'auteur de la capture |
| Trésorerie projetée < 0 à J+30 (check horaire) | alerts | owners |
| Facture en retard critique > 30 j (check horaire) | alerts | owners |

Échec de sync connecteur / SCA Bridge : **hors V1** — aucun état d'échec de
sync n'est persisté aujourd'hui (pas de sync périodique dans le produit) ; à
brancher quand cette infra existera.

## Clés VAPID

Au coffre (`@nodaq/secrets`) : `PUSH_VAPID_PUBLIC_KEY`,
`PUSH_VAPID_PRIVATE_KEY`, `PUSH_VAPID_SUBJECT` (optionnelles). Génération :
`npx web-push generate-vapid-keys`. **Absentes, la feature dégrade
proprement** : `/push/*` répond 503 « non configuré », le sweep ne démarre
pas, rien d'autre ne change — le déploiement reste vert tant que les clés ne
sont pas provisionnées.

## À ne pas faire

- Ajouter un champ au payload push (même « utile ») : c'est la garde
  structurelle qui saute — refus en revue.
- Notifier sans regroupement (une notif par événement = désinstallation).
- Renvoyer endpoint ou clés d'une subscription dans une réponse API.
- Demander la permission sur iOS Safari sans PWA installée.
