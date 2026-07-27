/*
 * French display labels for pending-action types and statuses. The raw
 * identifiers (MCP tool names, status enum) are the API contract and stay
 * untouched; only the rendering changes. Unknown values fall back to the raw
 * string so a newly added tool stays visible before its label lands here.
 */

const ACTION_TYPE_LABELS: Record<string, string> = {
  send_dunning: "Relance client",
  create_quote: "Devis client",
  submit_reconciliation: "Rapprochement bancaire",
  book_invoice: "Écriture comptable",
};

const ACTION_STATUS_LABELS: Record<string, string> = {
  pending: "À valider",
  approved: "Validée",
  executed: "Exécutée",
  rejected: "Rejetée",
  failed: "Échec",
};

/** Short chip form (uppercased by CSS), as in the Figma mock. */
const ACTION_CHIP_LABELS: Record<string, string> = {
  send_dunning: "Relance",
  create_quote: "Devis",
  submit_reconciliation: "Rappro",
  book_invoice: "Écriture",
};

export const actionTypeLabel = (type: string): string => ACTION_TYPE_LABELS[type] ?? type;

export const actionChipLabel = (type: string): string => ACTION_CHIP_LABELS[type] ?? type;

export const actionStatusLabel = (status: string): string =>
  ACTION_STATUS_LABELS[status] ?? status;

/** « il y a 2 min » — relative, coarse on purpose. */
export function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "à l'instant";
  if (seconds < 3600) return `il y a ${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `il y a ${Math.floor(seconds / 3600)} h`;
  return `il y a ${Math.floor(seconds / 86_400)} j`;
}
