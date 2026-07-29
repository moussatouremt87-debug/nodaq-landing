import { describe, expect, it } from "vitest";
import { DemoPennylaneClient } from "@nodaq/mcp-connectors";
import { analyzeCustomerSignals } from "../src/customerSignals.js";

/*
 * Signaux clients (ticket 3.4) — modèle PUR, déterministe, explicable :
 * cadence + récence + tendance des montants par client, depuis les factures
 * de l'interface Pennylane (réel / démo / FEC). Segments : « à risque »
 * (régulier devenu silencieux), « en croissance » (panier en hausse),
 * « fidèle », « nouveau », « ponctuel ».
 */

const NOW = new Date("2026-07-29T12:00:00Z");
const DAY = 86_400_000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString().slice(0, 10);
}

function invoice(
  customerId: string,
  date: string,
  amount: string | number,
  extra: Record<string, unknown> = {},
) {
  return {
    date,
    amount,
    status: "paid",
    customer: { id: customerId, name: `Client ${customerId}` },
    ...extra,
  };
}

describe("analyzeCustomerSignals", () => {
  it("détecte le client régulier devenu silencieux (à risque) avec les chiffres justificatifs", () => {
    // Cadence ~30 j pendant 6 mois, puis plus rien depuis 200 j.
    const invoices = Array.from({ length: 6 }, (_, i) =>
      invoice("cus-churn", daysAgo(200 + i * 30), "500.00"),
    );
    const { customers } = analyzeCustomerSignals(invoices, NOW);
    expect(customers).toHaveLength(1);
    const c = customers[0]!;
    expect(c).toMatchObject({
      customerId: "cus-churn",
      customerName: "Client cus-churn",
      segment: "a_risque",
      invoiceCount: 6,
      totalCents: 300_000,
      recencyDays: 200,
      cadenceDays: 30,
    });
    expect(c.lastInvoiceDate).toBe(daysAgo(200));
    // La raison doit être auto-portante : cadence, silence, seuil.
    expect(c.reason).toContain("200");
    expect(c.reason).toContain("30");
  });

  it("un client à cadence régulière et récente est fidèle", () => {
    const invoices = Array.from({ length: 6 }, (_, i) =>
      invoice("cus-fid", daysAgo(15 + i * 30), "500.00"),
    );
    const { customers } = analyzeCustomerSignals(invoices, NOW);
    expect(customers[0]).toMatchObject({ segment: "fidele", cadenceDays: 30, recencyDays: 15 });
  });

  it("détecte la hausse du panier (en croissance / opportunité upsell)", () => {
    // Même cadence, montants x2 entre le début et la fin de période.
    const amounts = ["300.00", "320.00", "340.00", "560.00", "600.00", "640.00"];
    const invoices = amounts.map((amount, i) =>
      invoice("cus-up", daysAgo(15 + (amounts.length - 1 - i) * 30), amount),
    );
    const { customers } = analyzeCustomerSignals(invoices, NOW);
    const c = customers[0]!;
    expect(c.segment).toBe("en_croissance");
    expect(c.reason).toMatch(/hausse/);
  });

  it("première facture récente = nouveau, même sans historique", () => {
    const { customers } = analyzeCustomerSignals(
      [invoice("cus-new", daysAgo(20), "150.00")],
      NOW,
    );
    expect(customers[0]).toMatchObject({ segment: "nouveau", invoiceCount: 1, cadenceDays: null });
  });

  it("un ou deux achats anciens sans régularité = ponctuel", () => {
    const { customers } = analyzeCustomerSignals(
      [invoice("cus-one", daysAgo(240), "80.00"), invoice("cus-one", daysAgo(400), "90.00")],
      NOW,
    );
    expect(customers[0]).toMatchObject({ segment: "ponctuel", invoiceCount: 2 });
  });

  it("compte les factures non attribuées et écarte les lignes invalides sans exception", () => {
    const { customers, analyzedInvoices, unattributedInvoices } = analyzeCustomerSignals(
      [
        invoice("cus-a", daysAgo(10), "100.00"),
        { date: daysAgo(10), amount: "100.00", status: "paid" }, // sans client
        { date: daysAgo(10), amount: "100.00", status: "paid", customer: null },
        invoice("cus-a", daysAgo(40), "abc"), // montant invalide
        invoice("cus-a", daysAgo(40), "100.00", { currency: "USD" }), // devise étrangère
        invoice("cus-a", daysAgo(40), "100.00", { status: "draft" }), // pas une vente
        "garbage" as never, // ligne non conforme : ignorée, jamais une exception
      ],
      NOW,
    );
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({ customerId: "cus-a", invoiceCount: 1 });
    expect(analyzedInvoices).toBe(3);
    expect(unattributedInvoices).toBe(2);
  });

  it("trie : à risque d'abord, puis croissance, puis par chiffre d'affaires décroissant", () => {
    const invoices = [
      // fidèle, gros CA
      ...Array.from({ length: 4 }, (_, i) => invoice("cus-big", daysAgo(10 + i * 30), "5000.00")),
      // à risque, petit CA
      ...Array.from({ length: 4 }, (_, i) => invoice("cus-risk", daysAgo(200 + i * 30), "100.00")),
      // nouveau
      invoice("cus-new", daysAgo(5), "50.00"),
    ];
    const { customers } = analyzeCustomerSignals(invoices, NOW);
    expect(customers.map((c) => c.segment)).toEqual(["a_risque", "fidele", "nouveau"]);
  });

  it("applique la fenêtre de 24 mois : l'historique plus ancien n'entre jamais dans l'analyse", () => {
    const { customers, analyzedInvoices } = analyzeCustomerSignals(
      [
        // Client dont TOUTE l'histoire précède la fenêtre : il ne doit pas
        // être publié (nom + CA) comme « à risque » des années plus tard.
        invoice("cus-old", daysAgo(860), "900.00"),
        invoice("cus-old", daysAgo(820), "900.00"),
        invoice("cus-old", daysAgo(780), "900.00"),
        // Client actif : seule sa facture DANS la fenêtre compte.
        invoice("cus-live", daysAgo(790), "100.00"),
        invoice("cus-live", daysAgo(30), "200.00"),
      ],
      NOW,
    );
    expect(analyzedInvoices).toBe(1);
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({
      customerId: "cus-live",
      invoiceCount: 1,
      totalCents: 20_000,
    });
  });

  it("sans aucune facture attribuée : résultat vide, pas d'erreur", () => {
    const result = analyzeCustomerSignals([], NOW);
    expect(result).toMatchObject({ customers: [], analyzedInvoices: 0, unattributedInvoices: 0 });
  });
});

