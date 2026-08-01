import { describe, expect, it } from "vitest";
import {
  ANOMALY_RULES_VERSION,
  ANOMALY_THRESHOLDS,
  buildMonthlyReport,
} from "../src/monthlyReport.js";
import type { ReportInvoice } from "../src/monthlyReport.js";

/*
 * Rapport mensuel + anomalies (2.11). Le premier ticket qui SYNTHÉTISE : le
 * risque n'est plus la fuite, c'est l'AFFIRMATION. Les tests portent donc sur
 * ce que le rapport refuse de conclure — sans historique, sans référence,
 * sans échantillon.
 */

function invoice(date: string, amount: number, extra: Partial<ReportInvoice> = {}): ReportInvoice {
  return { date, amount, currency: "EUR", status: "paid", ...extra };
}

/** Trois mois à 10 000 € pour servir de référence stable. */
const HISTORY: ReportInvoice[] = [
  invoice("2026-01-10", 5_000),
  invoice("2026-01-20", 5_000),
  invoice("2026-02-10", 5_000),
  invoice("2026-02-20", 5_000),
  invoice("2026-03-10", 5_000),
  invoice("2026-03-20", 5_000),
];

describe("config", () => {
  it("seuils versionnés et datés", () => {
    expect(ANOMALY_RULES_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ANOMALY_THRESHOLDS.revenueDropRatio).toBeGreaterThan(0);
  });
});

describe("ce que le rapport REFUSE de conclure", () => {
  it("historique insuffisant : la règle n'est pas évaluée, et c'est DIT", () => {
    const report = buildMonthlyReport([invoice("2026-04-05", 1_000)], "2026-04");
    expect(report.anomalies.some((a) => a.kind === "ca_en_baisse")).toBe(false);
    expect(report.referenceRevenueCents).toBeNull();
    expect(report.notEvaluated.some((line) => line.includes("historique"))).toBe(true);
  });

  it("mois de référence sans CA réel : aucune comparaison, et le trou est DIT", () => {
    // Les lignes à zéro (et les avoirs) ne sont pas du chiffre d'affaires :
    // elles ne créent donc AUCUNE référence. « +∞ % » n'est pas un constat.
    const months = [
      invoice("2026-01-10", 0),
      invoice("2026-02-10", 0),
      invoice("2026-03-10", 0),
      invoice("2026-04-10", 5_000),
    ];
    const report = buildMonthlyReport(months, "2026-04");
    expect(report.anomalies.some((a) => a.kind === "ca_en_baisse")).toBe(false);
    expect(report.referenceRevenueCents).toBeNull();
    expect(report.excludedCount).toBe(3);
    expect(report.notEvaluated.some((line) => line.includes("historique"))).toBe(true);
  });

  it("aucun client rattaché : la concentration n'est pas « sans anomalie », elle est NON ÉVALUÉE", () => {
    const report = buildMonthlyReport([...HISTORY, invoice("2026-04-10", 9_000)], "2026-04");
    expect(report.anomalies.some((a) => a.kind === "concentration_client")).toBe(false);
    expect(report.topCustomer).toBeNull();
    expect(report.notEvaluated.some((line) => line.includes("Concentration client"))).toBe(true);
  });

  it("mois sans aucun CA retenu : concentration non évaluée plutôt que « rien à signaler »", () => {
    const report = buildMonthlyReport(HISTORY, "2026-04");
    expect(report.revenueCents).toBe(0);
    expect(report.notEvaluated.some((line) => line.includes("Concentration client"))).toBe(true);
  });

  it("trop peu de factures : pas de « facture inhabituelle »", () => {
    const report = buildMonthlyReport(
      [invoice("2026-04-10", 100_000), invoice("2026-04-11", 100)],
      "2026-04",
    );
    expect(report.anomalies.some((a) => a.kind === "facture_inhabituelle")).toBe(false);
    expect(report.notEvaluated.some((line) => line.includes("Facture inhabituelle"))).toBe(true);
  });

  it("aucun impayé le mois précédent : pas de « hausse » sans référence", () => {
    const report = buildMonthlyReport(
      [...HISTORY, invoice("2026-04-10", 8_000, { status: "late" })],
      "2026-04",
    );
    expect(report.anomalies.some((a) => a.kind === "impayes_en_hausse")).toBe(false);
    expect(report.notEvaluated.some((line) => line.includes("impayés"))).toBe(true);
  });
});

