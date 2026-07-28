import type { FecEntry } from "./parse.js";

/*
 * Dérivation métier — le cœur du ticket 2.14 : transformer un journal fiscal
 * en créances clients exploitables.
 *
 * - Comptes clients = racine 411 ; l'identité client vient du compte
 *   auxiliaire (CompAuxNum/CompAuxLib), à défaut du CompteNum.
 * - Une FACTURE = les écritures 411 d'une même pièce (PieceRef) pour un même
 *   client : montant = somme des débits ; les crédits de la même pièce
 *   (règlements, avoirs) réduisent le solde.
 * - Le LETTRAGE (EcritureLet) est la clé : toutes les lignes lettrées =
 *   créance soldée. Non lettrée + échéance estimée dépassée = IMPAYÉ.
 *   (Sans le lettrage, tout paraîtrait impayé — c'est lui qui rend la
 *   dérivation crédible.)
 * - L'échéance n'existe pas dans le FEC : elle est ESTIMÉE à date de pièce
 *   + `dueDays` (30 j par défaut — délai légal supplétif), et signalée comme
 *   estimation dans l'aval.
 */

export interface FecCustomer {
  ref: string;
  name: string | null;
}

export interface FecDerivedInvoice {
  customerRef: string;
  customerName: string | null;
  /** PieceRef — le numéro de pièce tient lieu de numéro de facture. */
  number: string;
  /** ISO yyyy-mm-dd (PieceDate, à défaut EcritureDate). */
  issuedDate: string;
  /** Somme des débits 411 de la pièce (total facturé). */
  amountCents: number;
  /** Débits - crédits : part restant due (0 si soldée). */
  residualCents: number;
  /** Toutes les lignes de la pièce sont lettrées. */
  settled: boolean;
  /** Échéance ESTIMÉE (issuedDate + dueDays). */
  dueDate: string;
}

export interface FecDerivation {
  customers: FecCustomer[];
  invoices: FecDerivedInvoice[];
  openCount: number;
  overdueCount: number;
  overdueCents: number;
  warnings: string[];
}

export interface DeriveOptions {
  /** Délai d'échéance estimé en jours (30 par défaut). */
  dueDays?: number;
  /** « Aujourd'hui » injectable (tests déterministes). */
  today?: Date;
}

const DAY_MS = 86_400_000;

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return new Date(date.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

export function deriveReceivables(entries: FecEntry[], options: DeriveOptions = {}): FecDerivation {
  const dueDays = options.dueDays ?? 30;
  const todayIso = (options.today ?? new Date()).toISOString().slice(0, 10);
  const warnings: string[] = [];

  const clientEntries = entries.filter((entry) => entry.compteNum.startsWith("411"));

  const customers = new Map<string, FecCustomer>();
  const groups = new Map<string, FecEntry[]>();
  let unreferenced = 0;

  for (const entry of clientEntries) {
    const customerRef = entry.compAuxNum ?? entry.compteNum;
    if (!customers.has(customerRef)) {
      customers.set(customerRef, {
        ref: customerRef,
        name: entry.compAuxLib ?? (entry.compteLib || null),
      });
    }
    if (!entry.pieceRef) {
      unreferenced++;
      continue;
    }
    const key = `${customerRef}␟${entry.pieceRef}`;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  if (unreferenced > 0) {
    warnings.push(`${unreferenced} écriture(s) 411 sans PieceRef ignorée(s) pour la facturation`);
  }

  const invoices: FecDerivedInvoice[] = [];
  let openCount = 0;
  let overdueCount = 0;
  let overdueCents = 0;

  for (const [key, group] of groups) {
    const debitCents = group.reduce((sum, e) => sum + e.debitCents, 0);
    const creditCents = group.reduce((sum, e) => sum + e.creditCents, 0);
    if (debitCents === 0) continue; // pièce purement au crédit (avoir isolé) : pas une facture
    const residualCents = Math.max(0, debitCents - creditCents);
    const settled = group.every((e) => e.ecritureLet !== null);
    const [customerRef] = key.split("␟");
    const first = group.reduce((a, b) => (a.ecritureDate <= b.ecritureDate ? a : b));
    const issuedDate = first.pieceDate ?? first.ecritureDate;
    const dueDate = addDays(issuedDate, dueDays);

    const invoice: FecDerivedInvoice = {
      customerRef: customerRef!,
      customerName: customers.get(customerRef!)?.name ?? null,
      number: first.pieceRef!,
      issuedDate,
      amountCents: debitCents,
      residualCents: settled ? 0 : residualCents,
      settled,
      dueDate,
    };
    invoices.push(invoice);

    if (!settled && invoice.residualCents > 0) {
      openCount++;
      if (dueDate < todayIso) {
        overdueCount++;
        overdueCents += invoice.residualCents;
      }
    }
  }

  invoices.sort((a, b) => (a.issuedDate < b.issuedDate ? 1 : -1));

  return {
    customers: [...customers.values()],
    invoices,
    openCount,
    overdueCount,
    overdueCents,
    warnings,
  };
}
