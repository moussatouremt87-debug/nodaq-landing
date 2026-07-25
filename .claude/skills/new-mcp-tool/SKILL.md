---
name: new-mcp-tool
description: Créer un nouvel outil MCP métier (lecture, ou écriture-à-valider) avec schéma Zod, tests et garde-fous. Usage — /new-mcp-tool <domaine> (ex. /new-mcp-tool draft_dunning).
---

# Nouvel outil MCP

Argument attendu : le domaine/nom de l'outil (ex. `compute_treasury_forecast`,
`draft_dunning`, `format_facturx`).

## Étapes
1. Clarifier le contrat : entrée (schéma Zod), sortie, et surtout la classe de l'outil :
   - **Lecture** → exécution libre.
   - **Écriture/envoi** → l'outil crée une `pending_action` (file de validation 1-clic)
     et déclare `requiresValidation: true`. Il n'exécute JAMAIS l'action directement.
2. Déléguer l'implémentation au sous-agent `mcp-tool-author` :
   emplacement `mcp-servers/actions/` (ou `mcp-servers/einvoice/` pour la facturation
   électronique), in-process si rapide, HTTP si l'outil appelle rag/ml/ocr.
3. Tout appel LLM passe par LiteLLM après classification (`packages/classifier`).
4. Tests : nominal, entrées invalides, isolation tenant, et pour l'écriture la création
   de `pending_action` au lieu de l'exécution.
5. Brancher l'outil dans la config des employés virtuels concernés + mettre à jour la doc.
6. Lint + typecheck + tests verts avant de conclure.