describe("anomalies — des écarts MESURÉS", () => {
  it("baisse du CA : valeur, référence et seuil sont tous portés", () => {
    const report = buildMonthlyReport([...HISTORY, invoice("2026-04-10", 5_000)], "2026-04");
    const anomaly = report.anomalies.find((a) => a.kind === "ca_en_baisse");
    expect(anomaly).toBeDefined();
    expect(anomaly?.observed).toBe(500_000);
    expect(anomaly?.reference).toBe(1_000_000);
    expect(anomaly?.threshold).toBe(ANOMALY_THRESHOLDS.revenueDropRatio);
    expect(anomaly?.sampleSize).toBe(3);
    // La phrase porte les chiffres : le modèle n'a rien à inventer.
    expect(anomaly?.reason).toContain("−50 %");
    expect(anomaly?.reason).toContain("seuil");
  });

  it("une baisse SOUS le seuil n'est pas signalée", () => {
    const report = buildMonthlyReport([...HISTORY, invoice("2026-04-10", 9_000)], "2026-04");
    expect(report.anomalies.some((a) => a.kind === "ca_en_baisse")).toBe(false);
  });

  it("facture inhabituelle : comparée à la MÉDIANE, pas à la moyenne", () => {
    // Avec une moyenne, la grosse facture se masquerait elle-même.
    const report = buildMonthlyReport(
      [...HISTORY, invoice("2026-04-10", 60_000), invoice("2026-04-11", 5_000)],
      "2026-04",
    );
    const anomaly = report.anomalies.find((a) => a.kind === "facture_inhabituelle");
    expect(anomaly).toBeDefined();
    expect(anomaly?.reference).toBe(500_000);
    expect(anomaly?.reason).toContain("pas forcément une erreur");
  });

  it("concentration client : part chiffrée, seuil affiché", () => {
    const report = buildMonthlyReport(
      [
        ...HISTORY,
        invoice("2026-04-10", 9_000, { customer: { id: "c1", name: "Gros Client" } }),
        invoice("2026-04-11", 1_000, { customer: { id: "c2", name: "Petit" } }),
      ],
      "2026-04",
    );
    const anomaly = report.anomalies.find((a) => a.kind === "concentration_client");
    expect(anomaly).toBeDefined();
    expect(report.topCustomer?.name).toBe("Gros Client");
    expect(report.topCustomer?.share).toBeCloseTo(0.9, 2);
    expect(anomaly?.reason).toContain("90 %");
  });

  it("impayés en hausse : comparés au mois précédent", () => {
    const report = buildMonthlyReport(
      [
        ...HISTORY,
        invoice("2026-03-25", 1_000, { status: "late" }),
        invoice("2026-04-10", 5_000, { status: "late" }),
      ],
      "2026-04",
    );
    const anomaly = report.anomalies.find((a) => a.kind === "impayes_en_hausse");
    expect(anomaly).toBeDefined();
    expect(anomaly?.observed).toBe(500_000);
    expect(anomaly?.reference).toBe(100_000);
  });
});

