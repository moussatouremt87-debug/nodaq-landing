# ADR-006 — Boucle d'agent souveraine : loop model-agnostic sur `route()`, Claude Agent SDK différé

**Statut** : accepté (ticket 1.6, spike §0) · **Date** : 2026-07-25

## Contexte

L'employé virtuel Compta/Direction raisonne sur de la donnée `confidentiel`. Le
Claude Agent SDK exécute sa boucle sur des modèles Claude (Anthropic, hors UE) :
utilisé tel quel, chaque itération de raisonnement enverrait la donnée hors du
tier souverain. Le ticket 1.6 imposait un spike : SDK branché sur LiteLLM
(endpoint compatible Anthropic `/v1/messages`) servant Mistral EU, OU boucle
tool-calling model-agnostic.

## Constats du spike (vérifiés sur `@anthropic-ai/claude-agent-sdk` 0.3.220)

1. **Plomberie possible** : le SDK spawne un exécutable Claude Code et accepte
   `env` (donc `ANTHROPIC_BASE_URL`) et `pathToClaudeCodeExecutable` — pointer
   LiteLLM `/v1/messages` est mécaniquement faisable.
2. **Mais la boucle contourne `packages/llm.route()`** : les appels d'inférence
   du SDK partent de son propre client, SANS passer par
   classify → policy → garde dure → audit. C'est une violation **structurelle**
   de la règle n°1 du CLAUDE.md, quel que soit le modèle derrière l'endpoint :
   - pas de classification par itération (un tour de boucle peut brasser du
     contenu plus sensible que le précédent) ;
   - pas de ligne d'audit `classifications` pour l'inférence agent (trou RGPD) ;
   - la garde dure anti-frontier ne s'applique pas au chemin le plus actif du
     produit.
3. **Fidélité non validable ici** : évaluer le tool-calling de Mistral EU servi
   en `/v1/messages` exige une vraie clé (Mistral La Plateforme). Environnement
   de dev sans clé ⇒ le critère « fidélité OK » du ticket ne peut pas être
   établi honnêtement. Le ticket prévoit ce cas : issue « Insuffisant ».

## Décision

**Boucle tool-calling model-agnostic, construite sur `packages/llm.routeChat()`
(nouvelle API sœur de `route()`), pour TOUS les tiers du MVP.**

- Chaque itération de la boucle passe par routeChat : classification du contenu
  de la conversation, politique tenant, **garde dure** anti-frontier, appel
  LiteLLM `/v1/chat/completions` (tools OpenAI-compatible), **audit hashé**.
  La souveraineté de la boucle est une propriété structurelle, pas une config.
- Les outils de l'agent sont les serveurs MCP existants (connecteurs 1.2,
  actions 1.4/1.5) **liés au tenant à la construction**, plus `rag_search`
  (service 1.3, tenant injecté côté serveur, jamais par l'agent).
- Le Claude Agent SDK reste la **voie d'upgrade documentée** pour le tier
  `non_sensible` uniquement, conditionnée à : (a) un spike de fidélité avec une
  vraie clé souveraine, (b) une couche d'intégration qui restaure classification
  + audit par itération. Ré-évaluer quand l'un des deux débloque.

## Conséquences

- \+ Souveraineté et audit RGPD garantis par construction sur le chemin agent.
- \+ Indépendance fournisseur (OpenAI-compatible = Scaleway, Mistral, vLLM).
- \+ Testable hors-ligne (faux serveur OpenAI-compatible, CI sans clé).
- \− On ré-implémente la boucle (itérations bornées, parsing tool_calls,
  gestion d'erreurs) — code possédé dans `apps/agent-runtime`.
- \− Pas des capacités avancées du SDK (sous-agents, hooks, compaction) pour
  l'instant ; à réévaluer avec la voie d'upgrade ci-dessus.
