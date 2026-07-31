import { describe, expect, it } from "vitest";
import {
  auditInvoice,
  FacturXInvoice,
  buildCiiXml,
  FACTURX_PROFILES,
  FACTURX_RULES_VERSION,
  OPERATION_CATEGORIES,
} from "../src/index.js";

/*
 * Factur-X (ticket 2.3) — le format légal de la réforme française. Doctrine
 * du repo : les règles normatives sont une CONFIG VERSIONNÉE DATÉE SOURCÉE
 * (comme frenchTax 2.19), et le générateur est PUR — mêmes entrées, même
 * XML, testable sans réseau ni PDF.
 */

const INVOICE: FacturXInvoice = {
  number: "F-2026-0042",
  issueDate: "2026-08-01",
  dueDate: "2026-08-31",
  currency: "EUR",
  operationCategory: "prestation_services",
  seller: {
    name: "Élec Provence SARL",
    siret: "81234567600009",
    vatNumber: "FR12812345676",
    address: { street: "12 rue des Oliviers", postalCode: "13100", city: "Aix-en-Provence" },
  },
  buyer: {
    name: "Boulangerie Martin",
    siret: "52345678800018",
    address: { street: "5 place du Marché", postalCode: "13090", city: "Aix-en-Provence" },
  },
  lines: [
    {
      description: "Remplacement tableau électrique",
      quantity: 1,
      unitPriceCents: 120_000,
      vatRate: 20,
      vatCategory: "S",
    },
    {
      description: "Déplacement",
      quantity: 2,
      unitPriceCents: 4_500,
      vatRate: 20,
      vatCategory: "S",
    },
  ],
  totals: {
    netCents: 129_000,
    vatCents: 25_800,
    grossCents: 154_800,
    dueCents: 154_800,
  },
};

