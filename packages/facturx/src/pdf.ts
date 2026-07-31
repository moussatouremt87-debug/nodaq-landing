import { inflateSync } from "node:zlib";
import {
  AFRelationship,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
  StandardFonts,
} from "pdf-lib";
import type { PDFPage } from "pdf-lib";
import { amount } from "./invoice.js";
import { lineNetCents } from "./vat.js";
import type { FacturXInvoice } from "./invoice.js";
import {
  FACTURX_ATTACHMENT_NAME,
  FACTURX_PROFILES,
  FACTURX_VERSION,
} from "./profiles.js";
import type { FacturXProfile } from "./profiles.js";

/*
 * Factur-X container (ticket 2.3): a PDF/A-3 whose visible page is the human
 * invoice and whose embedded `factur-x.xml` is the machine one — SAME
 * invoice, two readings. The XMP metadata below is what makes a reader
 * (or a PDP) recognise the file as Factur-X; without it the attachment is
 * just a file and the document is not compliant.
 */

/*
 * XMP packet: the Factur-X extension schema, which is what lets a reader or
 * a platform recognise the embedded XML as invoice data.
 *
 * DELIBERATELY ABSENT: the `pdfaid:part 3 / conformance B` claim. The file is
 * not yet a verified PDF/A-3 — standard fonts are not embedded, there is no
 * OutputIntent and no trailer /ID. Claiming a conformity we cannot prove
 * (no veraPDF in CI) would be worse than not claiming it; the strict PDF/A-3
 * marking is its own ticket. See docs/facturx.md.
 */
/** Ceilings for reading a THIRD-PARTY invoice (see extractFacturXXml). */
const MAX_COMPRESSED_BYTES = 4 * 1024 * 1024;
const MAX_XML_BYTES = 4 * 1024 * 1024;

const BOTTOM_MARGIN = 60;
const LINE_HEIGHT = 16;

