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

export const actionTypeLabel = (type: string): string => ACTION_TYPE_LABELS[type] ?? type;

export const actionStatusLabel = (status: string): string =>
  ACTION_STATUS_LABELS[status] ?? status;
