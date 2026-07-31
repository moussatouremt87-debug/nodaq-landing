import { amount, sirenOf } from "./invoice.js";
import type { FacturXInvoice, FacturXLine, FacturXParty } from "./invoice.js";
import {
  DOCUMENT_TYPE_CODES,
  FACTURX_PROFILES,
  OPERATION_CATEGORIES,
  UNTAXED_CATEGORIES,
} from "./profiles.js";
import type { FacturXProfile } from "./profiles.js";
import { computeVatBreakdown, lineNetCents } from "./vat.js";

/*
 * CII (UN/CEFACT Cross Industry Invoice, D16B) serializer — PURE: same
 * invoice in, same bytes out, no clock, no network. The XML is the part that
 * carries legal value, so it is assembled explicitly rather than by a generic
 * object-to-XML mapper: element ORDER is normative in CII, and a misplaced
 * element fails the XSD.
 */

const NAMESPACES = [
  'xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"',
  'xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"',
  'xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100"',
].join(" ");

/**
 * XML text escaping. Third-party data (customer names, descriptions) lands
 * in a legal document: an unescaped "<" would produce an invalid invoice, a
 * crafted one could inject markup. Control characters are rejected upstream,
 * at the typed boundary (invoice.ts) — they are NOT escapable in XML 1.0.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** YYYY-MM-DD -> AAAAMMJJ (UNTDID 2379 format "102"). */
function ciiDate(iso: string): string {
  return iso.replace(/-/g, "").slice(0, 8);
}

function dateElement(tag: string, iso: string): string {
  return `<ram:${tag}><udt:DateTimeString format="102">${ciiDate(iso)}</udt:DateTimeString></ram:${tag}>`;
}

/**
 * A trade party. The legal registration identifier (BT-30/BT-47 — the SIREN,
 * a mandatory mention of the French reform for BOTH parties) belongs in
 * SpecifiedLegalOrganization, NOT in the party's ram:ID (which carries the
 * commercial identifier BT-29).
 */