function xmpMetadata(profile: FacturXProfile, invoiceNumber: string): string {
  const conformance = FACTURX_PROFILES[profile].conformanceLevel;
  const escape = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Facture ${escape(invoiceNumber)}</rdf:li></rdf:Alt></dc:title>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
   <pdfaExtension:schemas>
    <rdf:Bag>
     <rdf:li rdf:parseType="Resource">
      <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
      <pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI>
      <pdfaSchema:prefix>fx</pdfaSchema:prefix>
      <pdfaSchema:property>
       <rdf:Seq>
        <rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentFileName</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>Name of the embedded XML invoice file</pdfaProperty:description></rdf:li>
        <rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentType</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>INVOICE</pdfaProperty:description></rdf:li>
        <rdf:li rdf:parseType="Resource"><pdfaProperty:name>Version</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>Factur-X version</pdfaProperty:description></rdf:li>
        <rdf:li rdf:parseType="Resource"><pdfaProperty:name>ConformanceLevel</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>Factur-X profile</pdfaProperty:description></rdf:li>
       </rdf:Seq>
      </pdfaSchema:property>
     </rdf:li>
    </rdf:Bag>
   </pdfaExtension:schemas>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
   <fx:DocumentType>INVOICE</fx:DocumentType>
   <fx:DocumentFileName>${FACTURX_ATTACHMENT_NAME}</fx:DocumentFileName>
   <fx:Version>${FACTURX_VERSION}</fx:Version>
   <fx:ConformanceLevel>${escape(conformance)}</fx:ConformanceLevel>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/** Minimal human-readable page — replaced by the tenant's own PDF when given. */
async function renderInvoicePage(pdf: PDFDocument, invoice: FacturXInvoice): Promise<void> {
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const newPage = (): { page: PDFPage; y: number } => ({
    page: pdf.addPage([595.28, 841.89]), // A4
    y: 800,
  });
  const first = newPage();
  let page = first.page;
  let y = first.y;
  const draw = (text: string, y: number, size = 10, useBold = false): void => {
    // WinAnsi-safe: the standard fonts cannot encode every character.
    const safe = text.replace(/[^\x20-\xFF]/g, "?");
    page.drawText(safe, { x: 50, y, size, font: useBold ? bold : font });
  };

  y = 780;
  draw(`Facture ${invoice.number}`, y, 18, true);
  y -= 30;
  draw(`Date d'emission : ${invoice.issueDate}`, y);
  if (invoice.dueDate) draw(`Echeance : ${invoice.dueDate}`, (y -= 14));
  y -= 28;
  draw("Emetteur", y, 11, true);
  draw(invoice.seller.name, (y -= 14));
  draw(`${invoice.seller.address.street}`, (y -= 12));
  draw(`${invoice.seller.address.postalCode} ${invoice.seller.address.city}`, (y -= 12));
  if (invoice.seller.siret) draw(`SIRET ${invoice.seller.siret}`, (y -= 12));
  y -= 22;
  draw("Client", y, 11, true);
  draw(invoice.buyer.name, (y -= 14));
  draw(`${invoice.buyer.address.street}`, (y -= 12));
  draw(`${invoice.buyer.address.postalCode} ${invoice.buyer.address.city}`, (y -= 12));
  if (invoice.buyer.siret) draw(`SIRET ${invoice.buyer.siret}`, (y -= 12));

  y -= 30;
  draw("Designation", y, 10, true);
  page.drawText("Qte", { x: 330, y, size: 10, font: bold });
  page.drawText("PU HT", { x: 380, y, size: 10, font: bold });
  page.drawText("TVA", { x: 450, y, size: 10, font: bold });
  page.drawText("Total HT", { x: 490, y, size: 10, font: bold });
  y -= 6;
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.5 });

  // Pagination : la page lisible et le XML doivent décrire la MÊME facture.
  // Tronquer les lignes (ou laisser les totaux sortir de la page) casserait
  // l'équivalence des deux lectures, qui est la définition de Factur-X.
  for (const line of invoice.lines) {
    if (y < BOTTOM_MARGIN + LINE_HEIGHT) ({ page, y } = newPage());
    y -= LINE_HEIGHT;
    draw(line.description.slice(0, 45), y);
    page.drawText(line.quantity.toFixed(2), { x: 330, y, size: 10, font });
    page.drawText(amount(line.unitPriceCents), { x: 380, y, size: 10, font });
    page.drawText(`${line.vatRate}%`, { x: 450, y, size: 10, font });
    page.drawText(amount(lineNetCents(line)), { x: 490, y, size: 10, font });
  }

  // Totaux et mentions légales : jamais orphelins en bas de page.
  const footerHeight = 90;
  if (y < BOTTOM_MARGIN + footerHeight) ({ page, y } = newPage());
  y -= 30;
  draw(`Total HT : ${amount(invoice.totals.netCents)} ${invoice.currency}`, y);
  draw(`TVA : ${amount(invoice.totals.vatCents)} ${invoice.currency}`, (y -= 14));
  draw(`Total TTC : ${amount(invoice.totals.grossCents)} ${invoice.currency}`, (y -= 16), 12, true);
  if (invoice.prepaidCents) {
    draw(`Acompte verse : ${amount(invoice.prepaidCents)} ${invoice.currency}`, (y -= 14));
    draw(`Net a payer : ${amount(invoice.totals.dueCents)} ${invoice.currency}`, (y -= 14), 11, true);
  }
  if (invoice.vatExemptionReason) draw(invoice.vatExemptionReason, (y -= 20), 9);
  if (invoice.note) draw(invoice.note.slice(0, 110), (y -= 14), 9);
}

/**
 * Assembles the Factur-X file. `basePdf` lets a tenant keep its own invoice
 * layout: we then only attach the XML and stamp the metadata, never redraw
 * their document.
 */
