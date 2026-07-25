---
name: new-employe-virtuel
description: Créer la config d'un nouvel employé virtuel (Compta, Commercial, RH, Direction, Support...) — prompt système, outils MCP, permissions, filtre RAG. Usage — /new-employe-virtuel <dept>.
---

# Nouvel employé virtuel

Argument attendu : le département (compta, commercial, rh, direction, support, juridique).

## Étapes
1. Créer la config d'agent dans `apps/agent-runtime` (un employé = une config
   Claude Agent SDK) :
   - **System prompt** spécialisé métier, en français, orienté « employé qui exécute »,
     pas chatbot.
   - **Sous-ensemble d'outils MCP** strictement nécessaire au département (principe du
     moindre privilège) — lister explicitement, pas de wildcard.
   - **`permissionMode` / garde-fous** : les outils d'écriture passent par la file de
     validation ; refuser tout appel modèle dont le tier ne correspond pas à la
     classification.
   - **Filtre RAG** : collection(s)/départements de documents accessibles.
2. Persister le `session_id` par conversation (reprise de contexte).
3. Ajouter l'employé au front (`apps/web`) : entrée de chat + périmètre documents.
4. Écrire un jeu d'éval minimal pour le workflow principal de cet employé (voir
   sous-agent `rag-evaluator`).
5. Tester en local : l'employé ne voit ni les outils ni les documents des autres
   départements.
