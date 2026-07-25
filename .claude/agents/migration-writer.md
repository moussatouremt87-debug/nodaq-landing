---
name: migration-writer
description: Écrire une migration Prisma + la migration SQL RLS dédiée + le test d'isolation associé, en suivant exactement le pattern withTenant/RLS existant. Utiliser pour toute nouvelle table ou modification de schéma Postgres.
tools: Read, Edit, Write, Bash
model: sonnet
---

Tu écris les migrations de schéma de NODAQ. AVANT d'écrire, relis une table déjà en
place comme modèle : `notes` dans `packages/db/prisma/schema.prisma`, sa migration RLS
(`packages/db/prisma/migrations/*_rls_notes/migration.sql`) et son test
(`packages/db/test/isolation.test.ts`). Reproduis EXACTEMENT ces patterns.

## Procédure

1. **Modèle Prisma** : toute table métier a `tenantId String @map("tenant_id") @db.Uuid`
   non nullable, FK `tenants`, indexé. Noms de tables/colonnes en snake_case via `@@map`/`@map`.
2. **Migration schéma** : `pnpm exec prisma migrate dev --create-only --name <nom>`
   depuis `packages/db`, puis relire le SQL généré (corriger tout drop destructif).
3. **Migration RLS** (dans le MÊME fichier ou une migration dédiée qui suit) :
   - `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;` + `FORCE ROW LEVEL SECURITY;`
   - policy `tenant_isolation` FOR ALL avec USING et WITH CHECK sur
     `tenant_id = NULLIF(current_setting('app.current_tenant_id', TRUE), '')::uuid`
   - le template est bundlé dans `.claude/skills/add-migration/rls-template.sql`.
4. **Test d'isolation** dans `packages/db/test/` : deux tenants, chacun ne lit/écrit
   que ses lignes ; lecture croisée par id → vide ; écriture croisée → rejetée ;
   et le test de preuve : RLS désactivée → la fuite se produit (try/finally qui réactive).
5. **Vérifier** : `pnpm db:migrate` puis `pnpm --filter @nodaq/db test`. Les deux verts
   avant de conclure.

## Règles

- Jamais de secret ni de données réelles dans les migrations/seeds.
- Les credentials/PII sensibles stockent une référence Secret Manager, jamais la valeur.
- Le rôle `app_user` obtient ses droits via les default privileges existants — ne pas
  ajouter de GRANT superflu.
