import { amount, sirenOf } from "./invoice.js";
import type { FacturXInvoice, FacturXLine, FacturXParty } from "./invoice.js";
import {
  DOCUMENT_TYPE_CODES,
  FACTURX_PROFILES,
  OPERATION_CATEGORIES,
} from "./profiles.js";
import type { FacturXProfile } from "./profiles.js";

/*
 * CII (UN/CEFACT Cross Industry Invoice, D16B) serializer — PURE: same
 * invoice in, same bytes out, no clock, no network. The XML is the part
 * that carries legal value, so it is assembled explicitly rather than by a
 * generic object-to-XML mapper: element ORDER is normative in CII.
 */

const NAMESPACES = [
  'xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"',
  'xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"',
  'xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100"',
].join(" ");

/**
 * XML text escaping. Third-party data (customer names, descriptions) lands
 * in a legal document: an unescaped "<" would produce an invalid invoice, a
 * crafted one could inject markup. Everything textual goes through here.
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

function partyXml(tag: string, party: FacturXParty): string {
  const siren = sirenOf(party.siret);
  return [
    `<ram:${tag}>`,
    siren ? `<ram:ID schemeID="0002">${escapeXml(siren)}</ram:ID>` : "",
    party.siret ? `<ram:GlobalID schemeID="0009">${escapeXml(party.siret)}</ram:GlobalID>` : "",
    `<ram:Name>${escapeXml(party.name)}</ram:Name>`,
    "<ram:PostalTradeAddress>",
    party.address.postalCode
      ? `<ram:PostcodeCode>${escapeXml(party.address.postalCode)}</ram:PostcodeCode>`
      : "",
    party.address.street
      ? `<ram:LineOne>${escapeXml(party.address.street)}</ram:LineOne>`
      : "",
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

function lineXml(line: FacturXLine, index: number, currency: string): string {
  const netCents = Math.round(line.quantity * line.unitPriceCents);
  return [
    "<ram:IncludedSupplyChainTradeLineItem>",
    `<ram:AssociatedDocumentLineDocument><ram:LineID>${index + 1}</ram:LineID></ram:AssociatedDocumentLineDocument>`,
    `<ram:SpecifiedTradeProduct><ram:Name>${escapeXml(line.description)}</ram:Name></ram:SpecifiedTradeProduct>`,
    "<ram:SpecifiedLineTradeAgreement>",
    `<ram:NetPriceProductTradePrice><ram:ChargeAmount>${amount(line.unitPriceCents)}</ram:ChargeAmount></ram:NetPriceProductTradePrice>`,
    "</ram:SpecifiedLineTradeAgreement>",
    `<ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="${escapeXml(line.unit ?? "C62")}">${line.quantity.toFixed(2)}</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>`,
    "<ram:SpecifiedLineTradeSettlement>",
    "<ram:ApplicableTradeTax>",
    "<ram:TypeCode>VAT</ram:TypeCode>",
    `<ram:CategoryCode>${line.vatCategory}</ram:CategoryCode>`,
    `<ram:RateApplicablePercent>${line.vatRate.toFixed(2)}</ram:RateApplicablePercent>`,
    "</ram:ApplicableTradeTax>",
    `<ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount currencyID="${escapeXml(currency)}">${amount(netCents)}</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>`,
    "</ram:SpecifiedLineTradeSettlement>",
    "</ram:IncludedSupplyChainTradeLineItem>",
  ].join("");
}

/** VAT breakdown per (rate, category) — one ApplicableTradeTax each. */
function taxBreakdown(invoice: FacturXInvoice): string {
  const buckets = new Map<string, { base: number; rate: number; category: string }>();
  for (const line of invoice.lines) {
    const key = `${line.vatRate}|${line.vatCategory}`;
    const bucket = buckets.get(key) ?? { base: 0, rate: line.vatRate, category: line.vatCategory };
    bucket.base += Math.round(line.quantity * line.unitPriceCents);
    buckets.set(key, bucket);
  }
  // No lines (MINIMUM / BASIC WL): fall back to the header totals.
  if (buckets.size === 0) {
    buckets.set("header", {
      base: invoice.totals.netCents,
      rate: invoice.totals.netCents === 0 ? 0 : (invoice.totals.vatCents / invoice.totals.netCents) * 100,
      category: invoice.totals.vatCents === 0 ? "E" : "S",
    });
  }
  return [...buckets.values()]
    .map((bucket) =>
      [
        "<ram:ApplicableTradeTax>",
        `<ram:CalculatedAmount>${amount(Math.round((bucket.base * bucket.rate) / 100))}</ram:CalculatedAmount>`,
        "<ram:TypeCode>VAT</ram:TypeCode>",
        invoice.vatExemptionReason
          ? `<ram:ExemptionReason>${escapeXml(invoice.vatExemptionReason)}</ram:ExemptionReason>`
          : "",
        `<ram:BasisAmount>${amount(bucket.base)}</ram:BasisAmount>`,
        `<ram:CategoryCode>${escapeXml(bucket.category)}</ram:CategoryCode>`,
        `<ram:RateApplicablePercent>${bucket.rate.toFixed(2)}</ram:RateApplicablePercent>`,
        "</ram:ApplicableTradeTax>",
      ]
        .filter(Boolean)
        .join(""),
    )
    .join("");
}

