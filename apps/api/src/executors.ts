import { z } from "zod";
import { withTenant } from "@nodaq/db";
import { ASSET_CATEGORIES } from "@nodaq/shared";

/*
 * Executors of validated pending actions (ticket 1.6). Runs ONLY after a human
 * approved (validatedBy set) — never from the agent loop. MVP executors are
 * SIMULATED (no real SMTP / accounting write yet): they mark the action done
 * and return metadata-only results. Real side effects will land behind this
 * exact interface. adjust_stock (3.2) is the first REAL executor: the
 * movement is applied atomically, quantity floor at 0.
 */

export type ActionExecutor = (
  payload: unknown,
  context: { tenantId: string; userId?: string },
) => Promise<unknown>;

export type ExecutorRegistry = Record<string, ActionExecutor>;

// Mêmes bornes que l'outil MCP et la route HTTP : le payload est relu depuis
// la DB, la défense en profondeur veut la borne des deux côtés.
const AdjustStockPayload = z.object({
  itemId: z.string().uuid(),
  delta: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((value) => value !== 0),
  reason: z.string().nullish(),
});

const MAX_STOCK_QUANTITY = 1_000_000_000;

/** Réponse à un avis client (3.8) — le brouillon validé est ENREGISTRÉ sur
 * l'avis ; la publication sur la plateforme reste manuelle en V1 (aucune API
 * d'écriture). Strip : le payload transporte aussi rating/source pour la file. */
const RecordReviewReplyPayload = z.object({
  review: z.object({ id: z.string().uuid() }),
  draft: z.string().min(1).max(4_000),
});

/** Proposition d'immobilisation (2.19) — FEC, classeur ou saisie assistée.
 * Bornes larges mais réelles : base <= 100 M€, durée 1 mois..50 ans. */
const CreateFixedAssetPayload = z
  .object({
    label: z.string().min(1).max(200),
    category: z.enum(["informatique", "logiciel", "vehicule", "materiel", "mobilier", "agencement"]),
    inServiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    baseCents: z.number().int().min(1).max(10_000_000_000),
    durationMonths: z.number().int().min(1).max(600),
    method: z.enum(["LINEAIRE", "DEGRESSIF"]).default("LINEAIRE"),
    source: z.enum(["FEC", "DOCUMENT", "MANUEL"]).default("MANUEL"),
    sourceRef: z.string().max(200).nullish(),
    priorDepreciationCents: z.number().int().min(0).default(0),
  })
  // CGI 39 A : le dégressif n'est pas ouvert à toutes les catégories
  // (véhicules de tourisme exclus…) — la config sourcée fait foi.
  .refine(
    (data) => data.method !== "DEGRESSIF" || ASSET_CATEGORIES[data.category].decliningAllowed,
    { message: "declining balance not allowed for this category" },
  );
// (strip, pas strict : le payload transporte aussi des champs d'AFFICHAGE
// pour la file — warnings de dérivation — que l'exécuteur ignore.)

export const defaultExecutors: ExecutorRegistry = {
  send_dunning: () => Promise.resolve({ sent: true, simulated: true }),
  book_invoice: () => Promise.resolve({ booked: true, simulated: true }),
  // EXÉCUTEUR RÉEL (2.19) : crée l'immobilisation UNIQUEMENT après validation
  // humaine — la frontière charge/immobilisation est une décision de gestion.
  create_fixed_asset: async (payload, { tenantId }) => {
    const parsed = CreateFixedAssetPayload.safeParse(payload);
    if (!parsed.success) throw new Error("invalid create_fixed_asset payload");
    const data = parsed.data;
    return withTenant(tenantId, async (tx) => {
      if (data.sourceRef) {
        // Idempotence par référence source (compte FEC, document classeur) :
        // re-valider une proposition déjà exécutée ne duplique jamais.
        const existing = await tx.fixedAsset.findFirst({
          where: { source: data.source, sourceRef: data.sourceRef },
          select: { id: true },
        });
        if (existing) return { fixedAssetId: existing.id, alreadyExisted: true };
      }
      const asset = await tx.fixedAsset.create({
        data: {
          tenantId,
          label: data.label,
          category: data.category,
          inServiceDate: new Date(`${data.inServiceDate}T00:00:00Z`),
          baseCents: BigInt(data.baseCents),
          durationMonths: data.durationMonths,
          method: data.method,
          source: data.source,
          sourceRef: data.sourceRef ?? null,
          priorDepreciationCents: BigInt(data.priorDepreciationCents),
        },
        select: { id: true },
      });
      return { fixedAssetId: asset.id, alreadyExisted: false };
    });
  },
  create_quote: () => Promise.resolve({ created: true, simulated: true }),
  // EXÉCUTEUR RÉEL (3.8) : enregistre la réponse validée sur l'avis. Jamais
  // d'écrasement (idempotent) : un avis déjà répondu reste tel quel.
  record_review_reply: async (payload, { tenantId }) => {
    const parsed = RecordReviewReplyPayload.safeParse(payload);
    // Message générique : une ZodError citerait le brouillon dans `result`.
    if (!parsed.success) throw new Error("invalid record_review_reply payload");
    const { review, draft } = parsed.data;
    return withTenant(tenantId, async (tx) => {
      const { count } = await tx.customerReview.updateMany({
        where: { id: review.id, replyText: null },
        data: { replyText: draft, repliedAt: new Date() },
      });
      if (count === 0) {
        const exists = await tx.customerReview.findUnique({
          where: { id: review.id },
          select: { id: true },
        });
        if (!exists) throw new Error("review not found");
        return { recorded: false, alreadyReplied: true };
      }
      // La réponse est stockée : l'owner la copie sur la plateforme (V1).
      return { recorded: true, publishManually: true };
    });
  },
  submit_reconciliation: () => Promise.resolve({ submitted: true, simulated: true }),
  adjust_stock: async (payload, { tenantId, userId }) => {
    const parsed = AdjustStockPayload.safeParse(payload);
    // Generic message: a ZodError could quote payload fields into `result`.
    if (!parsed.success) throw new Error("invalid adjust_stock payload");
    const { itemId, delta, reason } = parsed.data;
    return withTenant(tenantId, async (tx) => {
      const exists = await tx.stockItem.findUnique({
        where: { id: itemId },
        select: { id: true },
      });
      if (!exists) throw new Error("stock item not found");
      // Plancher/plafond ATOMIQUES (même update conditionnel que la route) :
      // une approbation concurrente d'un autre mouvement ne peut pas faire
      // franchir le zéro.
      const { count } = await tx.stockItem.updateMany({
        where: {
          id: itemId,
          quantity: {
            gte: delta < 0 ? -delta : 0,
            lte: MAX_STOCK_QUANTITY - Math.max(0, delta),
          },
        },
        data: { quantity: { increment: delta } },
      });
      if (count === 0) throw new Error("insufficient stock");
      await tx.stockMovement.create({
        data: {
          tenantId,
          itemId,
          delta,
          reason: reason ?? "validé depuis la file",
          // L'approbateur est journalisé — l'attribution ne vit pas que dans
          // pending_actions.validatedBy.
          createdBy: userId ?? null,
        },
      });
      const item = await tx.stockItem.findUnique({
        where: { id: itemId },
        select: { quantity: true },
      });
      return { adjusted: true, quantity: item?.quantity ?? null };
    });
  },
};
