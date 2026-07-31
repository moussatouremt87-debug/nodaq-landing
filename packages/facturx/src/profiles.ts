/*
 * Factur-X normative config (ticket 2.3) — same doctrine as frenchTax.ts
 * (2.19) and regulatoryWatch.ts (3.7): everything the law fixes lives in ONE
 * versioned, dated, sourced config. A wrong URN or a wrong code makes an
 * invoice non-compliant, so none of these values may be inlined elsewhere.
 *
 * Factur-X = a PDF/A-3 carrying an embedded CII XML (UN/CEFACT D16B). It is
 * the French/German implementation of EN 16931, and the format the 2026-2027
 * French e-invoicing reform runs on. The calendar itself lives in
 * regulatoryWatch.ts (3.7) — never duplicated here.
 */

/** Config snapshot date — bump on every rule change. */
export const FACTURX_RULES_VERSION = "2026-08-01";

/** Attachment file name imposed by the Factur-X specification. */
export const FACTURX_ATTACHMENT_NAME = "factur-x.xml";
/** Factur-X version implemented here. */
export const FACTURX_VERSION = "1.0";

export interface FacturXProfileDefinition {
  /** Normative guideline URN written into the XML context. */
  urn: string;
  /** Human label used in the PDF metadata. */
  conformanceLevel: string;
  /** Whether the profile carries invoice detail lines. */
  includesLines: boolean;
  /** False = catalogued as a normative fact, but not emitted by V1. */
  implemented: boolean;
  description: string;
  source: { label: string; url: string };
}

const FNFE = {
  label: "FNFE-MPE — spécification Factur-X 1.0",
  url: "https://fnfe-mpe.org/factur-x/",
};

export const FACTURX_PROFILES = {
  /** Head data only — the profile the reform allows for e-reporting. */
  MINIMUM: {
    urn: "urn:factur-x.eu:1p0:minimum",
    conformanceLevel: "MINIMUM",
    includesLines: false,
    implemented: false,
    description: "Données d'en-tête seules (piste d'audit fiable, e-reporting).",
    source: FNFE,
  },
  /** Head data + VAT breakdown, still without lines. */
  BASIC_WL: {
    urn: "urn:factur-x.eu:1p0:basicwl",
    conformanceLevel: "BASIC WL",
    includesLines: false,
    implemented: false,
    description: "En-tête et ventilation de TVA, sans lignes de détail.",
    source: FNFE,
  },
  /** Lines included; EN 16931 compliant subset. */
  BASIC: {
    urn: "urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic",
    conformanceLevel: "BASIC",
    includesLines: true,
    implemented: true,
    description: "Lignes de facture simples, conforme au socle EN 16931.",
    source: FNFE,
  },
  /** The European semantic standard in full — the default for B2B. */
  EN16931: {
    urn: "urn:cen.eu:en16931:2017",
    conformanceLevel: "EN 16931",
    includesLines: true,
    implemented: true,
    description: "Norme sémantique européenne complète (profil de référence B2B).",
    source: {
      label: "EN 16931-1 — modèle sémantique de la facture électronique",
      url: "https://www.din.de/en/wdc-beuth:din21:264120872",
    },
  },
} as const satisfies Record<string, FacturXProfileDefinition>;

export type FacturXProfile = keyof typeof FACTURX_PROFILES;

/**
 * Operation category — a mention the French reform adds to the legal set.
 * NOTE: the exact CII placement is fixed by the DGFiP external specs, which
 * are still moving; we carry it as a typed note and will realign when the
 * PDP contract (2.4) is wired. The VALUE is contractual, the placement is
 * ours until then — stated plainly rather than presented as certain.
 */
export const OPERATION_CATEGORIES = {
  livraison_biens: { code: "LB", label: "Livraison de biens" },
  prestation_services: { code: "PS", label: "Prestation de services" },
  mixte: { code: "MX", label: "Opération mixte (biens et services)" },
} as const;

export type OperationCategory = keyof typeof OPERATION_CATEGORIES;

/** French VAT rates in force at FACTURX_RULES_VERSION (art. 278 s. CGI). */
export const FRENCH_VAT_RATES = [20, 10, 5.5, 2.1, 0] as const;

/**
 * UNTDID 5305 VAT category codes used here: S standard, Z zero-rated,
 * E exempt, AE reverse charge (autoliquidation).
 */
export const VAT_CATEGORIES = ["S", "Z", "E", "AE"] as const;
export type VatCategory = (typeof VAT_CATEGORIES)[number];

/** Categories that charge no VAT — they require a legal mention (BT-120). */
export const UNTAXED_CATEGORIES = ["Z", "E", "AE"] as const;

/**
 * Category/rate compatibility (BR-S-*, BR-Z-*, BR-E-*, BR-AE-*): an "exempt"
 * line at 20 % is a contradiction the standard rejects, and a 0 % line is
 * category Z (or E/AE), never S. Checked at audit time.
 */
export function isRateAllowedForCategory(category: VatCategory, ratePercent: number): boolean {
  if (category === "S") return ratePercent > 0;
  return ratePercent === 0;
}

/** UNTDID 1001 — 380 = commercial invoice, 381 = credit note. */
export const DOCUMENT_TYPE_CODES = { invoice: "380", creditNote: "381" } as const;