describe("config des profils", () => {
  it("versionnée, datée, chaque profil porte son URN normatif et sa source", () => {
    expect(FACTURX_RULES_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const profile of Object.values(FACTURX_PROFILES)) {
      expect(profile.urn).toMatch(/^urn:/);
      expect(profile.source.url).toMatch(/^https:\/\//);
    }
    // Les URNs sont normatifs : une faute rend la facture non conforme.
    expect(FACTURX_PROFILES.MINIMUM.urn).toBe("urn:factur-x.eu:1p0:minimum");
    expect(FACTURX_PROFILES.BASIC.urn).toBe(
      "urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic",
    );
    expect(FACTURX_PROFILES.EN16931.urn).toBe("urn:cen.eu:en16931:2017");
  });
});

describe("buildCiiXml", () => {
  it("produit un CII bien formé avec l'entête normalisé et le profil demandé", () => {
    const xml = buildCiiXml(INVOICE, "EN16931");
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain(
      'xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"',
    );
    expect(xml).toContain("<ram:ID>urn:cen.eu:en16931:2017</ram:ID>");
    // TypeCode 380 = facture commerciale (UNTDID 1001).
    expect(xml).toContain("<ram:TypeCode>380</ram:TypeCode>");
    expect(xml).toContain("<ram:ID>F-2026-0042</ram:ID>");
    // Format 102 = AAAAMMJJ.
    expect(xml).toContain('<udt:DateTimeString format="102">20260801</udt:DateTimeString>');
  });

  it("les montants sortent en décimal à 2 chiffres, jamais en centimes", () => {
    const xml = buildCiiXml(INVOICE, "EN16931");
    expect(xml).toContain("<ram:LineTotalAmount>1290.00</ram:LineTotalAmount>");
    // currencyID UNIQUEMENT sur TaxTotalAmount (la devise est déclarée une
    // fois par InvoiceCurrencyCode) — ailleurs, signalement Schematron.
    expect(xml).not.toContain('<ram:LineTotalAmount currencyID');
    expect(xml).toContain("<ram:TaxTotalAmount currencyID=\"EUR\">258.00</ram:TaxTotalAmount>");
    expect(xml).toContain("<ram:GrandTotalAmount>1548.00</ram:GrandTotalAmount>");
    expect(xml).toContain("<ram:DuePayableAmount>1548.00</ram:DuePayableAmount>");
    expect(xml).not.toContain("129000");
  });

  it("porte les mentions françaises : SIREN des deux parties et catégorie d'opération", () => {
    const xml = buildCiiXml(INVOICE, "EN16931");
    // SIREN = 9 premiers chiffres du SIRET — mention obligatoire de la
    // réforme, déclarée en SpecifiedLegalOrganization (BT-30/BT-47), PAS
    // en ram:ID de la partie (qui porte l'identifiant commercial BT-29).
    expect(xml).toContain(
      '<ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">812345676</ram:ID></ram:SpecifiedLegalOrganization>',
    );
    expect(xml).toContain("523456788");
    expect(xml).toContain("FR12812345676");
    // La catégorie d'opération est portée en note TEXTUELLE : SubjectCode
    // est une liste fermée (UNTDID 4451) qui n'accueille pas nos valeurs.
    expect(xml).toContain(OPERATION_CATEGORIES.prestation_services.label);
    expect(xml).not.toContain("<ram:SubjectCode>PS</ram:SubjectCode>");
  });

  it("échappe le XML : un nom hostile ne peut pas casser le document", () => {
    const hostile = {
      ...INVOICE,
      buyer: { ...INVOICE.buyer, name: 'ACME <script>&"\'' + "]]>" },
    };
    const xml = buildCiiXml(hostile, "EN16931");
    expect(xml).toContain("ACME &lt;script&gt;&amp;");
    expect(xml).not.toContain("<script>");
    expect(xml).not.toContain("]]>");
  });

  it("une ligne par article, avec quantité, prix unitaire et taux de TVA", () => {
    const xml = buildCiiXml(INVOICE, "EN16931");
    const lineCount = (xml.match(/<ram:IncludedSupplyChainTradeLineItem>/g) ?? []).length;
    expect(lineCount).toBe(2);
    expect(xml).toContain("Remplacement tableau électrique");
    expect(xml).toContain("<ram:RateApplicablePercent>20.00</ram:RateApplicablePercent>");
  });

  it("profil non implémenté : REFUS explicite plutôt qu'un document hors périmètre", () => {
    // MINIMUM/BASIC WL ont leur propre schéma, plus étroit. Émettre un
    // document en forme EN 16931 sous leur URN revendiquerait une
    // conformité que nous n'avons pas.
    expect(() => buildCiiXml(INVOICE, "MINIMUM")).toThrow(/not implemented/);
    expect(() => buildCiiXml(INVOICE, "BASIC_WL")).toThrow(/not implemented/);
    expect(FACTURX_PROFILES.MINIMUM.implemented).toBe(false);
    expect(FACTURX_PROFILES.EN16931.implemented).toBe(true);
  });
});

describe("auditInvoice — conformité AVANT émission", () => {
  it("une facture cohérente ne remonte aucun bloquant", () => {
    const audit = auditInvoice(INVOICE);
    expect(audit.issues.filter((i) => i.severity === "bloquant")).toEqual([]);
    expect(audit.rulesVersion).toBe(FACTURX_RULES_VERSION);
  });

  it("BLOQUANT : totaux incohérents avec les lignes (jamais émis en silence)", () => {
    const wrong = { ...INVOICE, totals: { ...INVOICE.totals, netCents: 100_000 } };
    const audit = auditInvoice(wrong);
    const issue = audit.issues.find((i) => i.code === "total_ht_incoherent");
    expect(issue?.severity).toBe("bloquant");
    expect(issue?.reason).toContain("1290");
  });

  it("BLOQUANT : TVA qui ne correspond pas aux taux des lignes, TTC faux", () => {
    expect(
      auditInvoice({ ...INVOICE, totals: { ...INVOICE.totals, vatCents: 1 } }).issues.some(
        (i) => i.code === "tva_incoherente" && i.severity === "bloquant",
      ),
    ).toBe(true);
    expect(
      auditInvoice({ ...INVOICE, totals: { ...INVOICE.totals, grossCents: 999 } }).issues.some(
        (i) => i.code === "total_ttc_incoherent",
      ),
    ).toBe(true);
  });

  it("BLOQUANT : mentions obligatoires françaises manquantes (SIREN, numéro, dates)", () => {
    const codes = (invoice: FacturXInvoice) => auditInvoice(invoice).issues.map((i) => i.code);
    expect(codes({ ...INVOICE, seller: { ...INVOICE.seller, siret: "" } })).toContain(
      "siret_vendeur_manquant",
    );
    expect(codes({ ...INVOICE, buyer: { ...INVOICE.buyer, siret: "" } })).toContain(
      "siret_acheteur_manquant",
    );
    expect(codes({ ...INVOICE, number: "" })).toContain("numero_manquant");
    // Un SIRET mal formé est aussi bloquant qu'un SIRET absent.
    expect(codes({ ...INVOICE, seller: { ...INVOICE.seller, siret: "123" } })).toContain(
      "siret_vendeur_invalide",
    );
  });

  it("BLOQUANT : taux de TVA hors barème français (une faute de saisie ne passe pas)", () => {
    const audit = auditInvoice({
      ...INVOICE,
      lines: [{ ...INVOICE.lines[0]!, vatRate: 19.6 }],
      totals: { netCents: 120_000, vatCents: 23_520, grossCents: 143_520, dueCents: 143_520 },
    });
    expect(audit.issues.some((i) => i.code === "taux_tva_inconnu")).toBe(true);
  });

  it("ATTENTION : échéance avant émission, ou facture sans ligne", () => {
    expect(
      auditInvoice({ ...INVOICE, dueDate: "2026-07-01" }).issues.some(
        (i) => i.code === "echeance_anterieure",
      ),
    ).toBe(true);
    const empty = auditInvoice({
      ...INVOICE,
      lines: [],
      totals: { netCents: 0, vatCents: 0, grossCents: 0, dueCents: 0 },
    });
    expect(empty.issues.some((i) => i.code === "aucune_ligne")).toBe(true);
  });

  it("exonération de TVA : la mention légale est exigée (art. 261 et suivants)", () => {
    const exempt: FacturXInvoice = {
      ...INVOICE,
      lines: [{ ...INVOICE.lines[0]!, vatRate: 0, vatCategory: "E" }],
      totals: { netCents: 120_000, vatCents: 0, grossCents: 120_000, dueCents: 120_000 },
    };
    expect(auditInvoice(exempt).issues.some((i) => i.code === "mention_exoneration_manquante")).toBe(
      true,
    );
    expect(
      auditInvoice({ ...exempt, vatExemptionReason: "TVA non applicable, art. 293 B du CGI" })
        .issues.some((i) => i.code === "mention_exoneration_manquante"),
    ).toBe(false);
  });
});

/*
 * Non-régression des défauts trouvés par l'audit de conformité : chacun
 * produisait une facture ACCEPTÉE par notre propre audit et invalide au
 * regard d'EN 16931 — le pire des cas pour un document légal.
 */
describe("règles arithmétiques EN 16931 (BR-CO-*)", () => {
  it("BR-CO-14 : la TVA est arrondie PAR TAUX, pas ligne à ligne", () => {
    // 3 x 33,33 € à 20 % : 3 x 6,666 arrondis ligne = 20,01 € ;
    // 99,99 € x 20 % arrondi par taux = 20,00 €. C'est 20,00 qui fait foi.
    const line = { description: "Prestation", quantity: 1, unitPriceCents: 3_333, vatRate: 20, vatCategory: "S" as const };
    const invoice: FacturXInvoice = {
      ...INVOICE,
      lines: [line, line, line],
      totals: { netCents: 9_999, vatCents: 2_001, grossCents: 12_000, dueCents: 12_000 },
    };
    // La valeur "ligne à ligne" est désormais REFUSÉE...
    expect(auditInvoice(invoice).issues.some((i) => i.code === "tva_incoherente")).toBe(true);

    // ...et la valeur par taux passe, avec un XML qui la reprend à l'identique.
    const correct: FacturXInvoice = {
      ...invoice,
      totals: { netCents: 9_999, vatCents: 2_000, grossCents: 11_999, dueCents: 11_999 },
    };
    expect(auditInvoice(correct).issuable).toBe(true);
    const xml = buildCiiXml(correct, "EN16931");
    expect(xml).toContain("<ram:CalculatedAmount>20.00</ram:CalculatedAmount>");
    expect(xml).toContain('<ram:TaxTotalAmount currencyID="EUR">20.00</ram:TaxTotalAmount>');
  });

  it("BR-CO-16 : le montant DÛ est contrôlé (TTC − acompte), jamais libre", () => {
    expect(
      auditInvoice({ ...INVOICE, totals: { ...INVOICE.totals, dueCents: 999_999 } }).issues.some(
        (i) => i.code === "montant_du_incoherent",
      ),
    ).toBe(true);
    // Avec un acompte déclaré, le net à payer diminue d'autant.
    const withDeposit: FacturXInvoice = {
      ...INVOICE,
      prepaidCents: 50_000,
      totals: { ...INVOICE.totals, dueCents: 154_800 - 50_000 },
    };
    expect(auditInvoice(withDeposit).issuable).toBe(true);
    expect(buildCiiXml(withDeposit, "EN16931")).toContain(
      "<ram:TotalPrepaidAmount>500.00</ram:TotalPrepaidAmount>",
    );
  });

  it("catégorie de TVA et taux doivent être compatibles (BR-E-*, BR-Z-*)", () => {
    const exemptAt20 = auditInvoice({
      ...INVOICE,
      vatExemptionReason: "TVA non applicable, art. 293 B du CGI",
      lines: [{ ...INVOICE.lines[0]!, vatCategory: "E", vatRate: 20 }],
      totals: { netCents: 120_000, vatCents: 24_000, grossCents: 144_000, dueCents: 144_000 },
    });
    expect(exemptAt20.issues.some((i) => i.code === "categorie_tva_incoherente")).toBe(true);
    // Et l'exonération n'est PAS recopiée sous un bucket taxé.
    const taxed = buildCiiXml(
      { ...INVOICE, vatExemptionReason: "Mention parasite" },
      "EN16931",
    );
    expect(taxed).not.toContain("<ram:ExemptionReason>");
  });

  it("SIRET : la clé de contrôle est vérifiée, pas seulement la longueur", () => {
    const codes = auditInvoice({
      ...INVOICE,
      seller: { ...INVOICE.seller, siret: "99999999999999" },
    }).issues.map((i) => i.code);
    expect(codes).toContain("siret_vendeur_invalide");
  });

  it("montant négatif : refusé tant que l'avoir (type 381) n'est pas implémenté", () => {
    const credit = auditInvoice({
      ...INVOICE,
      lines: [{ ...INVOICE.lines[0]!, unitPriceCents: -120_000 }],
      totals: { netCents: -120_000, vatCents: -24_000, grossCents: -144_000, dueCents: -144_000 },
    });
    expect(credit.issues.some((i) => i.code === "montant_negatif")).toBe(true);
    expect(credit.issuable).toBe(false);
  });

  it("caractères de contrôle : rejetés à la frontière typée (non échappables en XML)", () => {
    const parsed = FacturXInvoice.safeParse({
      ...INVOICE,
      buyer: { ...INVOICE.buyer, name: "ACME\u0000\u0001" },
    });
    expect(parsed.success).toBe(false);
  });
});
