---
name: add-migration
description: Créer une migration Prisma/SQL avec RLS et test d'isolation tenant. Usage — /add-migration <description> (ex. /add-migration "table pending_actions").
---

# Nouvelle migration

Argument attendu : description du changement de schéma.

## Étapes
1. Déléguer au sous-agent `migration-writer` avec la description.
2. Exigences pour toute nouvelle table métier :
   - `tenant_id` non nullable, FK vers `tenants`, indexé.
   - RLS activée (`ENABLE ROW LEVEL SECURITY` + policy `tenant_isolation` sur
     `current_setting('app.tenant_id')`).
   - Test d'isolation : deux tenants, chacun ne lit/modifie que ses lignes.
   - Credentials/PII sensibles : référence Secret Manager ou chiffré enveloppe,
     jamais en clair.
3. Vérifier en local : `pnpm prisma migrate dev`, puis up + reset, puis tests.
4. Passer `/rgpd-review` si la migration touche des données personnelles.
