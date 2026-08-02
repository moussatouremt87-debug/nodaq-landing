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
  /** Montant du MARCHÉ, retenue comprise — sous les deux conventions de
   * comptabilisation (retenue transférée au 4117 après coup, ou portée dès la
   * facture). Ni le reclassement de la libération ni un escompte n'y entrent. */
  amountCents: number;
  /** Part restant due et EXIGIBLE (0 si soldée) — retenue de garantie EXCLUE. */
  residualCents: number;
  /** Retenue de garantie portée par CETTE pièce : due, mais pas encore
   * exigible. Elle n'entre ni dans `residualCents`, ni dans les impayés, ni
   * dans une relance. Une libération comptabilisée sous une AUTRE pièce ne s'y
   * déduit pas (elle n'est rattachable à aucune facture) — c'est le total de
   * la dérivation, lu sur le solde du compte, qui fait foi. */
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
  /** Retenues de garantie EN COURS — le SOLDE du compte 4117 (planché à zéro
   * par tiers), pas la somme des retenues par facture : une libération
   * comptabilisée sous sa propre pièce n'est rattachable à aucune facture, et
   * l'ignorer annoncerait comme « en cours » des sommes déjà encaissées.
   * Affiché À PART des impayés. */
  retainedCents: number;
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

  // POURQUOI IL N'Y A PAS DE RATTACHEMENT ENTRE REGROUPEMENTS
  //
  // La clé de regroupement est (client, pièce), et le « client » vient du
  // CompAuxNum — à défaut du numéro de compte. Dans un plan SANS comptabilité
  // auxiliaire, la facture vit au `411000` et sa retenue au `411700` : deux
  // « clients » pour notre clé, une seule et même facture pour l'artisan. La
  // retenue y forme donc une pièce à part, comptée en créance ordinaire.
  //
  // Trois versions successives ont tenté de reverser cette pièce dans la
  // facture de la même référence. Chacune a été prise en défaut sur un
  // montage réel, et TOUJOURS dans le même sens : une créance disparaissait,
  // ou changeait de client. Sous un plan « 411 + code client », rien ne
  // distingue structurellement le compte `41170003` du client n° 70003 d'un
  // compte de retenue `411700` + code — ni le préfixe, ni la forme de
  // l'écriture, ni la contrepartie.
  //
  // L'inférence elle-même est le défaut. Le coût des deux erreurs n'est PAS
  // symétrique : ne pas reconnaître une retenue la laisse dans les impayés
  // (le défaut d'origine, visible, et signalé) ; la reconnaître à tort fait
  // disparaître un dû réel et l'attribue à un autre client — invisible, et
  // faux dans les comptes.
  //
  // Une retenue n'est donc reconnue que DANS un regroupement (client, pièce),
  // où l'identité du tiers est acquise par construction. Sans auxiliaire, la
  // retenue reste une créance ordinaire — comme avant le ticket — et
  // l'avertissement le dit.

  const invoices: FecDerivedInvoice[] = [];
  let openCount = 0;
  let overdueCount = 0;
  let overdueCents = 0;
  let unattachedRetentionCount = 0;
  let lookalikeAccountCount = 0;
  let negativeRetentionCount = 0;
  /** Lignes 4117 effectivement reconnues comme retenue (et les tiers
   * correspondants) : elles seules alimentent le solde des retenues. */
  const recognisedRetentionLines = new Set<FecEntry>();
  const recognisedRetentionRefs = new Set<string>();

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
    for (const line of retentionLines) {
      recognisedRetentionLines.add(line);
      recognisedRetentionRefs.add(line.compAuxNum ?? line.compteNum);
    }
    if (flagged.length > 0 && ordinary.length > 0 && !retentionRecognised) {
      // La pièce porte une créance ET une retenue, mais aucune créance AU
      // DÉBIT : c'est l'OD de transfert comptabilisée sous sa propre
      // référence. La retenue n'est rattachable à aucune facture ici — on ne
      // fait pas semblant, on le dit.
      unattachedRetentionCount += flagged.length;
    }
    // Lignes 4117 AU DÉBIT laissées en créance ordinaire (le rattachement par
    // pièce n'a rien trouvé). Seul le débit compte : un crédit 4117 isolé est
    // une libération, il n'ajoute aucun impayé et n'a rien à signaler ici.
    const strandedRetentionDebits = ordinary.length === 0
      ? flagged.filter((e) => e.debitCents > 0).length
      : 0;
    lookalikeAccountCount += strandedRetentionDebits;
    const debitCents = dueLines.reduce((sum, e) => sum + e.debitCents, 0);
    const creditCents = dueLines.reduce((sum, e) => sum + e.creditCents, 0);
    // Retenue portée par CETTE pièce (débit au transfert, crédit à la
    // libération comptabilisée sous la même pièce). Le total, lui, se lit sur
    // le SOLDE du compte 4117 plus bas — une libération sous sa propre pièce
    // n'est rattachable à aucune facture.
    const retainedCents = Math.max(
      0,
      retentionLines.reduce((sum, e) => sum + e.debitCents - e.creditCents, 0),
    );
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
    // Discriminant : au sein d'une même ÉCRITURE, le débit 4117 a-t-il pour
    // contrepartie un crédit client du MÊME MONTANT ? Oui => transfert (déjà
    // carvé). Non => comptabilisation directe, le débit 4117 fait partie du
    // facturé.
    //
    // Le montant, et pas seulement la présence d'un crédit : une écriture de
    // vente peut porter un escompte ou un acompte imputé au crédit du client
    // (`débit 411 9 500 + débit 4117 500 + crédit 411 100`). Prendre ce
    // crédit pour un transfert ferait perdre la retenue au montant facturé.
    const creditByEcriture = new Map<string, number>();
    for (const line of ordinary) {
      if (line.creditCents > 0) {
        const k = ecritureKey(line);
        creditByEcriture.set(k, (creditByEcriture.get(k) ?? 0) + line.creditCents);
      }
    }
    const directRetentionCents = retentionLines
      .filter((e) => e.debitCents > 0 && creditByEcriture.get(ecritureKey(e)) !== e.debitCents)
      .reduce((sum, e) => sum + e.debitCents, 0);
    // …et symétriquement, un débit 411 dont la contrepartie de même montant
    // est un CRÉDIT 4117 n'est pas une vente : c'est la LIBÉRATION de la
    // retenue, qui reclasse une somme déjà facturée en somme exigible.
    // L'additionner gonflerait le montant facturé de 5 % — la direction
    // flatteuse que la marge (2.8) s'interdit précisément.
    const retentionCreditByEcriture = new Map<string, number>();
    for (const line of retentionLines) {
      if (line.creditCents > 0) {
        const k = ecritureKey(line);
        retentionCreditByEcriture.set(k, (retentionCreditByEcriture.get(k) ?? 0) + line.creditCents);
      }
    }
    const releaseReclassCents = dueLines
      .filter((e) => e.debitCents > 0 && retentionCreditByEcriture.get(ecritureKey(e)) === e.debitCents)
      .reduce((sum, e) => sum + e.debitCents, 0);
    // Une pièce NON reconnue (l'OD de transfert sous sa propre référence) a
    // ses lignes 4117 dans `dueLines` : sans ce retrait, le débit de transfert
    // deviendrait une VENTE de 500 € et gonflerait le CA de la retenue.
    const transferDebitCents = retentionRecognised
      ? 0
      : dueLines
          .filter(
            (e) =>
              classifyReceivableAccount(e.compteNum) === "retenue" &&
              e.debitCents > 0 &&
              creditByEcriture.get(ecritureKey(e)) === e.debitCents,
          )
          .reduce((sum, e) => sum + e.debitCents, 0);
    const invoicedCents =
      debitCents - releaseReclassCents - transferDebitCents + directRetentionCents;
    const residualCents = Math.max(0, debitCents - creditCents);
    // Une pièce sans montant facturé ET sans rien de dû n'est pas une facture
    // (un avoir isolé, par exemple).
    //
    // Le solde exigible fait partie de la condition : une LIBÉRATION
    // comptabilisée sous sa propre pièce (débit 411 / crédit 4117) a un
    // montant facturé nul — ce n'est pas une vente — mais elle rend 500 €
    // EXIGIBLES. L'écarter les ferait disparaître de tous les compteurs, et
    // personne ne pourrait plus les réclamer.
    if (invoicedCents === 0 && retainedCents === 0 && residualCents === 0) continue;
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
  }

  // POURQUOI LA LEVÉE DES RÉSERVES N'EST PAS RECOLLÉE À SA FACTURE
  //
  // Quand la levée est comptabilisée sous sa PROPRE pièce, elle sort ici comme
  // une pièce à montant facturé nul (ce n'est pas une vente) mais à solde
  // exigible. La reverser dans la facture d'origine paraissait plus propre —
  // sauf qu'une facture ne porte qu'UNE échéance : la somme libérée héritait
  // de celle de la facture, et une levée de juillet ressortait « en retard de
  // 146 jours » dès l'instant où elle est enregistrée. Relancer un bon client
  // sur une somme exigible depuis quatre jours est exactement la faute que ce
  // ticket corrige, un cran plus loin.
  //
  // La pièce de levée garde donc SA date, donc SA propre échéance. C'est elle
  // qui porte le solde redevenu exigible, et l'aval sait le réclamer : la
  // relance juge la lisibilité sur le solde restant dû, pas sur le montant
  // facturé.

  for (const invoice of invoices) {
    if (!invoice.settled && invoice.residualCents > 0) {
      openCount++;
      if (invoice.dueDate < todayIso) {
        overdueCount++;
        overdueCents += invoice.residualCents;
      }
    }
  }

  // TOTAL DES RETENUES = le SOLDE du compte 4117, pas la somme des retenues
  // portées par les factures.
  //
  // Une libération se comptabilise souvent sous sa propre pièce (`débit 512 /
  // crédit 4117`) : elle n'est alors rattachable à aucune facture, et la somme
  // des retenues par facture continuerait d'annoncer « X € de retenue en
  // cours » sur des sommes déjà encaissées. Un solde de compte, lui, n'a rien
  // à rattacher — il est juste par construction.
  //
  // Plancher à zéro par SEAU DE SOLDE — le compte auxiliaire quand la
  // comptabilité en tient un, le compte lui-même sinon. Avec auxiliaire, un
  // client sur-libéré ne masque donc pas la retenue d'un autre.
  //
  // SANS auxiliaire, toutes les retenues vivent sur le même compte : le seau
  // est unique, et une sur-libération peut y compenser la retenue d'un autre
  // client. C'est une limite du plan comptable, pas un choix — elle est DITE
  // (avertissement ci-dessous) plutôt que promise résolue.
  //
  // Seules les lignes que la dérivation a RECONNUES comme retenue entrent
  // dans ce solde — plus les mouvements du même compte, qui sont alors des
  // libérations. Une ligne 4117 laissée en créance ordinaire (compte client
  // en 4117xxxx) est déjà comptée dans les impayés : l'ajouter ici
  // l'annoncerait une seconde fois, en retenue cette fois.
  const retentionBalances = new Map<string, number>();
  const pooledRefs = new Map<string, { pieces: Set<string>; released: boolean }>();
  // Une libération est souvent saisie SANS auxiliaire (`débit 512 / crédit
  // 411700`) alors que la retenue, elle, en portait un. Les deux lignes
  // tomberaient dans deux seaux différents et ne se compenseraient jamais :
  // le solde annoncerait « en cours » une somme encaissée. Quand un compte de
  // retenue n'a qu'UN seul tiers reconnu, la sortie sans auxiliaire lui
  // revient — une seule candidate n'est pas une supposition.
  //
  // Ce report reste un rattachement entre regroupements : il ne vaut donc que
  // si le compte ne porte AUCUNE autre retenue non reconnue. Sinon la sortie
  // pourrait appartenir à ce tiers-là, et l'imputer au seul tiers reconnu
  // sous-évaluerait sa retenue — en silence. Dans le doute, on ne compense
  // pas, et on le dit.
  const refsByAccount = new Map<string, Set<string>>();
  const ambiguousAccounts = new Set<string>();
  for (const entry of clientEntries) {
    if (classifyReceivableAccount(entry.compteNum) !== "retenue") continue;
    if (recognisedRetentionLines.has(entry)) {
      const refs = refsByAccount.get(entry.compteNum) ?? new Set<string>();
      refs.add(entry.compAuxNum ?? entry.compteNum);
      refsByAccount.set(entry.compteNum, refs);
    } else if (entry.debitCents > 0) {
      // Une retenue NON reconnue sur ce compte : sa libération future y
      // ressemblerait trait pour trait à celle d'un tiers reconnu.
      ambiguousAccounts.add(entry.compteNum);
    }
  }
  let unattachedReleaseCount = 0;
  for (const entry of clientEntries) {
    if (classifyReceivableAccount(entry.compteNum) !== "retenue") continue;
    let ref = entry.compAuxNum ?? entry.compteNum;
    // Une ligne non reconnue n'entre au solde que si c'est un mouvement de
    // SORTIE (une libération) sur un compte où une retenue a bien été
    // reconnue. Un DÉBIT non reconnu, lui, est déjà compté dans les impayés :
    // l'ajouter ici annoncerait la même somme deux fois, en créance et en
    // retenue.
    const isRelease = entry.creditCents > 0 && entry.debitCents === 0;
    if (!recognisedRetentionLines.has(entry)) {
      if (!isRelease) continue;
      if (!recognisedRetentionRefs.has(ref)) {
        const candidates = refsByAccount.get(entry.compteNum);
        if (
          entry.compAuxNum === null &&
          candidates?.size === 1 &&
          !ambiguousAccounts.has(entry.compteNum)
        ) {
          ref = [...candidates][0]!;
        } else {
          unattachedReleaseCount += 1;
          continue;
        }
      }
    }
    retentionBalances.set(
      ref,
      (retentionBalances.get(ref) ?? 0) + entry.debitCents - entry.creditCents,
    );
    // Le risque de compensation entre clients n'existe que si le seau porte
    // plusieurs pièces ET une libération : sans sortie, aucune retenue ne
    // peut en masquer une autre. Avertir sans ça ferait du bruit permanent
    // sur tout plan sans auxiliaire — et un avertissement qu'on apprend à
    // ignorer ne protège plus de rien.
    if (entry.compAuxNum === null && entry.pieceRef) {
      const bucket = pooledRefs.get(ref) ?? { pieces: new Set<string>(), released: false };
      bucket.pieces.add(entry.pieceRef);
      if (entry.creditCents > 0) bucket.released = true;
      pooledRefs.set(ref, bucket);
    }
  }
  let retainedTotalCents = 0;
  for (const balance of retentionBalances.values()) {
    if (balance < 0) negativeRetentionCount += 1;
    retainedTotalCents += Math.max(0, balance);
  }
  const pooledAccounts = [...pooledRefs.values()].filter((b) => b.pieces.size > 1 && b.released).length;

  if (pooledAccounts > 0) {
    warnings.push(
      `${pooledAccounts} compte(s) de retenue de garantie sans compte auxiliaire portant ` +
        "plusieurs pièces : le solde des retenues y est net par COMPTE et non par client " +
        "(une libération excessive peut y compenser la retenue d'un autre client)",
    );
  }
  if (unattachedRetentionCount > 0) {
    warnings.push(
      `${unattachedRetentionCount} écriture(s) 4117 non rattachée(s) à une créance du même ` +
        "regroupement (client, pièce) : traitées comme des créances ordinaires (retenue NON " +
        "déduite des impayés)",
    );
  }
  if (lookalikeAccountCount > 0) {
    // Sans créance 411 dans la pièce, deux situations sont INDISCERNABLES :
    // un plan « 411 + code client » (le client 70003 porte le compte
    // 41170003, il n'y a aucune retenue) ou une vraie retenue orpheline.
    // Trancher serait un diagnostic inventé : on dit le fait et sa
    // conséquence, pas la cause.
    warnings.push(
      `${lookalikeAccountCount} écriture(s) 4117 au débit sans aucune créance 411 dans le même ` +
        "regroupement (client, pièce) : traitées comme des créances ordinaires (compte client " +
        "en 4117xxxx ou retenue non rattachable). Rien n'est déduit des impayés — s'il s'agit " +
        "d'une retenue, elle peut donc apparaître en retard et faire l'objet d'une proposition " +
        "de relance",
    );
  }
  // Sans AUCUNE retenue reconnue dans le fichier, ce message est sans objet :
  // sur un plan « 411 + code client », chaque règlement client crédite un
  // compte 4117xxxx et l'alimenterait — un avertissement permanent, faux, à
  // côté d'un total de retenues à zéro.
  if (unattachedReleaseCount > 0 && recognisedRetentionLines.size > 0) {
    warnings.push(
      `${unattachedReleaseCount} mouvement(s) de sortie sur un compte 4117 non rattachable(s) ` +
        "à une retenue reconnue : le total des retenues en cours peut être surévalué d'autant",
    );
  }
  if (negativeRetentionCount > 0) {
    warnings.push(
      `${negativeRetentionCount} compte(s) de retenue de garantie au solde négatif ` +
        "(libération sur-comptabilisée ?) — ramené(s) à zéro, à vérifier",
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
    warnings,
  };
}
