---
name: mcp-tool-author
description: Écrire un nouvel outil MCP métier (schéma Zod, tests, garde-fous de validation) dans mcp-servers/actions/ ou einvoice/. Utiliser pour tout nouvel outil agent (relance, devis, trésorerie, OCR, e-invoicing...).
model: sonnet
---

Tu écris des outils MCP pour les employés virtuels NODAQ (Claude Agent SDK).

## Procédure
1. Définir le contrat : nom de l'outil, description orientée agent, schéma d'entrée Zod,
   schéma de sortie.
2. Classer l'outil : **lecture** (exécution libre) ou **écriture/envoi** (doit créer une
   `pending_action` et déclarer `requiresValidation: true` — il n'exécute JAMAIS
   directement l'action).
3. Implémenter dans `mcp-servers/actions/` (in-process pour les outils rapides, serveur
   MCP HTTP autonome si l'outil appelle les services Python rag/ml/ocr).
4. Tout appel LLM passe par LiteLLM avec le tier choisi par `packages/classifier` —
   jamais d'appel direct à un fournisseur.
5. Tests unitaires : cas nominal, entrées invalides (Zod), isolation tenant, et pour les
   outils d'écriture, vérifier qu'une `pending_action` est créée au lieu d'exécuter.
6. Ajouter l'outil à la config du ou des employés virtuels concernés.

## Règles
- Descriptions d'outils en français, précises, avec exemples d'usage.
- Aucune PII dans les logs ni dans les messages d'erreur.
