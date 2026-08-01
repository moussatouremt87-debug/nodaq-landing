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

/** Identité d'une ÉCRITURE comptable (journal + numéro) : c'est à ce niveau,
 * pas à celui de la pièce, que débits et crédits se font face. */
function ecritureKey(entry: FecEntry): string {
  return `${entry.journalCode}␟${entry.ecritureNum}`;
}

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
  let unattachedRetentionCount = 0;
  let lookalikeAccountCount = 0;
  let negativeRetentionCount = 0;

  for (const [key, group] of groups) {
    // Deux populations DISTINCTES : l'exigible (411) et la retenue (4117).
    //
    // NARROWING DE SÛRETÉ (audit US-8). Le préfixe seul ne suffit PAS à
    // reconnaître une retenue : sous le schéma courant « 411 + code client »,
    // le client n° 70003 porte le compte `41170003`, indiscernable d'un
    // `4117` + code. Classer ses créances en « retenue » les sortirait des
    // impayés — un vrai dû disparaîtrait en silence, ce qui est PIRE que la
    // relance abusive qu'on corrige.
    //
    // Une retenue n'est donc reconnue que si la pièce porte AUSSI une créance
    // ordinaire AU DÉBIT dont elle a pu être carvée. Sinon, la ligne reste une
    // créance comme avant (comportement 2.14 strictement inchangé).
    //
    // Le débit, et pas la simple présence d'une ligne 411 : quand l'OD de
    // transfert porte sa PROPRE référence de pièce (convention fréquente), le
    // groupe ne contient que la contrepartie au CRÉDIT — il n'y a là aucune
    // facture à alléger, et faire semblant produirait une pièce fantôme à 0 €
    // pendant que la vraie facture garderait sa retenue en impayé, sans un mot.
    const ordinary = group.filter((e) => classifyReceivableAccount(e.compteNum) === "client");
    const flagged = group.filter((e) => classifyReceivableAccount(e.compteNum) === "retenue");
    const ordinaryDebitCents = ordinary.reduce((sum, e) => sum + e.debitCents, 0);
    const retentionRecognised = ordinaryDebitCents > 0 && flagged.length > 0;
    const dueLines = retentionRecognised ? ordinary : group;
    const retentionLines = retentionRecognised ? flagged : [];
    if (flagged.length > 0 && ordinary.length > 0 && !retentionRecognised) {
      // La pièce porte une créance ET une retenue, mais aucune créance AU
      // DÉBIT : c'est l'OD de transfert comptabilisée sous sa propre
      // référence. La retenue n'est rattachable à aucune facture ici — on ne
      // fait pas semblant, on le dit.
      unattachedRetentionCount += flagged.length;
    }
    if (flagged.length > 0 && ordinary.length === 0) {
      // Aucune ligne 411 « ordinaire » dans la pièce : très probablement un
      // plan « 411 + code client » où le client porte un compte en 4117xxxx.
      // Le dire comme une retenue non rattachée serait faux — il n'y a pas de
      // retenue du tout, juste un compte client qui ressemble à 4117.
      lookalikeAccountCount += flagged.length;
    }
    const debitCents = dueLines.reduce((sum, e) => sum + e.debitCents, 0);
    const creditCents = dueLines.reduce((sum, e) => sum + e.creditCents, 0);
    // Retenue = solde du 4117 (débit au transfert, crédit à la libération).
    const rawRetained = retentionLines.reduce((sum, e) => sum + e.debitCents - e.creditCents, 0);
    // Une retenue négative = libération sur-comptabilisée. La ramener à zéro
    // en silence contredirait la garde annoncée : on la compte et on la dit.
    if (rawRetained < 0) negativeRetentionCount += 1;
    const retainedCents = Math.max(0, rawRetained);
    // MONTANT FACTURÉ — il doit valoir le marché sous LES DEUX conventions de
    // comptabilisation, sinon le CA lui-même est amputé (2.11/3.1/2.8) :
    //
    //   a) TRANSFERT : la facture débite 411 pour 10 000, puis une OD crédite
    //      411 de 500 et débite 4117 de 500. La retenue est CARVÉE du débit —
    //      l'additionner compterait les 5 % deux fois.
    //   b) DIRECTE : la facture débite 411 de 9 500 ET 4117 de 500 dans la
    //      MÊME écriture, face au 706. Il n'y a rien à carver : sans le débit
    //      4117, le montant facturé perd la retenue, et l'aval la déduit une
    //      seconde fois — une créance réelle disparaît en silence.
    //
    // Discriminant : au sein d'une même ÉCRITURE, la contrepartie du débit
    // 4117 est-elle un crédit client ? Oui => transfert (déjà carvé). Non =>
    // comptabilisation directe, le débit 4117 fait partie du facturé.
    const transferEcritures = new Set(
      ordinary.filter((e) => e.creditCents > 0).map(ecritureKey),
    );
    const directRetentionCents = retentionLines
      .filter((e) => e.debitCents > 0 && !transferEcritures.has(ecritureKey(e)))
      .reduce((sum, e) => sum + e.debitCents, 0);
    const invoicedCents = debitCents + directRetentionCents;
    if (invoicedCents === 0 && retainedCents === 0) continue; // avoir isolé : pas une facture
    const residualCents = Math.max(0, debitCents - creditCents);
    // Le lettrage ne se juge QUE sur les lignes exigibles : la retenue reste
    // non lettrée jusqu'à la levée des réserves, et ne doit pas à elle seule
    // faire passer une facture réglée pour ouverte.
    // `dueLines.length > 0` est une garde de STRUCTURE : `every` sur un
    // tableau vide renvoie `true`, donc une pièce sans ligne exigible serait
    // déclarée soldée. Aujourd'hui le cas ne peut pas se produire (la retenue
    // n'est reconnue que si la pièce a une créance au débit, sinon `dueLines`
    // vaut le groupe entier) — la garde est là pour que ça ne le devienne pas
    // en silence si cette condition change.
    const settled = dueLines.length > 0 && dueLines.every((e) => e.ecritureLet !== null);
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
      amountCents: invoicedCents,
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

  if (unattachedRetentionCount > 0) {
    warnings.push(
      `${unattachedRetentionCount} écriture(s) 4117 non rattachée(s) à une créance de la même ` +
        "pièce : traitées comme des créances ordinaires (retenue NON déduite des impayés)",
    );
  }
  if (lookalikeAccountCount > 0) {
    warnings.push(
      `${lookalikeAccountCount} écriture(s) sur un compte commençant par 4117 sans aucune ` +
        "créance 411 dans la pièce : traitées comme des créances ordinaires (plan " +
        "« 411 + code client » probable, aucune retenue de garantie déduite)",
    );
  }
  if (negativeRetentionCount > 0) {
    warnings.push(
      `${negativeRetentionCount} retenue(s) de garantie négative(s) (libération ` +
        "sur-comptabilisée ?) — ramenée(s) à zéro, à vérifier",
    );
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
