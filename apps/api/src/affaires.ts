import { z } from "zod";
import {
  computeAffaireMargin,
  type AffaireCostInput,
  type AffaireImputationInput,
  type AffaireMargin,
} from "@nodaq/shared";
import type { TenantClient } from "@nodaq/db";

/*
 * Affaires (ticket 4.1) — accès données et assemblage du calcul.
 *
 * Ce module ne décide RIEN sur les chiffres : il rassemble des entrées et
 * délègue à `computeAffaireMargin` (TS pur, testé contre des cas calculés à la
 * main). Le jour où une règle de marge change, elle change à un seul endroit.
 */

/** Statuts — l'ordre est celui du cycle de vie, il pilote aussi l'affichage. */
export const AFFAIRE_STATUSES = [
  "PROSPECT",
  "DEVIS_ENVOYE",
  "ACCEPTEE",
  "EN_COURS",
  "TERMINEE",
  "PERDUE",
  "ARCHIVEE",
] as const;

export const AFFAIRE_TARGET_TYPES = [
  "classeur_document",
  "transaction_bancaire",
  "facture",
  "charge",
] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Création — seul `label` est exigé : une affaire naît souvent d'un coup de fil. */
export const AffaireCreateInput = z.object({
  label: z.string().min(1).max(200),
  clientName: z.string().min(1).max(200).nullable().optional(),
  prospectId: z.string().uuid().nullable().optional(),
  status: z.enum(AFFAIRE_STATUSES).optional(),
  address: z.string().max(500).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  quotedAmountCents: z.number().int().min(0).nullable().optional(),
  vatRateBps: z.number().int().min(0).max(10_000).nullable().optional(),
  estimatedHours: z.number().int().min(0).nullable().optional(),
  hoursWorked: z.number().int().min(0).nullable().optional(),
  estimatedMaterialCents: z.number().int().min(0).nullable().optional(),
  depositsCents: z.number().int().min(0).nullable().optional(),
  retentionRateBps: z.number().int().min(0).max(10_000).nullable().optional(),
  retentionReleaseDate: isoDate.nullable().optional(),
  startDate: isoDate.nullable().optional(),
  plannedEndDate: isoDate.nullable().optional(),
  actualEndDate: isoDate.nullable().optional(),
});

export const AffaireUpdateInput = AffaireCreateInput.partial();

export const AffaireImputeInput = z.object({
  targetType: z.enum(AFFAIRE_TARGET_TYPES),
  targetId: z.string().min(1).max(200),
  source: z.enum(["AUTO", "CONFIRMEE", "MANUELLE"]).optional(),
  amountCents: z.number().int().nullable().optional(),
  amountBasis: z.enum(["ht", "ttc"]).nullable().optional(),
  subcontract: z.boolean().optional(),
});

/** Un montant sans base, ou une base sans montant, ne veut rien dire. */
export function imputationAmountIsCoherent(input: {
  amountCents?: number | null | undefined;
  amountBasis?: "ht" | "ttc" | null | undefined;
}): boolean {
  const hasAmount = (input.amountCents ?? null) !== null;
  const hasBasis = (input.amountBasis ?? null) !== null;
  return hasAmount === hasBasis;
}

const toNumber = (value: bigint | null): number | null => (value === null ? null : Number(value));

interface AffaireRow {
  quotedAmountCents: bigint | null;
  hoursWorked: number | null;
  estimatedMaterialCents: bigint | null;
  depositsCents: bigint | null;
  retentionRateBps: number | null;
}

interface ImputationRow {
  targetType: string;
  amountCents: bigint | null;
  amountBasis: string | null;
  subcontract: boolean;
}

/**
 * Assemble les entrées du calcul.
 *
 * `hourlyCostCents` vient du profil tenant et vaut `null` tant qu'il n'a pas été
 * saisi : c'est ce `null` qui fera basculer la marge en borne supérieure plutôt
 * que de compter zéro heure de travail.
 */
