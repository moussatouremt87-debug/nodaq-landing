---
name: new-connector
description: Scaffolder un connecteur SaaS français complet — client typé, serveur MCP, tests, doc. Usage — /new-connector <saas> (ex. /new-connector pennylane).
---

# Nouveau connecteur SaaS

Argument attendu : le nom du SaaS (pennylane, qonto, sellsy, sage, ebp, axonaut, silae...).

## Étapes
1. Déléguer au sous-agent `connector-builder` avec le nom du SaaS et, si fournie,
   l'URL de la doc d'API.
2. Structure attendue dans `mcp-servers/connectors/<saas>/` :
   - `client.ts` — client HTTP typé (Zod), auth via `credentials_ref` (Secret Manager, par tenant), retries.
   - `server.ts` — serveur MCP : outils `get_*` (lecture libre) et `create_*`/`push_*`
     (écriture, `requiresValidation: true`).
   - `webhooks.ts` — réception des événements (nouvelle facture, paiement) → événement
     interne pour ingestion RAG + workflows.
   - `*.test.ts` — tests avec mocks d'API, dont un test d'isolation tenant.
   - `README.md` — endpoints couverts, scopes OAuth, limites de rate.
3. Enregistrer le connecteur dans le registre (`connectors` en base : type, credentials_ref, status).
4. Lancer lint + typecheck + tests avant de conclure.

## Garde-fous
- Aucun secret en dur, aucun appel réseau réel dans les tests.
- Passer `rgpd-security-reviewer` sur le diff avant merge.