describe("invariants", () => {
  it("devise étrangère et lignes illisibles : comptées, jamais converties", () => {
    const report = buildMonthlyReport(
      [
        ...HISTORY,
        invoice("2026-04-10", 5_000, { currency: "USD" }),
        invoice("2026-04-11", 5_000, { date: null }),
        { amount: null, date: "2026-04-12", currency: "EUR", status: "paid", customer: null },
      ],
      "2026-04",
    );
    expect(report.unusableCount).toBe(3);
    expect(report.revenueCents).toBe(0);
  });

  it("brouillons et annulées : écartés du CA comme dans la prévision, et comptés", () => {
    // Deux écrans du même produit ne peuvent pas compter la même facture
    // différemment : la liste d'exclusion est celle de 3.1, partagée.
    const report = buildMonthlyReport(
      [
        ...HISTORY,
        invoice("2026-04-10", 5_000),
        invoice("2026-04-11", 90_000, { status: "draft" }),
        invoice("2026-04-12", 90_000, { status: "cancelled" }),
      ],
      "2026-04",
    );
    expect(report.revenueCents).toBe(500_000);
    expect(report.excludedCount).toBe(2);
    // Et un brouillon démesuré ne devient pas une « facture inhabituelle ».
    expect(report.anomalies.some((a) => a.kind === "facture_inhabituelle")).toBe(false);
  });

  it("montant malformé : écarté, jamais tronqué en un CA faux", () => {
    // « 12abc » lu comme 12 € entrerait dans le rapport comme une donnée sûre.
    const report = buildMonthlyReport(
      [...HISTORY, invoice("2026-04-10", 5_000), invoice("2026-04-11", "12abc" as never)],
      "2026-04",
    );
    expect(report.revenueCents).toBe(500_000);
    expect(report.unusableCount).toBe(1);
  });

  it("chaque anomalie porte une phrase chiffrée et un seuil", () => {
    const report = buildMonthlyReport(
      [
        ...HISTORY,
        invoice("2026-03-25", 1_000, { status: "late" }),
        invoice("2026-04-10", 5_000, { status: "late", customer: { id: "c1", name: "X" } }),
      ],
      "2026-04",
    );
    expect(report.anomalies.length).toBeGreaterThan(0);
    for (const anomaly of report.anomalies) {
      expect(anomaly.reason.length).toBeGreaterThan(30);
      expect(anomaly.threshold).toBeGreaterThan(0);
      expect(anomaly.sampleSize).toBeGreaterThan(0);
    }
  });

  it("statut d'impayé : `overdue` compte comme `late`, `pending` NON", () => {
    // Ne reconnaître que « late » afficherait « 0 € d'impayés » comme un
    // constat alors que c'est un défaut de correspondance de statut.
    const withOverdue = buildMonthlyReport(
      [
        ...HISTORY,
        invoice("2026-03-25", 1_000, { status: "overdue" }),
        invoice("2026-04-10", 5_000, { status: "overdue" }),
      ],
      "2026-04",
    );
    expect(withOverdue.overdueCents).toBe(500_000);
    expect(withOverdue.anomalies.some((a) => a.kind === "impayes_en_hausse")).toBe(true);

    // « pending » = pas encore exigible : ce n'est pas un impayé.
    const withPending = buildMonthlyReport(
      [...HISTORY, invoice("2026-04-10", 5_000, { status: "pending" })],
      "2026-04",
    );
    expect(withPending.overdueCents).toBe(0);
  });

  it("retenue de garantie (US-8) : hors encours échu, mais TOUJOURS dans le CA", () => {
    // 5 000 € facturés dont 500 € retenus au 4117 jusqu'à la levée des
    // réserves. La retenue est due mais pas exigible : la compter en impayé
    // ferait monter « les impayés » sans qu'un client soit en retard — et la
    // règle `impayes_en_hausse` pousserait à relancer là-dessus.
    const report = buildMonthlyReport(
      [...HISTORY, invoice("2026-04-10", 5_000, { status: "late", retained_amount: 500 })],
      "2026-04",
    );
    expect(report.overdueCents).toBe(450_000);
    expect(report.overdueCount).toBe(1);
    // Le chantier vaut bien 5 000 € : sortir la retenue de l'encours échu ne
    // réécrit pas le chiffre d'affaires.
    expect(report.revenueCents).toBe(500_000);
  });

  it("retenue = TOUT le solde : aucun impayé compté, mais le retrait est DIT", () => {
    const report = buildMonthlyReport(
      [...HISTORY, invoice("2026-04-10", 5_000, { status: "late", retained_amount: 5_000 })],
      "2026-04",
    );
    expect(report.overdueCents).toBe(0);
    expect(report.overdueCount).toBe(0);
    // Sortir d'un compteur sans un mot, c'est une donnée qui disparaît.
    expect(report.overdueNotClaimableCount).toBe(1);
    expect(report.revenueCents).toBe(500_000);
  });

  it("solde restant dû connu : il fait foi, et la retenue n'est PAS redéduite", () => {
    // Facture de 5 000 € dont 500 € retenus, 2 000 € déjà encaissés : il
    // reste 2 500 € exigibles. Repartir du montant facturé en redéduisant la
    // retenue donnerait 4 500 € — on réclamerait une somme déjà perçue ; et
    // déduire la retenue d'un solde qui en est déjà net compterait les 5 %
    // deux fois, effaçant une créance réelle.
    const report = buildMonthlyReport(
      [
        ...HISTORY,
        invoice("2026-04-10", 5_000, {
          status: "late",
          retained_amount: 500,
          residual_amount: 2_500,
        }),
      ],
      "2026-04",
    );
    expect(report.overdueCents).toBe(250_000);
    expect(report.overdueCount).toBe(1);
    // Le CA reste le montant du marché.
    expect(report.revenueCents).toBe(500_000);
  });

  it("solde restant dû nul : la facture échue sort de l'encours, et c'est DIT", () => {
    // Facture encaissée mais restée « late » côté facturier (lettrage non
    // fait, cas fréquent en PME). L'encours ne doit pas la compter — et son
    // retrait ne doit pas être muet.
    const report = buildMonthlyReport(
      [...HISTORY, invoice("2026-04-10", 5_000, { status: "late", residual_amount: 0 })],
      "2026-04",
    );
    expect(report.overdueCents).toBe(0);
    expect(report.overdueNotClaimableCount).toBe(1);
  });

  it("une levée de réserves n'est pas une vente, mais son solde est bien un impayé", () => {
    // Pièce à montant facturé NUL (ce n'est pas une vente : elle n'entre pas
    // au CA) et à solde exigible : 500 € redevenus dus après la levée. La
    // laisser sortir avec les brouillons et les avoirs faisait dire deux
    // chiffres d'impayés différents au rapport et au connecteur, pour la
    // même donnée.
    const report = buildMonthlyReport(
      [
        ...HISTORY,
        invoice("2026-04-10", 5_000),
        { date: "2026-04-12", amount: 0, currency: "EUR", status: "late", residual_amount: 500 },
      ],
      "2026-04",
    );
    expect(report.overdueCents).toBe(50_000);
    expect(report.overdueCount).toBe(1);
    // Le CA, lui, ne bouge pas : rien n'a été vendu ce jour-là.
    expect(report.revenueCents).toBe(500_000);
  });

  it("la levée de réserves compte AUSSI dans le mois de référence", () => {
    // L'encours du mois précédent sert de référence à `impayes_en_hausse`.
    // Nourrir le mois courant sans nourrir la référence sous-évalue celle-ci
    // et gonfle la hausse : la règle se déclencherait sur un artefact
    // comptable, c'est-à-dire qu'elle pousserait à relancer — exactement ce
    // que ce ticket ferme.
    const report = buildMonthlyReport(
      [
        ...HISTORY,
        invoice("2026-04-10", 5_000),
        { date: "2026-03-12", amount: 0, currency: "EUR", status: "late", residual_amount: 300 },
        { date: "2026-04-12", amount: 0, currency: "EUR", status: "late", residual_amount: 500 },
      ],
      "2026-04",
    );
    expect(report.overdueCents).toBe(50_000);
    // La référence connaît les 300 € de mars : la hausse est MESURÉE contre
    // eux, pas fabriquée par une asymétrie de comptage (une référence à zéro
    // aurait rendu la règle non évaluable, ou la hausse infinie).
    const anomaly = report.anomalies.find((a) => a.kind === "impayes_en_hausse");
    expect(anomaly?.reference).toBe(30_000);
    expect(anomaly?.observed).toBe(50_000);
  });

  it("un avoir ne devient pas un impayé parce qu'il porte un solde", () => {
    // La branche « pas une vente mais exigible » vise le montant NUL (levée
    // de réserves). Un montant négatif est un avoir : il ne se compte pas en
    // impayé, quoi qu'annonce un `residual_amount`.
    const report = buildMonthlyReport(
      [
        ...HISTORY,
        { date: "2026-04-12", amount: -500, currency: "EUR", status: "unpaid", residual_amount: 500 },
      ],
      "2026-04",
    );
    expect(report.overdueCents).toBe(0);
    expect(report.overdueCount).toBe(0);
  });

  it("factures non attribuées : comptées au CA, jamais tues", () => {
    const report = buildMonthlyReport(
      [
        ...HISTORY,
        invoice("2026-04-10", 5_000, { customer: { id: "c1", name: "Gros Client" } }),
        invoice("2026-04-11", 4_000),
      ],
      "2026-04",
    );
    expect(report.revenueCents).toBe(900_000);
    expect(report.unattributedCount).toBe(1);
    expect(report.unattributedCents).toBe(400_000);
    // La part réelle du premier client peut être plus élevée : c'est DIT.
    const anomaly = report.anomalies.find((a) => a.kind === "concentration_client");
    expect(anomaly?.reason).toContain("plus élevée");
  });

  it("médiane : fenêtre adossée au MOIS ANALYSÉ, pas à la date de consultation", () => {
    // Sinon le même mois change de verdict selon le jour où on l'ouvre.
    const old = Array.from({ length: 8 }, (_, index) =>
      invoice(`2024-0${(index % 8) + 1}-05`, 100_000),
    );
    const withOld = buildMonthlyReport([...old, ...HISTORY, invoice("2026-04-10", 60_000)], "2026-04");
    const withoutOld = buildMonthlyReport([...HISTORY, invoice("2026-04-10", 60_000)], "2026-04");
    // Les factures de 2024 sont hors fenêtre : elles ne déplacent pas la
    // médiane du rapport d'avril 2026.
    expect(withOld.anomalies.find((a) => a.kind === "facture_inhabituelle")?.reference).toBe(
      withoutOld.anomalies.find((a) => a.kind === "facture_inhabituelle")?.reference,
    );
  });

  it("lecture tronquée : les anomalies sont MARQUÉES, pas seulement un drapeau ailleurs", () => {
    const report = buildMonthlyReport([...HISTORY, invoice("2026-04-10", 5_000)], "2026-04", {
      windowTruncated: true,
    });
    expect(report.windowTruncated).toBe(true);
    expect(report.anomalies.length).toBeGreaterThan(0);
    for (const anomaly of report.anomalies) expect(anomaly.reason).toContain("tronquée");
    expect(report.notEvaluated.some((line) => line.includes("tronquée"))).toBe(true);
  });

  it("label PERMANENT : un écart mesuré, pas un jugement", () => {
    const report = buildMonthlyReport(HISTORY, "2026-03");
    expect(report.label).toContain("écart mesuré");
    expect(report.label).toContain("pas un jugement");
  });

  it("mois invalide : refus", () => {
    expect(() => buildMonthlyReport([], "avril")).toThrow();
    expect(() => buildMonthlyReport([], "2026-4")).toThrow();
  });

  it("PURE : deux appels identiques donnent le même rapport", () => {
    expect(buildMonthlyReport(HISTORY, "2026-03")).toEqual(buildMonthlyReport(HISTORY, "2026-03"));
  });
});