export function buildCostInput(
  affaire: AffaireRow,
  imputations: readonly ImputationRow[],
  invoicedCents: number,
  hourlyCostCents: number | null,
): AffaireCostInput {
  return {
    quotedAmountCents: toNumber(affaire.quotedAmountCents),
    imputations: imputations.map(
      (row): AffaireImputationInput => ({
        targetType: row.targetType as AffaireImputationInput["targetType"],
        amountCents: toNumber(row.amountCents),
        amountBasis: (row.amountBasis as "ht" | "ttc" | null) ?? null,
        subcontract: row.subcontract,
      }),
    ),
    hoursWorked: affaire.hoursWorked,
    hourlyCostCents,
    invoicedCents,
    // « Non renseigné » vaut zéro DANS LE CALCUL (on n'invente pas d'acompte),
    // mais l'écran, lui, doit distinguer les deux : il lit le champ, pas ceci.
    depositsCents: toNumber(affaire.depositsCents) ?? 0,
    retentionRateBps: affaire.retentionRateBps,
    estimatedMaterialCents: toNumber(affaire.estimatedMaterialCents),
  };
}

/** Charge une affaire et calcule sa marge. `null` si elle n'existe pas (ou autre tenant). */
export async function loadAffaireMargin(
  tx: TenantClient,
  affaireId: string,
  hourlyCostCents: number | null,
): Promise<{ margin: AffaireMargin; invoicedCents: number } | null> {
  const affaire = await tx.affaire.findUnique({ where: { id: affaireId } });
  if (!affaire) return null;
  const [imputations, invoices] = await Promise.all([
    tx.affaireImputation.findMany({ where: { affaireId, revokedAt: null } }),
    tx.fecInvoice.findMany({ where: { affaireId } }),
  ]);
  const invoicedCents = invoices.reduce((total, invoice) => total + Number(invoice.amountCents), 0);
  return {
    margin: computeAffaireMargin(buildCostInput(affaire, imputations, invoicedCents, hourlyCostCents)),
    invoicedCents,
  };
}

/** Sérialisation d'une affaire — les BigInt ne passent pas JSON.stringify. */
export function serializeAffaire(affaire: {
  id: string;
  reference: string;
  label: string;
  clientName: string | null;
  prospectId: string | null;
  status: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  quotedAmountCents: bigint | null;
  vatRateBps: number | null;
  estimatedHours: number | null;
  hoursWorked: number | null;
  estimatedMaterialCents: bigint | null;
  depositsCents: bigint | null;
  retentionRateBps: number | null;
  retentionReleaseDate: Date | null;
  startDate: Date | null;
  plannedEndDate: Date | null;
  actualEndDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  const day = (date: Date | null): string | null => date?.toISOString().slice(0, 10) ?? null;
  return {
    id: affaire.id,
    reference: affaire.reference,
    label: affaire.label,
    clientName: affaire.clientName,
    prospectId: affaire.prospectId,
    status: affaire.status,
    address: affaire.address,
    latitude: affaire.latitude,
    longitude: affaire.longitude,
    quotedAmountCents: toNumber(affaire.quotedAmountCents),
    vatRateBps: affaire.vatRateBps,
    estimatedHours: affaire.estimatedHours,
    hoursWorked: affaire.hoursWorked,
    estimatedMaterialCents: toNumber(affaire.estimatedMaterialCents),
    depositsCents: toNumber(affaire.depositsCents),
    retentionRateBps: affaire.retentionRateBps,
    retentionReleaseDate: day(affaire.retentionReleaseDate),
    startDate: day(affaire.startDate),
    plannedEndDate: day(affaire.plannedEndDate),
    actualEndDate: day(affaire.actualEndDate),
    createdAt: affaire.createdAt.toISOString(),
    updatedAt: affaire.updatedAt.toISOString(),
  };
}

/** Champs de date à convertir avant écriture Prisma. */
export function toPrismaData(input: z.infer<typeof AffaireUpdateInput>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (
      (key === "retentionReleaseDate" ||
        key === "startDate" ||
        key === "plannedEndDate" ||
        key === "actualEndDate") &&
      typeof value === "string"
    ) {
      data[key] = new Date(`${value}T00:00:00.000Z`);
    } else if (
      (key === "quotedAmountCents" ||
        key === "estimatedMaterialCents" ||
        key === "depositsCents") &&
      typeof value === "number"
    ) {
      data[key] = BigInt(value);
    } else {
      data[key] = value;
    }
  }
  return data;
}
