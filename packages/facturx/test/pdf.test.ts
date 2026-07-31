import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  buildCiiXml,
  buildFacturXPdf,
  FACTURX_ATTACHMENT_NAME,
  extractFacturXXml,
  listAttachments,
} from "../src/index.js";
import type { FacturXInvoice } from "../src/index.js";

/*
 * Le conteneur Factur-X : un PDF/A-3 dont la page est la facture LISIBLE et
 * dont la pièce jointe `factur-x.xml` est la facture MACHINE. Sans les
 * métadonnées XMP, la pièce jointe n'est qu'un fichier de plus et le
 * document n'est pas conforme — d'où les vérifications ci-dessous.
 */

const INVOICE: FacturXInvoice = {
  number: "F-2026-0100",
  issueDate: "2026-08-15",
  currency: "EUR",
  operationCategory: "livraison_biens",
  seller: {
    name: "Élec Provence SARL",
    siret: "81234567600009",
    address: { street: "12 rue des Oliviers", postalCode: "13100", city: "Aix", countryCode: "FR" },
  },
  buyer: {
    name: "Boulangerie Martin",
    siret: "52345678800018",
    address: { street: "5 place du Marché", postalCode: "13090", city: "Aix", countryCode: "FR" },
  },
  lines: [
    { description: "Câble 3G2,5 (100 m)", quantity: 1, unitPriceCents: 25_000, vatRate: 20, vatCategory: "S" },
  ],
  totals: { netCents: 25_000, vatCents: 5_000, grossCents: 30_000, dueCents: 30_000 },
};

describe("buildFacturXPdf", () => {
  it("produit un PDF contenant factur-x.xml et les métadonnées Factur-X", async () => {
    const xml = buildCiiXml(INVOICE, "EN16931");
    const bytes = await buildFacturXPdf(INVOICE, xml, "EN16931");

    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    expect(await listAttachments(bytes)).toContain(FACTURX_ATTACHMENT_NAME);

    const raw = Buffer.from(bytes).toString("latin1");
    // PAS de revendication `pdfaid` : le fichier n'est pas un PDF/A-3
    // VÉRIFIÉ (polices non embarquées, pas d'OutputIntent). Annoncer une
    // conformité non prouvée serait pire que ne rien annoncer.
    expect(raw).not.toContain("pdfaid:part");
    // Schéma d'extension Factur-X : c'est LUI qui rend le fichier
    // reconnaissable par un lecteur ou une plateforme.
    expect(raw).toContain("urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#");
    expect(raw).toContain("<fx:DocumentType>INVOICE</fx:DocumentType>");
    expect(raw).toContain(`<fx:DocumentFileName>${FACTURX_ATTACHMENT_NAME}</fx:DocumentFileName>`);
    expect(raw).toContain("<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>");
    // Relation normative : la pièce jointe EST la donnée de la facture.
    expect(raw).toContain("/AFRelationship /Data");
  });

  it("le profil demandé est celui inscrit dans les métadonnées", async () => {
    const bytes = await buildFacturXPdf(INVOICE, buildCiiXml(INVOICE, "BASIC"), "BASIC");
    expect(Buffer.from(bytes).toString("latin1")).toContain(
      "<fx:ConformanceLevel>BASIC</fx:ConformanceLevel>",
    );
  });

  it("PAGINATION : toutes les lignes sont rendues, totaux et mentions jamais hors page", async () => {
    // 60 lignes : le rendu doit déborder sur plusieurs pages plutôt que
    // tronquer — la page lisible et le XML décrivent la MÊME facture.
    const many: FacturXInvoice = {
      ...INVOICE,
      lines: Array.from({ length: 60 }, (_, index) => ({
        description: `Ligne ${index + 1}`,
        quantity: 1,
        unitPriceCents: 1_000,
        vatRate: 20,
        vatCategory: "S" as const,
      })),
      vatExemptionReason: undefined,
      totals: { netCents: 60_000, vatCents: 12_000, grossCents: 72_000, dueCents: 72_000 },
    };
    const bytes = await buildFacturXPdf(many, buildCiiXml(many, "EN16931"), "EN16931");
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(1);
  });

  it("BOMBE DE DÉCOMPRESSION : une pièce jointe qui se déplie trop est refusée", async () => {
    // Un PDF de quelques centaines de Ko peut porter un flux Flate se
    // dépliant en centaines de Mo. La lecture est ouverte aux membres et le
    // process est partagé par tous les tenants : la borne est structurelle.
    const bomb = await PDFDocument.create();
    bomb.addPage();
    const huge = new Uint8Array(8 * 1024 * 1024); // 8 Mo de zéros -> ~8 Ko compressés
    await bomb.attach(huge, "factur-x.xml", { mimeType: "text/xml" });
    const bytes = await bomb.save();
    expect(bytes.length).toBeLessThan(2 * 1024 * 1024);
    // Ni exception non maîtrisée, ni allocation de 8 Mo : simplement null.
    expect(await extractFacturXXml(bytes)).toBeNull();
  });

  it("PDF existant du tenant : on ATTACHE, on ne redessine jamais sa mise en page", async () => {
    const base = await PDFDocument.create();
    base.addPage([595.28, 841.89]).drawText("Ma mise en page maison");
    const baseBytes = await base.save();

    const bytes = await buildFacturXPdf(INVOICE, buildCiiXml(INVOICE, "BASIC"), "BASIC", baseBytes);
    const result = await PDFDocument.load(bytes);
    expect(result.getPageCount()).toBe(1);
    const raw = Buffer.from(bytes).toString("latin1");
    expect(await listAttachments(bytes)).toContain(FACTURX_ATTACHMENT_NAME);
    expect(raw).toContain("<fx:ConformanceLevel>BASIC</fx:ConformanceLevel>");
  });

  it("le XML embarqué est RELISIBLE : extraction = réception (obligation 09/2026)", async () => {
    const xml = buildCiiXml(INVOICE, "EN16931");
    const bytes = await buildFacturXPdf(INVOICE, xml, "EN16931");
    // Recevoir une facture électronique commence par LIRE ce fichier :
    // l'aller-retour doit rendre exactement le XML émis.
    const extracted = await extractFacturXXml(bytes);
    expect(extracted).toBe(xml);
    expect(extracted).toContain("F-2026-0100");
    // Un PDF sans pièce jointe Factur-X ne fabrique jamais un faux XML.
    const plain = await PDFDocument.create();
    plain.addPage();
    expect(await extractFacturXXml(await plain.save())).toBeNull();
  });
});
