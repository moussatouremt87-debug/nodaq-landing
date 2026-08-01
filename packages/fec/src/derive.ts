import { classifyReceivableAccount } from "@nodaq/shared";
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
  /** Somme des débits 411 de la pièce (total facturé). La retenue y est déjà
   * comprise : elle est carvée par le transfert vers le 4117, pas ajoutée. */
  amountCents: number;
  /** Part restant due et EXIGIBLE (0 si soldée) — retenue de garantie EXCLUE. */
  residualCents: number;
  /** Retenue de garantie (4117) : due, mais pas encore exigible. Elle n'entre
   * ni dans `residualCents`, ni dans les impayés, ni dans une relance. */
  retainedCents: number;
  /** Toutes les lignes EXIGIBLES de la pièce sont lettrées. La retenue, non
   * lettrée jusqu'à la levée des réserves, ne peut pas empêcher ce solde. */
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
  /** Total des retenues de garantie en cours — affiché À PART des impayés. */
  retainedCents: number;
  /** Nombre de factures portant une retenue. */
  retentionCount: number;
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

  // 4117 (« Clients — Retenues de garantie ») est une SUBDIVISION de 411 :
  // filtrer sur "411" l'embarquait avec les créances ordinaires. La retenue
  // gonflait alors le montant facturé, laissait la pièce non lettrée, et
  // ressortait en impayé — jusqu'à une proposition de relance (US-8).
  const clientEntries = entries.filter(
    (entry) => classifyReceivableAccount(entry.compteNum) !== "hors_clients",
  );

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
  let retainedTotalCents = 0;
  let retentionCount = 0;

  for (const [key, group] of groups) {
    // Deux populations DISTINCTES : l'exigible (411) et la retenue (4117).
    const dueLines = group.filter((e) => classifyReceivableAccount(e.compteNum) === "client");
    const retentionLines = group.filter(
      (e) => classifyReceivableAccount(e.compteNum) === "retenue",
    );
    const debitCents = dueLines.reduce((sum, e) => sum + e.debitCents, 0);
    const creditCents = dueLines.reduce((sum, e) => sum + e.creditCents, 0);
    // Retenue = solde du 4117 (débit au transfert, crédit à la libération).
    const retainedCents = Math.max(
      0,
      retentionLines.reduce((sum, e) => sum + e.debitCents - e.creditCents, 0),
    );
    if (debitCents === 0 && retainedCents === 0) continue; // avoir isolé : pas une facture
    const residualCents = Math.max(0, debitCents - creditCents);
    // Le lettrage ne se juge QUE sur les lignes exigibles : la retenue reste
    // non lettrée jusqu'à la levée des réserves, et ne doit pas à elle seule
    // faire passer une facture réglée pour ouverte.
    const settled = dueLines.every((e) => e.ecritureLet !== null);
    const [customerRef] = key.split("␟");
    const first = group.reduce((a, b) => (a.ecritureDate <= b.ecritureDate ? a : b));
    const issuedDate = first.pieceDate ?? first.ecritureDate;
    const dueDate = addDays(issuedDate, dueDays);

    const invoice: FecDerivedInvoice = {
      customerRef: customerRef!,
      customerName: customers.get(customerRef!)?.name ?? null,
      number: first.pieceRef!,
      issuedDate,
      // Débits 411 de la pièce : la retenue est CARVÉE dans ce montant par le
      // transfert vers le 4117 (crédit 411 / débit 4117), pas ajoutée à côté.
      // L'additionner compterait les 5 % deux fois.
      amountCents: debitCents,
      residualCents: settled ? 0 : residualCents,
      retainedCents,
      settled,
      dueDate,
    };
    invoices.push(invoice);

    if (retainedCents > 0) {
      retainedTotalCents += retainedCents;
      retentionCount++;
    }
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
    retainedCents: retainedTotalCents,
    retentionCount,
    warnings,
  };
}
