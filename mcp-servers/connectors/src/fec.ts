import { withTenant } from "@nodaq/db";
import { PennylaneClient } from "./pennylane.js";

/*
 * Client « connecteur fichier » FEC (ticket 2.14) : sert les créances
 * DÉRIVÉES d'un import FEC (tables fec_invoices/fec_imports, scellées RLS)
 * à travers l'interface Pennylane existante — l'aval (outils MCP, employé
 * Compta, cockpit) fonctionne sans modification. Zéro réseau, zéro secret :
 * les données viennent de la base, sous withTenant exclusivement.
 *
 * L'échéance étant ESTIMÉE (le FEC ne la contient pas), le statut « late »
 * signifie : non lettrée ET échéance estimée (pièce + 30 j) dépassée.
 */

const PAGE_SIZE_MAX = 100;

export const FEC_CONNECTOR_TYPE = "fec";
/** Statut posé par l'import (jamais « active » : rien n'est connecté). */
export const FEC_CONNECTOR_STATUS = "file";

export class FecPennylaneClient extends PennylaneClient {
  constructor(private readonly tenantId: string) {
    // Identifiants factices jamais utilisés : toutes les méthodes réseau
    // sont surchargées par des lectures base.
    super({ apiKey: "fec-file-connector" });
  }

  override async listCustomerInvoices(options: { limit?: number; cursor?: string } = {}) {
    const limit = Math.min(options.limit ?? 25, PAGE_SIZE_MAX);
    const offset = options.cursor ? Number.parseInt(options.cursor, 10) || 0 : 0;
    const todayIso = new Date().toISOString().slice(0, 10);
    const rows = await withTenant(this.tenantId, (tx) =>
      tx.fecInvoice.findMany({
        orderBy: [{ issuedDate: "desc" }, { number: "asc" }],
        skip: offset,
        take: limit + 1,
      }),
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => {
        const dueIso = row.dueDate.toISOString().slice(0, 10);
        return {
          id: row.id,
          invoice_number: row.number,
          amount: (row.amountCents / 100).toFixed(2),
          currency: "EUR",
          date: row.issuedDate.toISOString().slice(0, 10),
          deadline: dueIso,
          status: row.settled
            ? "paid"
            : row.residualCents > 0 && dueIso < todayIso
              ? "late"
              : "pending",
        };
      }),
      next_cursor: rows.length > limit ? String(offset + limit) : null,
    };
  }

  override async listCustomers(options: { limit?: number; cursor?: string } = {}) {
    const limit = Math.min(options.limit ?? 25, PAGE_SIZE_MAX);
    const rows = await withTenant(this.tenantId, (tx) =>
      tx.fecInvoice.findMany({
        select: { customerRef: true, customerName: true },
        distinct: ["customerRef"],
        orderBy: { customerRef: "asc" },
        take: limit,
      }),
    );
    return {
      items: rows.map((row) => ({
        id: row.customerRef,
        name: row.customerName,
        emails: null,
      })),
      next_cursor: null,
    };
  }
}
