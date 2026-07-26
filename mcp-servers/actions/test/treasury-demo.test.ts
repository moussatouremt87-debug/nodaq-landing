import { describe, expect, it } from "vitest";
import {
  DEMO_DIP_AT_30D_CENTS,
  DEMO_QONTO_BALANCE_CENTS,
  DemoQontoClient,
} from "@nodaq/mcp-connectors";
import { forecastTreasury } from "../src/treasury.js";
import type { TreasuryTransaction } from "../src/treasury.js";

/**
 * Cohérence kit de démo : le pipeline RÉEL de l'outil trésorerie (client Qonto
 * démo -> mapping -> forecastTreasury) doit produire le creux imposé —
 * exactement 8 900,00 € à J+30 — quelle que soit la date d'exécution
 * (les fixtures sont à dates relatives).
 */
describe("prévision de trésorerie sur les fixtures démo", () => {
  it("creux du kit : 8 900,00 € pile à J+30", async () => {
    const qonto = new DemoQontoClient();
    const { organization } = await qonto.getOrganization();
    const account = organization.bank_accounts[0];
    expect(account?.balance_cents).toBe(DEMO_QONTO_BALANCE_CENTS);

    // Même mapping que compute_treasury_forecast (server.ts).
    const { transactions } = await qonto.listTransactions({ perPage: 100 });
    const usable: TreasuryTransaction[] = transactions.flatMap((t) =>
      t.amount_cents != null && t.settled_at && (t.side === "credit" || t.side === "debit")
        ? [{ amountCents: t.amount_cents, side: t.side, settledAt: t.settled_at }]
        : [],
    );
    expect(usable).toHaveLength(transactions.length);

    const forecast = forecastTreasury(DEMO_QONTO_BALANCE_CENTS, usable, new Date());
    expect(forecast.points[0]).toEqual({
      horizonDays: 30,
      projectedBalanceCents: DEMO_DIP_AT_30D_CENTS,
    });
    expect(DEMO_DIP_AT_30D_CENTS).toBe(890_000); // le « creux ~8 900 € » du kit
    // Et la suite de l'histoire : la pente continue de descendre (urgence).
    expect(forecast.points[1]?.projectedBalanceCents).toBeLessThan(890_000);
  });
});
