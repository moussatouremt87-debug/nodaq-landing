import { describe, expect, it } from "vitest";
import {
  auditInvoice,
  buildCiiXml,
  FACTURX_PROFILES,
  FACTURX_RULES_VERSION,
  type FacturXInvoice,
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
    siret: "81234567800017",
    vatNumber: "FR12812345678",
    address: { street: "12 rue des Oliviers", postalCode: "13100", city: "Aix-en-Provence" },
  },
  buyer: {
    name: "Boulangerie Martin",
    siret: "52345678900023",
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
    expect(xml).toContain("<ram:TaxTotalAmount currencyID=\"EUR\">258.00</ram:TaxTotalAmount>");
    expect(xml).toContain("<ram:GrandTotalAmount>1548.00</ram:GrandTotalAmount>");
    expect(xml).toContain("<ram:DuePayableAmount>1548.00</ram:DuePayableAmount>");
    expect(xml).not.toContain("129000");
  });

  it("porte les mentions françaises : SIREN des deux parties et catégorie d'opération", () => {
    const xml = buildCiiXml(INVOICE, "EN16931");
    // SIREN = 9 premiers chiffres du SIRET — mention obligatoire de la réforme.
    expect(xml).toContain("812345678");
    expect(xml).toContain("523456789");
    expect(xml).toContain("FR12812345678");
    expect(xml).toContain(OPERATION_CATEGORIES.prestation_services.code);
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

  it("profil MINIMUM : pas de lignes de détail (le profil ne les porte pas)", () => {
    const xml = buildCiiXml(INVOICE, "MINIMUM");
    expect(xml).toContain("urn:factur-x.eu:1p0:minimum");
    expect(xml).not.toContain("<ram:IncludedSupplyChainTradeLineItem>");
    // Mais les totaux et les parties restent présents.
    expect(xml).toContain("<ram:GrandTotalAmount>1548.00</ram:GrandTotalAmount>");
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
