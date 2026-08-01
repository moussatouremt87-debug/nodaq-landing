import { describe, expect, it } from "vitest";
import { deriveReceivables, parseFec } from "../src/index.js";
import { build, row } from "./fixtures.js";

/*
 * Retenue de garantie (US-8 du ticket 2.20) — le test BLOQUANT du lot.
 *
 * Dans le bâtiment, le client retient 5 % jusqu'à la levée des réserves. Ce
 * n'est pas un impayé : c'est une somme non exigible, prévue au marché. Le
 * produit qui relance là-dessus prouve qu'il ne connaît pas le métier — c'est
 * la faute la plus chère en crédibilité devant un artisan.
 *
 * Comptablement, la retenue vit au 4117 (« Clients — Retenues de garantie »).
 * La dérivation filtrait sur `411`, qui INCLUT 4117 : la retenue était donc
 * agrégée à la facture, la laissait non lettrée, et ressortait en impayé.
 */

const TODAY = new Date("2026-07-05T12:00:00Z");

function entriesOf(rows: string[][]) {
  const parsed = parseFec(build(rows));
  if (!parsed.ok) throw new Error("fixture invalide");
  return parsed.entries;
}

/**
 * Chantier de 10 000 € : le client règle 9 500 €, 500 € (5 %) sont retenus au
 * 4117 jusqu'à la levée des réserves. Écritures équilibrées, comme un vrai FEC.
 */
function chantierAvecRetenue(): string[][] {
  return [
    // Facture F-100 : 10 000 € au débit du client, contrepartie 706. Lettrée
    // (« AA ») avec le transfert de retenue et le règlement du solde.
    row({ num: "1", date: "20260110", compte: "41100001", aux: "CBTP", auxLib: "SCI Chantier", piece: "F-100", pieceDate: "20260110", lib: "Facture F-100", debit: "10000,00", let: "AA" }),
    row({ num: "1", date: "20260110", compte: "706000", compteLib: "Prestations", piece: "F-100", pieceDate: "20260110", lib: "Facture F-100", credit: "10000,00" }),
    // Transfert de la retenue : 500 € du 411 vers le 4117 (non exigible).
    row({ num: "2", date: "20260110", compte: "41170001", aux: "CBTP", auxLib: "SCI Chantier", piece: "F-100", lib: "Retenue de garantie 5%", debit: "500,00" }),
    row({ num: "2", date: "20260110", compte: "41100001", aux: "CBTP", auxLib: "SCI Chantier", piece: "F-100", lib: "Retenue de garantie 5%", credit: "500,00", let: "AA" }),
    // Règlement du solde exigible : 9 500 € encaissés et lettrés.
    row({ journal: "BQ", num: "3", date: "20260214", compte: "512000", compteLib: "Banque", piece: "REG-100", lib: "Encaissement", debit: "9500,00" }),
    row({ journal: "BQ", num: "3", date: "20260214", compte: "41100001", aux: "CBTP", auxLib: "SCI Chantier", piece: "F-100", lib: "Règlement F-100", credit: "9500,00", let: "AA" }),
  ];
}

describe("retenue de garantie — jamais un impayé", () => {
  it("BLOQUANT : une facture soldée HORS retenue ne génère aucun impayé", () => {
    const result = deriveReceivables(entriesOf(chantierAvecRetenue()), { today: TODAY });
    const invoice = result.invoices.find((i) => i.number === "F-100");
    expect(invoice).toBeDefined();
    // Le solde exigible est nul : plus rien n'est dû aujourd'hui.
    expect(invoice?.residualCents).toBe(0);
    expect(invoice?.settled).toBe(true);
    // Et surtout : rien à relancer.
    expect(result.overdueCount).toBe(0);
    expect(result.overdueCents).toBe(0);
    expect(result.openCount).toBe(0);
  });

  it("la retenue est CONSERVÉE et affichée à part, jamais effacée", () => {
    const result = deriveReceivables(entriesOf(chantierAvecRetenue()), { today: TODAY });
    const invoice = result.invoices.find((i) => i.number === "F-100");
    // 5 % de 10 000 € : la somme existe, elle n'est simplement pas exigible.
    expect(invoice?.retainedCents).toBe(50_000);
    expect(result.retainedCents).toBe(50_000);
    expect(result.retentionCount).toBe(1);
  });

  it("le montant de la facture reste le montant du marché", () => {
    const result = deriveReceivables(entriesOf(chantierAvecRetenue()), { today: TODAY });
    // Sortir la retenue du solde exigible ne doit pas réécrire le montant
    // facturé : le chantier vaut bien 10 000 €.
    expect(result.invoices.find((i) => i.number === "F-100")?.amountCents).toBe(1_000_000);
  });

  it("un VRAI impayé reste un impayé : la garde ne blanchit pas tout", () => {
    // Même chantier, mais le client n'a rien réglé : 9 500 € exigibles et
    // échus. La retenue reste hors du calcul, le reste est bien dû. Écritures
    // reconstruites (pas de lettrage : rien n'est soldé).
    const rows = [
      row({ num: "1", date: "20260110", compte: "41100001", aux: "CBTP", piece: "F-100", pieceDate: "20260110", lib: "Facture F-100", debit: "10000,00" }),
      row({ num: "1", date: "20260110", compte: "706000", compteLib: "Prestations", piece: "F-100", pieceDate: "20260110", lib: "Facture F-100", credit: "10000,00" }),
      row({ num: "2", date: "20260110", compte: "41170001", aux: "CBTP", piece: "F-100", lib: "Retenue de garantie 5%", debit: "500,00" }),
      row({ num: "2", date: "20260110", compte: "41100001", aux: "CBTP", piece: "F-100", lib: "Retenue de garantie 5%", credit: "500,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    const invoice = result.invoices.find((i) => i.number === "F-100");
    expect(invoice?.residualCents).toBe(950_000);
    expect(invoice?.retainedCents).toBe(50_000);
    expect(result.overdueCount).toBe(1);
    expect(result.overdueCents).toBe(950_000);
  });

  it("sans retenue, rien ne change (non-régression 2.14)", () => {
    const rows = [
      row({ num: "1", date: "20260105", compte: "41100002", aux: "CBETA", piece: "F-200", pieceDate: "20260105", lib: "Facture F-200", debit: "2500,00" }),
      row({ num: "1", date: "20260105", compte: "706000", compteLib: "Prestations", piece: "F-200", pieceDate: "20260105", lib: "Facture F-200", credit: "2500,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    const invoice = result.invoices.find((i) => i.number === "F-200");
    expect(invoice?.retainedCents).toBe(0);
    expect(invoice?.residualCents).toBe(250_000);
    expect(result.overdueCount).toBe(1);
    expect(result.retainedCents).toBe(0);
  });
});
