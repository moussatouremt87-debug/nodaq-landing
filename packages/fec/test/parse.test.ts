import { describe, expect, it } from "vitest";
import { amountToCents, parseFec } from "../src/index.js";
import { HEADER, balancedRows, build, row } from "./fixtures.js";

describe("amountToCents", () => {
  it("convertit virgule, point, milliers et négatifs en centimes entiers", () => {
    expect(amountToCents("1234,56")).toBe(123_456);
    expect(amountToCents("1234.5")).toBe(123_450);
    expect(amountToCents("1 234,56")).toBe(123_456);
    expect(amountToCents("0,1")).toBe(10);
    expect(amountToCents("-12,05")).toBe(-1205);
    expect(amountToCents("")).toBe(0);
    expect(amountToCents("12,345")).toBeNull();
    expect(amountToCents("abc")).toBeNull();
  });
});

describe("parseFec — variantes éditeurs", () => {
  it("tabulation + virgule (UTF-8) : parse et équilibre", () => {
    const result = parseFec(build(balancedRows(), "\t"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.separator).toBe("tab");
    expect(result.variant).toBe("debit-credit");
    expect(result.entries).toHaveLength(10);
    expect(result.totalDebitCents).toBe(result.totalCreditCents);
    expect(result.totalDebitCents).toBe(630_000);
    const first = result.entries[0]!;
    expect(first.compteNum).toBe("41100001");
    expect(first.debitCents).toBe(120_000);
    expect(first.ecritureDate).toBe("2026-01-10");
    expect(first.ecritureLet).toBe("AA");
  });

  it("pipe + point décimal (style autre éditeur)", () => {
    const rows = balancedRows().map((r) => r.map((c) => c.replace(",", ".")));
    const result = parseFec(build(rows, "|"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.separator).toBe("pipe");
    expect(result.totalDebitCents).toBe(630_000);
  });

  it("ISO-8859-15 : accents décodés, encodage détecté", () => {
    const rows = [
      row({ date: "20260110", compte: "41100001", aux: "C1", auxLib: "Électricité Générale", piece: "F-1", pieceDate: "20260110", debit: "100,00" }),
      row({ date: "20260110", compte: "706000", piece: "F-1", credit: "100,00" }),
    ];
    const bytes = Buffer.from(build(rows, "\t"), "latin1");
    const result = parseFec(new Uint8Array(bytes));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.encoding).toBe("iso-8859-15");
    expect(result.entries[0]!.compAuxLib).toBe("Électricité Générale");
  });

  it("variante BNC Montant/Sens", () => {
    const header = [...HEADER.slice(0, 11), "Montant", "Sens", ...HEADER.slice(13)];
    const rows = [
      row({ date: "20260110", compte: "41100001", aux: "C1", piece: "F-1", debit: "150,00" }),
      row({ date: "20260110", compte: "706000", piece: "F-1", debit: "150,00" }),
    ].map((r, i) => {
      const clone = [...r];
      clone[11] = "150,00";
      clone[12] = i === 0 ? "D" : "C";
      return clone;
    });
    const result = parseFec(build(rows, "\t", header));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.variant).toBe("montant-sens");
    expect(result.entries[0]!.debitCents).toBe(15_000);
    expect(result.entries[1]!.creditCents).toBe(15_000);
  });

  it("en-têtes accentués (« Débit ») et colonne surnuméraire tolérés avec avertissement", () => {
    const header = [...HEADER];
    header[11] = "Débit";
    header[12] = "Crédit";
    header.push("ColonneMaison");
    const rows = balancedRows().map((r) => [...r, "x"]);
    const result = parseFec(build(rows, "\t", header));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some((w) => w.includes("supplémentaire"))).toBe(true);
  });
});

describe("parseFec — rejets francs", () => {
  it("en-tête non conforme", () => {
    const result = parseFec("Foo\tBar\n1\t2\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.line).toBe(1);
  });

  it("date invalide : erreur avec numéro de ligne, sans citer le contenu", () => {
    const rows = balancedRows();
    rows[2]![3] = "20261332";
    const result = parseFec(build(rows));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const error = result.errors.find((e) => e.line === 4);
    expect(error?.message).toContain("EcritureDate");
    expect(error?.message).not.toContain("20261332");
  });

  it("montant invalide et ligne incomplète : erreurs agrégées", () => {
    const rows = balancedRows();
    rows[0]![11] = "12,3,4";
    rows[1] = rows[1]!.slice(0, 5);
    const result = parseFec(build(rows));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("déséquilibre débit/crédit : rejet total", () => {
    const rows = balancedRows();
    rows[0]![11] = "1300,00"; // débit modifié sans contrepartie
    const result = parseFec(build(rows));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.message).toContain("déséquilibre");
  });

  it("fichier vide", () => {
    expect(parseFec("").ok).toBe(false);
    expect(parseFec(HEADER.join("\t")).ok).toBe(false);
  });
});
