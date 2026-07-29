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
  context: { tenantId: string },
) => Promise<unknown>;

export type ExecutorRegistry = Record<string, ActionExecutor>;

const AdjustStockPayload = z.object({
  itemId: z.string().uuid(),
  delta: z.number().int(),
  reason: z.string().nullish(),
});

export const defaultExecutors: ExecutorRegistry = {
  send_dunning: () => Promise.resolve({ sent: true, simulated: true }),
  book_invoice: () => Promise.resolve({ booked: true, simulated: true }),
  create_quote: () => Promise.resolve({ created: true, simulated: true }),
  submit_reconciliation: () => Promise.resolve({ submitted: true, simulated: true }),
  adjust_stock: async (payload, { tenantId }) => {
    const parsed = AdjustStockPayload.safeParse(payload);
    // Generic message: a ZodError could quote payload fields into `result`.
    if (!parsed.success) throw new Error("invalid adjust_stock payload");
    const { itemId, delta, reason } = parsed.data;
    return withTenant(tenantId, async (tx) => {
      const item = await tx.stockItem.findUnique({
        where: { id: itemId },
        select: { id: true, quantity: true },
      });
      if (!item) throw new Error("stock item not found");
      const quantity = item.quantity + delta;
      if (quantity < 0) throw new Error("insufficient stock");
      await tx.stockItem.update({ where: { id: itemId }, data: { quantity } });
      await tx.stockMovement.create({
        data: { tenantId, itemId, delta, reason: reason ?? "validé depuis la file" },
      });
      return { adjusted: true, quantity };
    });
  },
};