export async function buildFacturXPdf(
  invoice: FacturXInvoice,
  xml: string,
  profile: FacturXProfile,
  basePdf?: Uint8Array,
): Promise<Uint8Array> {
  const pdf = basePdf ? await PDFDocument.load(basePdf) : await PDFDocument.create();
  if (!basePdf) await renderInvoicePage(pdf, invoice);

  pdf.setTitle(`Facture ${invoice.number}`);
  pdf.setProducer("NODAQ");
  pdf.setCreator("NODAQ");

  // AFRelationship "Data": the normative marker telling a reader this
  // attachment IS the invoice data, not a random extra file.
  await pdf.attach(new TextEncoder().encode(xml), FACTURX_ATTACHMENT_NAME, {
    mimeType: "text/xml",
    description: "Factur-X invoice data",
    afRelationship: AFRelationship.Data,
    creationDate: new Date(`${invoice.issueDate}T00:00:00Z`),
    modificationDate: new Date(`${invoice.issueDate}T00:00:00Z`),
  });

  // XMP metadata stream (PDF/A-3 B + Factur-X extension schema).
  const metadata = pdf.context.stream(xmpMetadata(profile, invoice.number), {
    Type: PDFName.of("Metadata"),
    Subtype: PDFName.of("XML"),
  });
  pdf.catalog.set(PDFName.of("Metadata"), pdf.context.register(metadata));

  // Objets NON compressés en flux : un validateur PDF/A et un lecteur
  // humain doivent pouvoir inspecter la structure du document.
  return pdf.save({ useObjectStreams: false });
}

/** Walks Names > EmbeddedFiles and yields (name, file specification) pairs. */
function embeddedFiles(pdf: PDFDocument): { name: string; spec: PDFDict }[] {
  const namesDict = pdf.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  const embedded = namesDict?.lookupMaybe(PDFName.of("EmbeddedFiles"), PDFDict);
  const array = embedded?.lookupMaybe(PDFName.of("Names"), PDFArray);
  const files: { name: string; spec: PDFDict }[] = [];
  if (!array) return files;
  for (let index = 0; index + 1 < array.size(); index += 2) {
    const key = array.get(index);
    const spec = array.lookupMaybe(index + 1, PDFDict);
    if (spec && (key instanceof PDFString || key instanceof PDFHexString)) {
      files.push({ name: key.decodeText(), spec });
    }
  }
  return files;
}

/** The embedded file names of a Factur-X PDF. */
export async function listAttachments(pdfBytes: Uint8Array): Promise<string[]> {
  const pdf = await PDFDocument.load(pdfBytes);
  return embeddedFiles(pdf).map((file) => file.name);
}

/**
 * Reads the invoice XML back out of a Factur-X PDF. This is not a test
 * helper: RECEIVING electronic invoices is the first obligation of the
 * reform (1 Sept. 2026), and it starts by extracting this exact file.
 * Returns null when the PDF carries no Factur-X attachment.
 */
export async function extractFacturXXml(pdfBytes: Uint8Array): Promise<string | null> {
  const pdf = await PDFDocument.load(pdfBytes);
  const files = embeddedFiles(pdf);
  const target =
    files.find((file) => file.name.toLowerCase() === FACTURX_ATTACHMENT_NAME) ??
    files.find((file) => file.name.toLowerCase().endsWith(".xml"));
  if (!target) return null;
  const ef = target.spec.lookupMaybe(PDFName.of("EF"), PDFDict);
  const stream = ef?.lookup(PDFName.of("F"));
  if (!(stream instanceof PDFRawStream)) return null;

  // DECOMPRESSION BOMB GUARD (audit 2.3): a 700 KB PDF can carry a Flate
  // stream inflating to 700 MB. `maxOutputLength` makes zlib abort at the
  // ceiling instead of allocating first and failing after — the API process
  // is shared by every tenant and this route is open to any member.
  const raw = stream.getContents();
  if (raw.length > MAX_COMPRESSED_BYTES) return null;
  const filter = stream.dict.lookup(PDFName.of("Filter"));
  const filterName =
    filter instanceof PDFName
      ? filter.decodeText()
      : filter instanceof PDFArray && filter.size() === 1
        ? (filter.get(0) as PDFName).decodeText()
        : "";

  let bytes: Uint8Array;
  if (filterName === "" ) {
    bytes = raw;
  } else if (filterName === "FlateDecode") {
    try {
      bytes = inflateSync(Buffer.from(raw), { maxOutputLength: MAX_XML_BYTES });
    } catch {
      // Dépassement du plafond (bombe) ou flux corrompu : refus PROPRE —
      // l'appelant reçoit "pas de Factur-X", jamais une exception qui
      // remonterait jusqu'au gestionnaire d'erreurs global.
      return null;
    }
  } else {
    // Un filtre exotique sur une pièce jointe de facture n'est pas légitime.
    return null;
  }
  if (bytes.length > MAX_XML_BYTES) return null;
  return new TextDecoder().decode(bytes);
}
