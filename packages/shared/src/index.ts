import { z } from "zod";

/** UUID v4 (identifiants de toutes les entités). */
export const Uuid = z.string().uuid();
export type Uuid = z.infer<typeof Uuid>;

/**
 * Identifiant de tenant. Toute frontière de données (header, payload, outil MCP)
 * qui transporte un tenant DOIT valider avec ce schéma.
 */
export const TenantId = Uuid;
export type TenantId = z.infer<typeof TenantId>;

/** Rôles d'un utilisateur au sein d'un tenant (miroir de l'enum Prisma). */
export const MembershipRole = z.enum(["OWNER", "MEMBER", "ACCOUNTANT"]);
export type MembershipRole = z.infer<typeof MembershipRole>;

/** Payload de création d'une note (démo du pattern « table métier scellée par RLS »). */
export const CreateNoteInput = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(10_000),
});
export type CreateNoteInput = z.infer<typeof CreateNoteInput>;

/** Invariant runtime : jette si la condition est fausse (narrowing TypeScript). */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