/**
 * Cohérence kit de démo : le pipeline RÉEL de l'outil (client Pennylane démo
 * -> analyzeCustomerSignals) doit raconter l'histoire attendue quelle que soit
 * la date d'exécution — M. Bernard, client régulier devenu silencieux depuis
 * ~10 mois, est LE cas « à risque » que l'employé doit repérer.
 */
describe("signaux clients sur les fixtures démo", () => {
  it("M. Bernard à risque, SCCV et Syndic fidèles, Bardin nouveau — toutes attribuées", async () => {
    const pennylane = new DemoPennylaneClient();
    const { items } = await pennylane.listCustomerInvoices({ limit: 100 });
    const { customers, unattributedInvoices } = analyzeCustomerSignals(items, new Date());
    expect(unattributedInvoices).toBe(0);
    const bySegment = Object.fromEntries(customers.map((c) => [c.customerId, c.segment]));
    expect(bySegment).toEqual({
      "cus-4": "a_risque",
      "cus-1": "fidele",
      "cus-2": "fidele",
      "cus-3": "nouveau",
    });
    // Tri : le cas à traiter en premier arrive en tête, chiffres à l'appui.
    expect(customers[0]).toMatchObject({ customerId: "cus-4", customerName: "M. Bernard" });
    expect(customers[0]!.reason).toMatch(/silencieux/);
  });
});
