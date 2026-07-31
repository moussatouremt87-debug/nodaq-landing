import { sirenOf } from "./invoice.js";
import type { FacturXInvoice } from "./invoice.js";
import { FACTURX_RULES_VERSION, FRENCH_VAT_RATES } from "./profiles.js";

/*
 * Pre-issuance conformity audit (ticket 2.3) — PURE and deterministic. An
 * invoice that leaves the product is a legal document: an incoherent total or
 * a missing mandatory mention must be caught HERE, not by the PDP rejecting
 * the submission (or worse, by a tax audit years later). Every issue carries
 * its figures; nothing is "fixed" silently.
 */

export interface FacturXIssue {
  code:
    | "numero_manquant"
    | "date_emission_invalide"
    | "echeance_anterieure"
    | "siret_vendeur_manquant"
    | "siret_vendeur_invalide"
    | "siret_acheteur_manquant"
    | "siret_acheteur_invalide"
    | "aucune_ligne"
    | "taux_tva_inconnu"
    | "total_ht_incoherent"
    | "tva_incoherente"
    | "total_ttc_incoherent"
    | "mention_exoneration_manquante";
  severity: "bloquant" | "attention";
  /** French, self-contained justification with the figures. */
  reason: string;
}

export interface FacturXAudit {
  rulesVersion: string;
  issues: FacturXIssue[];
  /** True when nothing blocks issuance. */
  issuable: boolean;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Cent-level rounding slack across a whole invoice. */
const TOLERANCE_CENTS = 1;

function euro(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Checks the invoice against the French mandatory mentions and its own maths. */
export function auditInvoice(invoice: FacturXInvoice): FacturXAudit {
  const issues: FacturXIssue[] = [];
  const add = (
    code: FacturXIssue["code"],
    severity: FacturXIssue["severity"],
    reason: string,
  ): void => {
    issues.push({ code, severity, reason });
  };

  if (invoice.number.trim() === "") {
    add("numero_manquant", "bloquant", "numéro de facture absent (art. 242 nonies A CGI)");
  }
  if (!ISO_DAY.test(invoice.issueDate) || Number.isNaN(Date.parse(invoice.issueDate))) {
    add("date_emission_invalide", "bloquant", "date d'émission absente ou illisible");
  } else if (
    invoice.dueDate &&
    ISO_DAY.test(invoice.dueDate) &&
    Date.parse(invoice.dueDate) < Date.parse(invoice.issueDate)
  ) {
    add(
      "echeance_anterieure",
      "attention",
      `échéance ${invoice.dueDate} antérieure à l'émission ${invoice.issueDate}`,
    );
  }

  // SIREN des deux parties : mention ajoutée par la réforme (identification
  // de l'émetteur ET du destinataire dans le flux e-invoicing).
  for (const [party, role, missing, invalid] of [
    [invoice.seller, "vendeur", "siret_vendeur_manquant", "siret_vendeur_invalide"],
    [invoice.buyer, "acheteur", "siret_acheteur_manquant", "siret_acheteur_invalide"],
  ] as const) {
    const digits = party.siret.replace(/\D/g, "");
    if (digits === "") {
      add(missing, "bloquant", `SIRET du ${role} absent — le SIREN est une mention obligatoire`);
    } else if (digits.length !== 14 || sirenOf(party.siret).length !== 9) {
      add(
        invalid,
        "bloquant",
        `SIRET du ${role} invalide (${digits.length} chiffres, 14 attendus)`,
      );
    }
  }

  if (invoice.lines.length === 0) {
    add("aucune_ligne", "attention", "facture sans ligne de détail");
  }

  let computedNet = 0;
  let computedVat = 0;
  for (const line of invoice.lines) {
    if (!(FRENCH_VAT_RATES as readonly number[]).includes(line.vatRate)) {
      add(
        "taux_tva_inconnu",
        "bloquant",
        `taux de TVA ${line.vatRate} % hors barème français (${FRENCH_VAT_RATES.join(", ")})`,
      );
    }
    const lineNet = Math.round(line.quantity * line.unitPriceCents);
    computedNet += lineNet;
    computedVat += Math.round((lineNet * line.vatRate) / 100);
  }

  if (invoice.lines.length > 0) {
    if (Math.abs(computedNet - invoice.totals.netCents) > TOLERANCE_CENTS) {
      add(
        "total_ht_incoherent",
        "bloquant",
        `total HT déclaré ${euro(invoice.totals.netCents)} € ≠ somme des lignes ${euro(computedNet)} €`,
      );
    }
    if (Math.abs(computedVat - invoice.totals.vatCents) > TOLERANCE_CENTS) {
      add(
        "tva_incoherente",
        "bloquant",
        `TVA déclarée ${euro(invoice.totals.vatCents)} € ≠ TVA calculée ${euro(computedVat)} €`,
      );
    }
  }

  const expectedGross = invoice.totals.netCents + invoice.totals.vatCents;
  if (Math.abs(expectedGross - invoice.totals.grossCents) > TOLERANCE_CENTS) {
    add(
      "total_ttc_incoherent",
      "bloquant",
      `TTC déclaré ${euro(invoice.totals.grossCents)} € ≠ HT + TVA ${euro(expectedGross)} €`,
    );
  }

  // Pas de TVA facturée : la mention légale qui le justifie est obligatoire.
  const untaxed =
    invoice.totals.vatCents === 0 ||
    invoice.lines.some((line) => line.vatCategory === "E" || line.vatCategory === "AE");
  if (untaxed && !invoice.vatExemptionReason?.trim()) {
    add(
      "mention_exoneration_manquante",
      "bloquant",
      "aucune TVA facturée sans mention justificative (ex. « TVA non applicable, art. 293 B du CGI » ou « autoliquidation »)",
    );
  }

  return {
    rulesVersion: FACTURX_RULES_VERSION,
    issues,
    issuable: !issues.some((issue) => issue.severity === "bloquant"),
  };
}
