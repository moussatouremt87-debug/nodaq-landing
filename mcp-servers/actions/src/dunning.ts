import { z } from "zod";

/*
 * Late-payment risk scoring — explainable baseline (blueprint MVP): days
 * overdue and amount drive the score. The ML service (XGBoost on payment
 * history) will replace the internals later; the contract stays.
 */

export const ScorableInvoice = z.object({
  invoiceNumber: z.string().nullable(),
  amountCents: z.number().int().positive(),
  /** ISO date the invoice was due — must parse to a real date (an unparsable
   * value would yield NaN => silent "low" band, RGPD audit 1.5). */
  dueDate: z.string().refine((s) => Number.isFinite(new Date(s).getTime()), {
    message: "dueDate must be a parseable date",
  }),
  status: z.string().nullable(),
});
export type ScorableInvoice = z.infer<typeof ScorableInvoice>;

export type RiskBand = "low" | "medium" | "high";

export type LatePaymentScore = {
  daysOverdue: number;
  /** 0..1 — higher = more at risk of never being paid. */
  score: number;
  band: RiskBand;
  signals: string[];
}

export function scoreLatePayment(invoice: ScorableInvoice, now: Date): LatePaymentScore {
  const parsed = ScorableInvoice.parse(invoice);
  const due = new Date(parsed.dueDate).getTime();
  const daysOverdue = Math.max(0, Math.floor((now.getTime() - due) / 86_400_000));

  const signals: string[] = [];
  // Overdue duration saturates at 90 days -> 0.7 contribution.
  const overdueFactor = Math.min(daysOverdue / 90, 1) * 0.7;
  if (daysOverdue > 0) signals.push(`overdue:${daysOverdue}d`);
  // Amount saturates at 10k EUR -> 0.3 contribution (bigger = more attention).
  const amountFactor = Math.min(parsed.amountCents / 1_000_000, 1) * 0.3;
  if (parsed.amountCents >= 500_000) signals.push("large-amount");

  const score = Math.round((overdueFactor + amountFactor) * 100) / 100;
  const band: RiskBand = score >= 0.6 ? "high" : score >= 0.3 ? "medium" : "low";
  return { daysOverdue, score, band, signals };
}
