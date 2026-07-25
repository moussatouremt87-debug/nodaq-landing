---
name: add-migration
description: Créer une table métier complète en un geste — modèle Prisma (tenantId), migration, migration SQL RLS (ENABLE + FORCE + policy) et test d'isolation qui échoue sans la policy. Usage — /add-migration <table> <colonnes> (ex. /add-migration invoices "amount Decimal, dueDate DateTime").
---

# Nouvelle migration (table métier ⇒ RLS + test d'isolation)

Encode la règle n°6 du CLAUDE.md : **toute nouvelle table métier ⇒ `tenantId` +
policy RLS + test d'isolation qui échoue si on retire la policy.**

Arguments : nom de la table + colonnes souhaitées.

## Étapes

1. Déléguer au sous-agent `migration-writer` avec le nom de table et les colonnes.
   Il suit le pattern existant (`notes`) et utilise le template bundlé
   [`rls-template.sql`](rls-template.sql) pour la partie RLS :
   - modèle Prisma : `tenantId String @map("tenant_id") @db.Uuid` non nullable,
     FK `tenants`, indexé, `@@map` snake_case ;
   - `pnpm exec prisma migrate dev --create-only` puis relecture du SQL généré ;
   - bloc RLS depuis le template (ENABLE + FORCE + policy `tenant_isolation`) ;
   - test d'isolation dans `packages/db/test/` calqué sur `isolation.test.ts`,
     y compris le test de preuve (RLS désactivée → fuite, try/finally réactive).
2. Vérifier : `pnpm db:migrate` puis `pnpm --filter @nodaq/db test` — verts.
3. Si la table porte des données personnelles, enchaîner avec le sous-agent
   `rgpd-security-reviewer` sur le diff avant merge.

## Garde-fous

- Une table sans `tenantId` doit être justifiée explicitement (plan auth uniquement —
  cf. `users`/`sessions`/`memberships`) et documentée dans le schéma.
- Jamais de `GRANT` superflu : `app_user` est couvert par les default privileges.
- Le test d'isolation n'est PAS optionnel : pas de merge sans lui.
