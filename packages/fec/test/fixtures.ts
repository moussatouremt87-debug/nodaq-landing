/*
 * Fixtures FEC synthétiques imitant les variantes réelles des éditeurs
 * (Sage, EBP, Cegid, ACD…) : séparateur tab/pipe, décimale virgule/point,
 * encodage UTF-8/ISO-8859-15, variante BNC Montant/Sens, colonnes en trop.
 * AUCUNE donnée réelle — tout est inventé.
 */

export const HEADER = [
  "JournalCode",
  "JournalLib",
  "EcritureNum",
  "EcritureDate",
  "CompteNum",
  "CompteLib",
  "CompAuxNum",
  "CompAuxLib",
  "PieceRef",
  "PieceDate",
  "EcritureLib",
  "Debit",
  "Credit",
  "EcritureLet",
  "DateLet",
  "ValidDate",
  "Montantdevise",
  "Idevise",
];

export interface Row {
  journal?: string;
  num?: string;
  date: string;
  compte: string;
  compteLib?: string;
  aux?: string;
  auxLib?: string;
  piece?: string;
  pieceDate?: string;
  lib?: string;
  debit?: string;
  credit?: string;
  let?: string;
  dateLet?: string;
}

export function row(r: Row): string[] {
  return [
    r.journal ?? "VE",
    "Ventes",
    r.num ?? "1",
    r.date,
    r.compte,
    r.compteLib ?? "Clients",
    r.aux ?? "",
    r.auxLib ?? "",
    r.piece ?? "",
    r.pieceDate ?? "",
    r.lib ?? "Écriture",
    r.debit ?? "0,00",
    r.credit ?? "0,00",
    r.let ?? "",
    r.dateLet ?? "",
    "",
    "",
    "",
  ];
}

export function build(rows: string[][], sep = "\t", header: string[] = HEADER): string {
  return [header.join(sep), ...rows.map((r) => r.join(sep))].join("\r\n") + "\r\n";
}

/**
 * Jeu « équilibré » type : ventes clients (411 au débit, 706 au crédit),
 * un règlement lettré (512 contre 411), un paiement partiel non lettré.
 */
export function balancedRows(): string[][] {
  return [
    // Facture F-001 (client ALPHA) : 1 200,00 — lettrée + réglée.
    row({ num: "1", date: "20260110", compte: "41100001", aux: "CALPHA", auxLib: "Menuiserie Alpha", piece: "F-001", pieceDate: "20260110", lib: "Facture F-001", debit: "1200,00", let: "AA", dateLet: "20260215" }),
    row({ num: "1", date: "20260110", compte: "706000", compteLib: "Prestations", piece: "F-001", pieceDate: "20260110", lib: "Facture F-001", credit: "1200,00" }),
    row({ journal: "BQ", num: "2", date: "20260214", compte: "512000", compteLib: "Banque", piece: "REG-1", lib: "Encaissement", debit: "1200,00" }),
    row({ journal: "BQ", num: "2", date: "20260214", compte: "41100001", aux: "CALPHA", auxLib: "Menuiserie Alpha", piece: "F-001", lib: "Règlement F-001", credit: "1200,00", let: "AA", dateLet: "20260215" }),
    // Facture F-002 (client BETA) : 2 500,00 — NON lettrée, échue.
    row({ num: "3", date: "20260105", compte: "41100002", aux: "CBETA", auxLib: "SCI Beta", piece: "F-002", pieceDate: "20260105", lib: "Facture F-002", debit: "2500,00" }),
    row({ num: "3", date: "20260105", compte: "706000", compteLib: "Prestations", piece: "F-002", pieceDate: "20260105", lib: "Facture F-002", credit: "2500,00" }),
    // Facture F-003 (client GAMMA) : 1 000,00 — paiement partiel 400, non lettrée.
    row({ num: "4", date: "20260601", compte: "41100003", aux: "CGAMMA", auxLib: "Garage Gamma", piece: "F-003", pieceDate: "20260601", lib: "Facture F-003", debit: "1000,00" }),
    row({ num: "4", date: "20260601", compte: "706000", compteLib: "Prestations", piece: "F-003", pieceDate: "20260601", lib: "Facture F-003", credit: "1000,00" }),
    row({ journal: "BQ", num: "5", date: "20260620", compte: "512000", compteLib: "Banque", piece: "REG-2", lib: "Acompte", debit: "400,00" }),
    row({ journal: "BQ", num: "5", date: "20260620", compte: "41100003", aux: "CGAMMA", auxLib: "Garage Gamma", piece: "F-003", lib: "Acompte F-003", credit: "400,00" }),
  ];
}