/**
 * Builds the Factur-X CII document for a profile. MINIMUM and BASIC WL carry
 * no detail lines by definition — the caller gets a valid document for the
 * profile it asked for, never a silently downgraded one.
 */
export function buildCiiXml(invoice: FacturXInvoice, profile: FacturXProfile): string {
  const definition = FACTURX_PROFILES[profile];
  const currency = invoice.currency || "EUR";
  const category = OPERATION_CATEGORIES[invoice.operationCategory];

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
    // Catégorie d'opération : mention ajoutée par la réforme française.
    `<ram:IncludedNote><ram:Content>${escapeXml(category.label)}</ram:Content><ram:SubjectCode>${category.code}</ram:SubjectCode></ram:IncludedNote>`,
    invoice.note
      ? `<ram:IncludedNote><ram:Content>${escapeXml(invoice.note)}</ram:Content></ram:IncludedNote>`
      : "",
    invoice.vatExemptionReason
      ? `<ram:IncludedNote><ram:Content>${escapeXml(invoice.vatExemptionReason)}</ram:Content><ram:SubjectCode>TXD</ram:SubjectCode></ram:IncludedNote>`
      : "",
    "</rsm:ExchangedDocument>",

    "<rsm:SupplyChainTradeTransaction>",
    definition.includesLines
      ? invoice.lines.map((line, index) => lineXml(line, index, currency)).join("")
      : "",

    "<ram:ApplicableHeaderTradeAgreement>",
    invoice.purchaseOrderRef
      ? `<ram:BuyerOrderReferencedDocument><ram:IssuerAssignedID>${escapeXml(invoice.purchaseOrderRef)}</ram:IssuerAssignedID></ram:BuyerOrderReferencedDocument>`
      : "",
    partyXml("SellerTradeParty", invoice.seller),
    partyXml("BuyerTradeParty", invoice.buyer),
    "</ram:ApplicableHeaderTradeAgreement>",

    "<ram:ApplicableHeaderTradeDelivery>",
    dateElement("ActualDeliverySupplyChainEvent", invoice.issueDate).replace(
      "<ram:ActualDeliverySupplyChainEvent>",
      "<ram:ActualDeliverySupplyChainEvent><ram:OccurrenceDateTime>",
    ).replace(
      "</ram:ActualDeliverySupplyChainEvent>",
      "</ram:OccurrenceDateTime></ram:ActualDeliverySupplyChainEvent>",
    ),
    "</ram:ApplicableHeaderTradeDelivery>",

    "<ram:ApplicableHeaderTradeSettlement>",
    `<ram:InvoiceCurrencyCode>${escapeXml(currency)}</ram:InvoiceCurrencyCode>`,
    taxBreakdown(invoice),
    invoice.dueDate
      ? `<ram:SpecifiedTradePaymentTerms>${dateElement("DueDateDateTime", invoice.dueDate)}</ram:SpecifiedTradePaymentTerms>`
      : "",
    "<ram:SpecifiedTradeSettlementHeaderMonetarySummation>",
    `<ram:LineTotalAmount>${amount(invoice.totals.netCents)}</ram:LineTotalAmount>`,
    `<ram:TaxBasisTotalAmount>${amount(invoice.totals.netCents)}</ram:TaxBasisTotalAmount>`,
    `<ram:TaxTotalAmount currencyID="${escapeXml(currency)}">${amount(invoice.totals.vatCents)}</ram:TaxTotalAmount>`,
    `<ram:GrandTotalAmount>${amount(invoice.totals.grossCents)}</ram:GrandTotalAmount>`,
    `<ram:DuePayableAmount>${amount(invoice.totals.dueCents)}</ram:DuePayableAmount>`,
    "</ram:SpecifiedTradeSettlementHeaderMonetarySummation>",
    "</ram:ApplicableHeaderTradeSettlement>",

    "</rsm:SupplyChainTradeTransaction>",
    "</rsm:CrossIndustryInvoice>",
  ]
    .filter(Boolean)
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>${body}`;
}
