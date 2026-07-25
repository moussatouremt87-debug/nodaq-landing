---
name: rgpd-review
description: Passer la checklist de conformité RGPD/souveraineté/sécurité sur le diff courant avant merge. Usage — /rgpd-review.
---

# Revue RGPD du diff courant

## Étapes
1. Collecter le diff courant (`git diff` + fichiers non commités, ou le diff de la PR).
2. Déléguer l'audit au sous-agent `rgpd-security-reviewer` avec le diff complet.
3. La checklist couvre :
   - Isolation tenant (filtre `tenant_id`, RLS + test d'isolation sur toute nouvelle table).
   - Routage souverain (tout appel LLM via LiteLLM après classification ; `confidentiel`
     ne sort jamais du tier souverain).
   - Minimisation (hash dans les logs, pas de contenu en clair, pas de PII dans les erreurs).
   - Secrets (rien en clair ni commité, lecture Secret Manager).
   - Human-in-the-loop (outils d'écriture → `pending_action`, `requiresValidation: true`).
   - Traçabilité (classifications et validations journalisées).
4. Restituer le verdict (✅ / ⚠️ / ❌) et la liste des findings avec fichier:ligne.
5. Un finding ❌ bloque le merge : corriger puis relancer `/rgpd-review`.
