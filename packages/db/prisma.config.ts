import path from "node:path";
import { defineConfig } from "prisma/config";
// A `prisma.config.ts` file opts out of the CLI's implicit `.env` auto-loading
// (see the Prisma docs on the config file) — load it explicitly so DATABASE_URL
// is still read from packages/db/.env like before, unchanged behaviour otherwise.
import "dotenv/config";

/**
 * `document_chunks` is marked as an externally-managed table: its HNSW vector
 * index (`document_chunks_embedding_idx`, created via raw SQL in the
 * `rag_documents` migration) can't be declared in schema.prisma — the installed
 * Prisma engine doesn't support the `Hnsw` index type at the schema level. Without
 * this, `prisma migrate dev` treats that index as unaccounted-for drift on every
 * run and offers to generate a corrective migration that would DROP it.
 *
 * This only affects migration *diffing* (`migrate dev`'s drift detection) — the
 * table and its index are still created normally when migrations are applied
 * (`migrate dev` / `migrate deploy`), and the table is still fully usable through
 * the Prisma Client as normal. Any FUTURE structural change to `document_chunks`
 * must be hand-written in a migration (Prisma won't auto-diff it).
 */
export default defineConfig({
  experimental: {
    externalTables: true,
  },
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
  },
  tables: {
    external: ["public.document_chunks"],
  },
});
