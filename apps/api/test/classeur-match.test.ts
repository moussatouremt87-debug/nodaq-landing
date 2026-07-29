import { describe, expect, it } from "vitest";
import { euroToCents, matchTransactions } from "../src/classeur.js";
import type { BankTransactionLike } from "../src/classeur.js";

/*
 * Rapprochement bancaire (ticket 2.16) — logique PURE, sans réseau ni DB :
 * montant exact côté débit, classement par proximité de date, top 5.
 */

function tx(overrides: Partial<BankTransactionLike>): BankTransactionLike {
  return {
    transaction_id: "tx-1",
    amount_cents: 12_000,
    side: "debit",
    settled_at: "2026-06-12T00:00:00Z",
    label: "CB FOURNISSEUR",
    ...overrides,
  };
}

describe("matchTransactions", () => {
  const extraction = { totalInclTax: 120, docDate: "2026-06-10" };

  it("ne retient que les débits au montant EXACT", () => {
    const candidates = matchTransactions(extraction, [
      tx({ transaction_id: "ok" }),
      tx({ transaction_id: "credit", side: "credit" }),
      tx({ transaction_id: "autre-montant", amount_cents: 12_001 }),
      tx({ transaction_id: null, id: null }),
    ]);
    expect(candidates.map((c) => c.transactionId)).toEqual(["ok"]);
    expect(candidates[0]).toMatchObject({ amountCents: 12_000, score: 2 });
  });

  it("score 2 si la date est à ±7 j, 1 sinon ; tri par score puis proximité", () => {
    const candidates = matchTransactions(extraction, [
      tx({ transaction_id: "loin", settled_at: "2026-07-30T00:00:00Z" }),
      tx({ transaction_id: "proche", settled_at: "2026-06-11T00:00:00Z" }),
      tx({ transaction_id: "tres-proche", settled_at: "2026-06-10T12:00:00Z" }),
    ]);
    expect(candidates.map((c) => c.transactionId)).toEqual(["tres-proche", "proche", "loin"]);
    expect(candidates.map((c) => c.score)).toEqual([2, 2, 1]);
  });

  it("sans date sur le document, le montant seul suffit (score 1)", () => {
    const candidates = matchTransactions({ totalInclTax: 120, docDate: null }, [tx({})]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.score).toBe(1);
  });

  it("top 5 maximum", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      tx({ transaction_id: `tx-${i}`, settled_at: `2026-06-${String(10 + i).padStart(2, "0")}T00:00:00Z` }),
    );
    expect(matchTransactions(extraction, many)).toHaveLength(5);
  });

  it("montant absent ou nul => aucun candidat", () => {
    expect(matchTransactions({ totalInclTax: null, docDate: "2026-06-10" }, [tx({})])).toEqual([]);
    expect(matchTransactions({ totalInclTax: 0, docDate: "2026-06-10" }, [tx({})])).toEqual([]);
  });

  it("euroToCents arrondit au centime (pas de dérive flottante)", () => {
    expect(euroToCents(120)).toBe(12_000);
    expect(euroToCents(19.99)).toBe(1_999);
    expect(euroToCents(0.1 + 0.2)).toBe(30);
  });
});