function partyXml(tag: string, party: FacturXParty): string {
  const siren = sirenOf(party.siret);
  return [
    `<ram:${tag}>`,
    `<ram:Name>${escapeXml(party.name)}</ram:Name>`,
    siren
      ? `<ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">${escapeXml(siren)}</ram:ID></ram:SpecifiedLegalOrganization>`
      : "",
    "<ram:PostalTradeAddress>",
    party.address.postalCode
      ? `<ram:PostcodeCode>${escapeXml(party.address.postalCode)}</ram:PostcodeCode>`
      : "",
    party.address.street ? `<ram:LineOne>${escapeXml(party.address.street)}</ram:LineOne>` : "",
    party.address.city ? `<ram:CityName>${escapeXml(party.address.city)}</ram:CityName>` : "",
    `<ram:CountryID>${escapeXml(party.address.countryCode || "FR")}</ram:CountryID>`,
    "</ram:PostalTradeAddress>",
    party.vatNumber
      ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${escapeXml(party.vatNumber)}</ram:ID></ram:SpecifiedTaxRegistration>`
      : "",
    `</ram:${tag}>`,
  ]
    .filter(Boolean)
    .join("");
}

/**
 * Line item. The currency is declared ONCE per document
 * (InvoiceCurrencyCode); repeating currencyID on line amounts raises an
 * EN 16931 Schematron warning, so only TaxTotalAmount carries it.
 */
function lineXml(line: FacturXLine, index: number): string {
  return [
    "<ram:IncludedSupplyChainTradeLineItem>",
    `<ram:AssociatedDocumentLineDocument><ram:LineID>${index + 1}</ram:LineID></ram:AssociatedDocumentLineDocument>`,
    `<ram:SpecifiedTradeProduct><ram:Name>${escapeXml(line.description)}</ram:Name></ram:SpecifiedTradeProduct>`,
    "<ram:SpecifiedLineTradeAgreement>",
    `<ram:NetPriceProductTradePrice><ram:ChargeAmount>${amount(line.unitPriceCents)}</ram:ChargeAmount></ram:NetPriceProductTradePrice>`,
    "</ram:SpecifiedLineTradeAgreement>",
    // 4 décimales : une quantité fractionnaire ne doit pas être arrondie au
    // point de contredire le total de ligne (l'audit borne la précision).
    `<ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="${escapeXml(line.unit ?? "C62")}">${line.quantity.toFixed(4)}</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>`,
    "<ram:SpecifiedLineTradeSettlement>",
    "<ram:ApplicableTradeTax>",
    "<ram:TypeCode>VAT</ram:TypeCode>",
    `<ram:CategoryCode>${line.vatCategory}</ram:CategoryCode>`,
    `<ram:RateApplicablePercent>${line.vatRate.toFixed(2)}</ram:RateApplicablePercent>`,
    "</ram:ApplicableTradeTax>",
    `<ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>${amount(lineNetCents(line))}</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>`,
    "</ram:SpecifiedLineTradeSettlement>",
    "</ram:IncludedSupplyChainTradeLineItem>",
  ].join("");
}

/**
 * VAT breakdown, from the SINGLE computation shared with the auditor. The
 * exemption reason (BT-120) is attached ONLY to untaxed categories: claiming
 * an exemption under a standard-rated bucket is a legal contradiction.
 */
function taxBreakdownXml(invoice: FacturXInvoice): string {
  const { buckets } = computeVatBreakdown(invoice);
  return buckets
    .map((bucket) => {
      const untaxed = (UNTAXED_CATEGORIES as readonly string[]).includes(bucket.category);
      return [
        "<ram:ApplicableTradeTax>",
        `<ram:CalculatedAmount>${amount(bucket.vatCents)}</ram:CalculatedAmount>`,
        "<ram:TypeCode>VAT</ram:TypeCode>",
        untaxed && invoice.vatExemptionReason
          ? `<ram:ExemptionReason>${escapeXml(invoice.vatExemptionReason)}</ram:ExemptionReason>`
          : "",
        `<ram:BasisAmount>${amount(bucket.basisCents)}</ram:BasisAmount>`,
        `<ram:CategoryCode>${escapeXml(bucket.category)}</ram:CategoryCode>`,
        `<ram:RateApplicablePercent>${bucket.ratePercent.toFixed(2)}</ram:RateApplicablePercent>`,
        "</ram:ApplicableTradeTax>",
      ]
        .filter(Boolean)
        .join("");
    })
    .join("");
}

/**
 * Builds the Factur-X CII document. Only profiles carrying detail lines are
 * implemented: MINIMUM and BASIC WL have their own, narrower schemas (and
 * exist for e-reporting), so emitting an EN 16931-shaped document under
 * their URN would claim a conformity we do not have — we refuse instead.
 */
export function buildCiiXml(invoice: FacturXInvoice, profile: FacturXProfile): string {
  const definition = FACTURX_PROFILES[profile];
  if (!definition.implemented) {
    throw new Error(`profile ${profile} not implemented`);
  }
  const currency = invoice.currency || "EUR";
  const category = OPERATION_CATEGORIES[invoice.operationCategory];
  const totals = invoice.totals;

  const body = [
    `<rsm:CrossIndustryInvoice ${NAMESPACES}>`,

    "<rsm:ExchangedDocumentContext>",
    "<ram:GuidelineSpecifiedDocumentContextParameter>",
    `<ram:ID>${definition.urn}</ram:ID>`,
    "</ram:GuidelineSpecifiedDocumentContextParameter>",
    "</rsm:ExchangedDocumentContext>",

    "<rsm:ExchangedDocument>",
    `<ram:ID>${escapeXml(invoice.number)}</ram:ID>`,
    `<ram:TypeCode>${DOCUMENT_TYPE_CODES.invoice}</ram:TypeCode>`,
    dateElement("IssueDateTime", invoice.issueDate),
    // Catégorie d'opération (mention ajoutée par la réforme) : portée en
    // note TEXTUELLE. `SubjectCode` est une liste fermée (UNTDID 4451) qui
    // n'accueille pas nos valeurs — y écrire "PS" garantirait un échec de
    // validation. Placement à revoir quand les specs DGFiP seront figées.
    `<ram:IncludedNote><ram:Content>${escapeXml(`Catégorie d'opération : ${category.label}`)}</ram:Content></ram:IncludedNote>`,
    invoice.note
      ? `<ram:IncludedNote><ram:Content>${escapeXml(invoice.note)}</ram:Content></ram:IncludedNote>`
      : "",
    invoice.vatExemptionReason
      ? `<ram:IncludedNote><ram:Content>${escapeXml(invoice.vatExemptionReason)}</ram:Content><ram:SubjectCode>TXD</ram:SubjectCode></ram:IncludedNote>`
      : "",
    "</rsm:ExchangedDocument>",

    "<rsm:SupplyChainTradeTransaction>",
    invoice.lines.map((line, index) => lineXml(line, index)).join(""),

    // Séquence XSD : BuyerReference, SellerTradeParty, BuyerTradeParty, …,
    // BuyerOrderReferencedDocument. L'ordre est normatif.
    "<ram:ApplicableHeaderTradeAgreement>",
    invoice.buyerReference
      ? `<ram:BuyerReference>${escapeXml(invoice.buyerReference)}</ram:BuyerReference>`
      : "",
    partyXml("SellerTradeParty", invoice.seller),
    partyXml("BuyerTradeParty", invoice.buyer),
    invoice.purchaseOrderRef
      ? `<ram:BuyerOrderReferencedDocument><ram:IssuerAssignedID>${escapeXml(invoice.purchaseOrderRef)}</ram:IssuerAssignedID></ram:BuyerOrderReferencedDocument>`
      : "",
    "</ram:ApplicableHeaderTradeAgreement>",

    // Date de livraison (BT-72) : émise UNIQUEMENT si le tenant la fournit —
    // la déduire de la date d'émission fabriquerait une donnée fiscale.
    invoice.deliveryDate
      ? `<ram:ApplicableHeaderTradeDelivery><ram:ActualDeliverySupplyChainEvent><ram:OccurrenceDateTime><udt:DateTimeString format="102">${ciiDate(invoice.deliveryDate)}</udt:DateTimeString></ram:OccurrenceDateTime></ram:ActualDeliverySupplyChainEvent></ram:ApplicableHeaderTradeDelivery>`
      : "<ram:ApplicableHeaderTradeDelivery/>",

    "<ram:ApplicableHeaderTradeSettlement>",
    `<ram:InvoiceCurrencyCode>${escapeXml(currency)}</ram:InvoiceCurrencyCode>`,
    taxBreakdownXml(invoice),
    invoice.dueDate
      ? `<ram:SpecifiedTradePaymentTerms>${dateElement("DueDateDateTime", invoice.dueDate)}</ram:SpecifiedTradePaymentTerms>`
      : "",
    "<ram:SpecifiedTradeSettlementHeaderMonetarySummation>",
    `<ram:LineTotalAmount>${amount(totals.netCents)}</ram:LineTotalAmount>`,
    `<ram:TaxBasisTotalAmount>${amount(totals.netCents)}</ram:TaxBasisTotalAmount>`,
    `<ram:TaxTotalAmount currencyID="${escapeXml(currency)}">${amount(totals.vatCents)}</ram:TaxTotalAmount>`,
    `<ram:GrandTotalAmount>${amount(totals.grossCents)}</ram:GrandTotalAmount>`,
    invoice.prepaidCents
      ? `<ram:TotalPrepaidAmount>${amount(invoice.prepaidCents)}</ram:TotalPrepaidAmount>`
      : "",
    `<ram:DuePayableAmount>${amount(totals.dueCents)}</ram:DuePayableAmount>`,
    "</ram:SpecifiedTradeSettlementHeaderMonetarySummation>",
    "</ram:ApplicableHeaderTradeSettlement>",

    "</rsm:SupplyChainTradeTransaction>",
    "</rsm:CrossIndustryInvoice>",
  ]
    .filter(Boolean)
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>${body}`;
}
