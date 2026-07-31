/*
 * E-invoicing lifecycle (ticket 2.4) — the statuses a submitted invoice goes
 * through on the network, and the transitions the platform may report.
 *
 * Same doctrine as the rest of the normative surface: this is CONFIG, dated
 * and sourced, not values scattered across the code. The French reform fixes
 * a shared status vocabulary so that every actor (issuer, platform,
 * recipient, tax authority) reads the same lifecycle — inventing our own
 * would break reconciliation with the platform.
 */

/** Config snapshot date — bump when the status list or transitions change. */
export const LIFECYCLE_RULES_VERSION = "2026-08-01";

export const LIFECYCLE_SOURCE = {
  label: "DGFiP — spécifications externes de la facturation électronique (statuts du cycle de vie)",
  url: "https://www.impots.gouv.fr/facturationelectronique",
};

/**
 * Statuses we track. `prete` is OURS (the invoice is audited and waiting for
 * a human to approve the deposit); everything after it is reported BY the
 * platform. `erreur` covers a transport failure on our side — never a
 * platform verdict, so it is never confused with a refusal.
 */
export const SUBMISSION_STATUSES = [
  "prete",
  "deposee",
  "recue",
  "prise_en_charge",
  "approuvee",
  "approuvee_partiellement",
  "refusee",
  "rejetee",
  "encaissee",
  "erreur",
] as const;

export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export const STATUS_LABELS: Record<SubmissionStatus, string> = {
  prete: "Prête à déposer",
  deposee: "Déposée",
  recue: "Reçue par la plateforme",
  prise_en_charge: "Prise en charge",
  approuvee: "Approuvée par le client",
  approuvee_partiellement: "Approuvée partiellement",
  refusee: "Refusée par le client",
  rejetee: "Rejetée par la plateforme",
  encaissee: "Encaissée",
  erreur: "Erreur de transmission",
};

/** Statuses that close the cycle: nothing more is expected from the network. */
export const TERMINAL_STATUSES: readonly SubmissionStatus[] = [
  "refusee",
  "rejetee",
  "encaissee",
];

/**
 * Allowed transitions. A platform can legitimately skip steps (a webhook may
 * be missed or arrive late), so forward jumps are permitted — but going
 * BACKWARDS is not: an "approuvee" invoice never returns to "deposee", and a
 * terminal status is never reopened. Without this, an out-of-order or
 * replayed webhook would silently rewrite an invoice's history.
 */
const STATUS_RANK: Record<SubmissionStatus, number> = {
  prete: 0,
  deposee: 1,
  recue: 2,
  prise_en_charge: 3,
  approuvee_partiellement: 4,
  approuvee: 4,
  refusee: 5,
  rejetee: 5,
  encaissee: 6,
  erreur: 1,
};

export function isValidTransition(from: SubmissionStatus, to: SubmissionStatus): boolean {
  if (from === to) return false;
  // Un statut terminal ne se rouvre pas — sauf l'encaissement, qui peut
  // légitimement suivre une approbation.
  if (TERMINAL_STATUSES.includes(from)) {
    return from !== "encaissee" && to === "encaissee";
  }
  // Une erreur de transmission peut être suivie d'un nouveau dépôt.
  if (from === "erreur") return to === "deposee";
  // `erreur` = échec de transport DE NOTRE CÔTÉ : il ne peut survenir que
  // tant que la plateforme n'a pas pris le document. Autoriser le retour en
  // erreur depuis un statut plus avancé rouvrirait le cycle (erreur →
  // deposee) sur une facture que la plateforme a déjà traitée.
  if (to === "erreur") return from === "prete" || from === "deposee";
  return STATUS_RANK[to] > STATUS_RANK[from];
}

/** Whether the platform verdict means the invoice was NOT accepted. */
export function isRejection(status: SubmissionStatus): boolean {
  return status === "refusee" || status === "rejetee";
}

/**
 * Maps a platform-reported status string onto our vocabulary. Unknown values
 * return null rather than a guess: a status we do not understand must not be
 * recorded as if we did.
 */
export function normalizeStatus(raw: string): SubmissionStatus | null {
  const value = raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\s-]+/g, "_");
  const direct = (SUBMISSION_STATUSES as readonly string[]).includes(value)
    ? (value as SubmissionStatus)
    : null;
  if (direct) return direct;
  const aliases: Record<string, SubmissionStatus> = {
    submitted: "deposee",
    deposited: "deposee",
    received: "recue",
    accepted: "prise_en_charge",
    taken_over: "prise_en_charge",
    approved: "approuvee",
    partially_approved: "approuvee_partiellement",
    rejected: "rejetee",
    refused: "refusee",
    paid: "encaissee",
    cashed: "encaissee",
  };
  return aliases[value] ?? null;
}
