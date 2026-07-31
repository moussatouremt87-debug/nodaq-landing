import { sirenOf } from "./invoice.js";
import type { FacturXInvoice } from "./invoice.js";
import {
  FACTURX_RULES_VERSION,
  FRENCH_VAT_RATES,
  isRateAllowedForCategory,
  UNTAXED_CATEGORIES,
} from "./profiles.js";
import { computeVatBreakdown } from "./vat.js";

/*
 * Pre-issuance conformity audit (ticket 2.3) — PURE and deterministic. An
 * invoice that leaves the product is a legal document: an incoherent total
 * or a missing mandatory mention must be caught HERE, not by the PDP
 * rejecting the submission (or worse, by a tax audit years later).
 *
 * Arithmetic is checked with ZERO tolerance against the SINGLE breakdown
 * (vat.ts) that the XML serializer also uses: what we validate is exactly
 * what we write. EN 16931's BR-CO-* rules admit no rounding slack.
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
    | "categorie_tva_incoherente"
    | "montant_negatif"
    | "total_ht_incoherent"
    | "tva_incoherente"
    | "total_ttc_incoherent"
    | "montant_du_incoherent"
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

function euro(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Luhn check digit — the standard SIREN/SIRET control. Length alone lets
 * "99999999999999" through, and the SIREN is the most scrutinised mention
 * of the reform.
 */
export function isValidLuhn(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index--) {
    let value = Number(digits[index]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * La Poste SIRET (starting 356000000) is the documented exception to Luhn —
 * excluded rather than silently failing a legitimate invoice.
 */
function siretLooksValid(digits: string): boolean {
  if (digits.length !== 14) return false;
  if (digits.startsWith("356000000")) return true;
  return isValidLuhn(digits) && isValidLuhn(digits.slice(0, 9));
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
    } else if (!siretLooksValid(digits)) {
      add(invalid, "bloquant", `SIRET du ${role} invalide (clé de contrôle incorrecte)`);
    }
  }

  if (invoice.lines.length === 0) {
    add("aucune_ligne", "attention", "facture sans ligne de détail");
  }

  for (const line of invoice.lines) {
    if (!(FRENCH_VAT_RATES as readonly number[]).includes(line.vatRate)) {
      add(
        "taux_tva_inconnu",
        "bloquant",
        `taux de TVA ${line.vatRate} % hors barème français (${FRENCH_VAT_RATES.join(", ")})`,
      );
    } else if (!isRateAllowedForCategory(line.vatCategory, line.vatRate)) {
      // BR-E-*/BR-Z-* : une catégorie exonérée à 20 % est une contradiction.
      add(
        "categorie_tva_incoherente",
        "bloquant",
        `catégorie de TVA « ${line.vatCategory} » incompatible avec un taux de ${line.vatRate} %`,
      );
    }
  }

  // Un avoir se déclare avec le code 381, non implémenté : mieux vaut
  // refuser que d'émettre un avoir typé comme une facture.
  if (
    invoice.totals.grossCents < 0 ||
    invoice.totals.netCents < 0 ||
    invoice.lines.some((line) => line.unitPriceCents < 0 || line.quantity < 0)
  ) {
    add(
      "montant_negatif",
      "bloquant",
      "montant négatif : un avoir doit être émis en type 381, non pris en charge en V1",
    );
  }

  // Arithmétique : comparaison à la ventilation UNIQUE, tolérance ZÉRO —
  // c'est elle qui sera écrite dans le document.
  if (invoice.lines.length > 0) {
    const breakdown = computeVatBreakdown(invoice);
    if (breakdown.netCents !== invoice.totals.netCents) {
      add(
        "total_ht_incoherent",
        "bloquant",
        `total HT déclaré ${euro(invoice.totals.netCents)} € ≠ somme des lignes ${euro(breakdown.netCents)} €`,
      );
    }
    if (breakdown.vatCents !== invoice.totals.vatCents) {
      add(
        "tva_incoherente",
        "bloquant",
        `TVA déclarée ${euro(invoice.totals.vatCents)} € ≠ TVA de la ventilation ${euro(breakdown.vatCents)} € ` +
          "(arrondi par taux, règle BR-CO-14)",
      );
    }
  }

  const expectedGross = invoice.totals.netCents + invoice.totals.vatCents;
  if (expectedGross !== invoice.totals.grossCents) {
    add(
      "total_ttc_incoherent",
      "bloquant",
      `TTC déclaré ${euro(invoice.totals.grossCents)} € ≠ HT + TVA ${euro(expectedGross)} €`,
    );
  }

  // BR-CO-16 : le montant réclamé est le TTC diminué des acomptes déjà
  // versés. C'est la somme que le client va payer : jamais non contrôlée.
  const prepaid = invoice.prepaidCents ?? 0;
  if (prepaid < 0) {
    add("montant_negatif", "bloquant", "acompte négatif");
  }
  if (invoice.totals.dueCents !== invoice.totals.grossCents - prepaid) {
    add(
      "montant_du_incoherent",
      "bloquant",
      `montant dû ${euro(invoice.totals.dueCents)} € ≠ TTC ${euro(invoice.totals.grossCents)} € − acompte ${euro(prepaid)} €`,
    );
  }

  // Pas de TVA facturée : la mention légale qui le justifie est obligatoire.
  const untaxed =
    invoice.totals.vatCents === 0 ||
    invoice.lines.some((line) =>
      (UNTAXED_CATEGORIES as readonly string[]).includes(line.vatCategory),
    );
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
