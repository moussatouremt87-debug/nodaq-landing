import { describe, expect, it } from "vitest";
import { deriveReceivables, parseFec } from "../src/index.js";
import { balancedRows, build, row } from "./fixtures.js";

// Après l'échéance estimée de F-003 (01/07) — « échue » = strictement dépassée.
const TODAY = new Date("2026-07-05T12:00:00Z");

function entriesOf(rows: string[][]) {
  const parsed = parseFec(build(rows));
  if (!parsed.ok) throw new Error("fixture invalide");
  return parsed.entries;
}

describe("deriveReceivables — 411 + lettrage", () => {
  it("lettrée = réglée ; non lettrée échue = impayé ; partiel = solde restant", () => {
    const result = deriveReceivables(entriesOf(balancedRows()), { today: TODAY });

    expect(result.customers.map((c) => c.ref).sort()).toEqual(["CALPHA", "CBETA", "CGAMMA"]);
    expect(result.invoices).toHaveLength(3);

    const f001 = result.invoices.find((i) => i.number === "F-001")!;
    expect(f001.settled).toBe(true);
    expect(f001.residualCents).toBe(0);

    // F-002 : 2 500 €, émise le 05/01, échéance estimée 04/02 < 01/07 -> IMPAYÉ.
    const f002 = result.invoices.find((i) => i.number === "F-002")!;
    expect(f002.settled).toBe(false);
    expect(f002.residualCents).toBe(250_000);
    expect(f002.dueDate).toBe("2026-02-04");

    // F-003 : 1 000 € - 400 € d'acompte = 600 € restants, échue au 01/07.
    const f003 = result.invoices.find((i) => i.number === "F-003")!;
    expect(f003.amountCents).toBe(100_000);
    expect(f003.residualCents).toBe(60_000);

    expect(result.openCount).toBe(2);
    expect(result.overdueCount).toBe(2);
    expect(result.overdueCents).toBe(310_000);
  });

  it("non échue = ouverte mais pas impayée", () => {
    const rows = [
      row({ date: "20260625", compte: "41100009", aux: "CREC", auxLib: "Client Récent", piece: "F-9", pieceDate: "20260625", debit: "500,00" }),
      row({ date: "20260625", compte: "706000", piece: "F-9", credit: "500,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    expect(result.openCount).toBe(1);
    expect(result.overdueCount).toBe(0);
  });

  it("écriture 411 sans PieceRef : ignorée avec avertissement ; comptes non-411 ignorés", () => {
    const rows = [
      row({ date: "20260110", compte: "41100001", aux: "C1", debit: "100,00" }),
      row({ date: "20260110", compte: "706000", credit: "100,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    expect(result.invoices).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("sans PieceRef"))).toBe(true);
  });

  it("délai d'échéance configurable", () => {
    const rows = [
      row({ date: "20260101", compte: "41100001", aux: "C1", piece: "F-1", pieceDate: "20260101", debit: "100,00" }),
      row({ date: "20260101", compte: "706000", piece: "F-1", credit: "100,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY, dueDays: 60 });
    expect(result.invoices[0]!.dueDate).toBe("2026-03-02");
  });
});
