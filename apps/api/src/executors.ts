import { z } from "zod";
import { withTenant } from "@nodaq/db";

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

export const defaultExecutors: ExecutorRegistry = {
  send_dunning: () => Promise.resolve({ sent: true, simulated: true }),
  book_invoice: () => Promise.resolve({ booked: true, simulated: true }),
  create_quote: () => Promise.resolve({ created: true, simulated: true }),
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
