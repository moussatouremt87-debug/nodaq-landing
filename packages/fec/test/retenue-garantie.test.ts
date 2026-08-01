import { describe, expect, it } from "vitest";
import { deriveReceivables, parseFec } from "../src/index.js";
import { build, row } from "./fixtures.js";

/*
 * Retenue de garantie (US-8 du ticket 2.20) — le test BLOQUANT du lot.
 *
 * Dans le bâtiment, le client retient 5 % jusqu'à la levée des réserves. Ce
 * n'est pas un impayé : c'est une somme non exigible, prévue au marché. Le
 * produit qui relance là-dessus prouve qu'il ne connaît pas le métier — c'est
 * la faute la plus chère en crédibilité devant un artisan.
 *
 * Comptablement, la retenue vit au 4117 (« Clients — Retenues de garantie »).
 * La dérivation filtrait sur `411`, qui INCLUT 4117 : la retenue était donc
 * agrégée à la facture, la laissait non lettrée, et ressortait en impayé.
 */

const TODAY = new Date("2026-07-05T12:00:00Z");

function entriesOf(rows: string[][]) {
  const parsed = parseFec(build(rows));
  if (!parsed.ok) throw new Error("fixture invalide");
  return parsed.entries;
}

/**
 * Chantier de 10 000 € : le client règle 9 500 €, 500 € (5 %) sont retenus au
 * 4117 jusqu'à la levée des réserves. Écritures équilibrées, comme un vrai FEC.
 */
function chantierAvecRetenue(): string[][] {
  return [
    // Facture F-100 : 10 000 € au débit du client, contrepartie 706. Lettrée
    // (« AA ») avec le transfert de retenue et le règlement du solde.
    row({ num: "1", date: "20260110", compte: "41100001", aux: "CBTP", auxLib: "SCI Chantier", piece: "F-100", pieceDate: "20260110", lib: "Facture F-100", debit: "10000,00", let: "AA" }),
    row({ num: "1", date: "20260110", compte: "706000", compteLib: "Prestations", piece: "F-100", pieceDate: "20260110", lib: "Facture F-100", credit: "10000,00" }),
    // Transfert de la retenue : 500 € du 411 vers le 4117 (non exigible).
    row({ num: "2", date: "20260110", compte: "41170001", aux: "CBTP", auxLib: "SCI Chantier", piece: "F-100", lib: "Retenue de garantie 5%", debit: "500,00" }),
    row({ num: "2", date: "20260110", compte: "41100001", aux: "CBTP", auxLib: "SCI Chantier", piece: "F-100", lib: "Retenue de garantie 5%", credit: "500,00", let: "AA" }),
    // Règlement du solde exigible : 9 500 € encaissés et lettrés.
    row({ journal: "BQ", num: "3", date: "20260214", compte: "512000", compteLib: "Banque", piece: "REG-100", lib: "Encaissement", debit: "9500,00" }),
    row({ journal: "BQ", num: "3", date: "20260214", compte: "41100001", aux: "CBTP", auxLib: "SCI Chantier", piece: "F-100", lib: "Règlement F-100", credit: "9500,00", let: "AA" }),
  ];
}

describe("retenue de garantie — jamais un impayé", () => {
  it("BLOQUANT : une facture soldée HORS retenue ne génère aucun impayé", () => {
    const result = deriveReceivables(entriesOf(chantierAvecRetenue()), { today: TODAY });
    const invoice = result.invoices.find((i) => i.number === "F-100");
    expect(invoice).toBeDefined();
    // Le solde exigible est nul : plus rien n'est dû aujourd'hui.
    expect(invoice?.residualCents).toBe(0);
    expect(invoice?.settled).toBe(true);
    // Et surtout : rien à relancer.
    expect(result.overdueCount).toBe(0);
    expect(result.overdueCents).toBe(0);
    expect(result.openCount).toBe(0);
  });

  it("la retenue est CONSERVÉE et affichée à part, jamais effacée", () => {
    const result = deriveReceivables(entriesOf(chantierAvecRetenue()), { today: TODAY });
    const invoice = result.invoices.find((i) => i.number === "F-100");
    // 5 % de 10 000 € : la somme existe, elle n'est simplement pas exigible.
    expect(invoice?.retainedCents).toBe(50_000);
    expect(result.retainedCents).toBe(50_000);
  });

  it("le montant de la facture reste le montant du marché", () => {
    const result = deriveReceivables(entriesOf(chantierAvecRetenue()), { today: TODAY });
    // Sortir la retenue du solde exigible ne doit pas réécrire le montant
    // facturé : le chantier vaut bien 10 000 €.
    expect(result.invoices.find((i) => i.number === "F-100")?.amountCents).toBe(1_000_000);
  });

  it("un VRAI impayé reste un impayé : la garde ne blanchit pas tout", () => {
    // Même chantier, mais le client n'a rien réglé : 9 500 € exigibles et
    // échus. La retenue reste hors du calcul, le reste est bien dû. Écritures
    // reconstruites (pas de lettrage : rien n'est soldé).
    const rows = [
      row({ num: "1", date: "20260110", compte: "41100001", aux: "CBTP", piece: "F-100", pieceDate: "20260110", lib: "Facture F-100", debit: "10000,00" }),
      row({ num: "1", date: "20260110", compte: "706000", compteLib: "Prestations", piece: "F-100", pieceDate: "20260110", lib: "Facture F-100", credit: "10000,00" }),
      row({ num: "2", date: "20260110", compte: "41170001", aux: "CBTP", piece: "F-100", lib: "Retenue de garantie 5%", debit: "500,00" }),
      row({ num: "2", date: "20260110", compte: "41100001", aux: "CBTP", piece: "F-100", lib: "Retenue de garantie 5%", credit: "500,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    const invoice = result.invoices.find((i) => i.number === "F-100");
    expect(invoice?.residualCents).toBe(950_000);
    expect(invoice?.retainedCents).toBe(50_000);
    expect(result.overdueCount).toBe(1);
    expect(result.overdueCents).toBe(950_000);
  });

  it("BLOQUANT : un compte client 411 + code commençant par 7 n'est PAS une retenue", () => {
    // Schéma courant « 411 + code client » : le client n° 70003 porte le
    // compte 41170003, indiscernable d'un « 4117 + code ». Le classer en
    // retenue sortirait TOUTES ses créances des impayés — un vrai dû
    // disparaîtrait en silence, pire que la relance abusive qu'on corrige.
    const rows = [
      row({ num: "1", date: "20260105", compte: "41170003", aux: "C70003", piece: "F-300", pieceDate: "20260105", lib: "Facture F-300", debit: "3000,00" }),
      row({ num: "1", date: "20260105", compte: "706000", compteLib: "Prestations", piece: "F-300", pieceDate: "20260105", lib: "Facture F-300", credit: "3000,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    const invoice = result.invoices.find((i) => i.number === "F-300");
    // Créance ordinaire : due, échue, relançable — comme avant le correctif.
    expect(invoice?.settled).toBe(false);
    expect(invoice?.residualCents).toBe(300_000);
    expect(invoice?.retainedCents).toBe(0);
    expect(result.overdueCount).toBe(1);
  });

  it("BLOQUANT : une pièce SANS ligne exigible n'est jamais « soldée » par défaut", () => {
    // `every` sur un tableau vide renvoie true : sans garde, cette pièce
    // passait pour réglée et sortait de tous les compteurs, sans un mot.
    const rows = [
      row({ num: "1", date: "20260105", compte: "41170002", aux: "CSEUL", piece: "F-400", pieceDate: "20260105", lib: "Facture F-400", debit: "10000,00" }),
      row({ num: "1", date: "20260105", compte: "706000", compteLib: "Prestations", piece: "F-400", pieceDate: "20260105", lib: "Facture F-400", credit: "10000,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    const invoice = result.invoices.find((i) => i.number === "F-400");
    expect(invoice?.settled).toBe(false);
    expect(result.overdueCount).toBe(1);
  });

  it("transfert sous SA propre pièce : la garde ne s'applique pas, et elle le DIT", () => {
    // Convention comptable fréquente : l'OD de transfert porte sa propre
    // référence. La retenue n'est alors pas rattachable à la facture — on ne
    // fait pas semblant, on avertit.
    const rows = [
      row({ num: "1", date: "20260110", compte: "41100004", aux: "COD", piece: "F-500", pieceDate: "20260110", lib: "Facture F-500", debit: "10000,00" }),
      row({ num: "1", date: "20260110", compte: "706000", compteLib: "Prestations", piece: "F-500", pieceDate: "20260110", lib: "Facture F-500", credit: "10000,00" }),
      row({ num: "2", date: "20260110", compte: "41170004", aux: "COD", piece: "RG-500", lib: "Retenue", debit: "500,00" }),
      row({ num: "2", date: "20260110", compte: "41100004", aux: "COD", piece: "RG-500", lib: "Retenue", credit: "500,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    expect(result.warnings.some((w) => w.includes("non rattachée"))).toBe(true);
  });

  it("retenue négative : ramenée à zéro mais SIGNALÉE, jamais absorbée", () => {
    const rows = [
      row({ num: "1", date: "20260110", compte: "41100005", aux: "CNEG", piece: "F-600", pieceDate: "20260110", lib: "Facture F-600", debit: "10000,00", let: "AA" }),
      row({ num: "1", date: "20260110", compte: "706000", compteLib: "Prestations", piece: "F-600", pieceDate: "20260110", lib: "Facture F-600", credit: "10000,00" }),
      row({ num: "2", date: "20260210", compte: "41170005", aux: "CNEG", piece: "F-600", lib: "Libération excessive", credit: "500,00" }),
      row({ num: "2", date: "20260210", compte: "41100005", aux: "CNEG", piece: "F-600", lib: "Libération excessive", debit: "500,00", let: "AA" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    expect(result.invoices.find((i) => i.number === "F-600")?.retainedCents).toBe(0);
    expect(result.warnings.some((w) => w.includes("solde négatif"))).toBe(true);
  });

  it("BLOQUANT : retenue comptabilisée DIRECTEMENT à la facture — le marché vaut toujours 10 000 €", () => {
    // Seconde convention, tout aussi courante : la facture débite 411 pour le
    // net (9 500 €) ET 4117 pour la retenue (500 €) dans la MÊME écriture,
    // face au 706. Il n'y a aucun transfert à carver.
    //
    // Prendre les seuls débits 411 amputerait le montant facturé de la
    // retenue — donc le CA (2.11/3.1) et le dénominateur de la marge (2.8) —
    // et, pire, l'aval déduirait la retenue une SECONDE fois : 9 500 − 500 =
    // 9 000 réclamés sur 9 500 réellement dus. Une créance réelle
    // disparaîtrait en silence, ce que ce ticket s'interdit précisément.
    const rows = [
      row({ num: "1", date: "20260110", compte: "41100007", aux: "CDIR", piece: "F-700", pieceDate: "20260110", lib: "Facture F-700", debit: "9500,00" }),
      row({ num: "1", date: "20260110", compte: "41170007", aux: "CDIR", piece: "F-700", pieceDate: "20260110", lib: "Retenue de garantie 5%", debit: "500,00" }),
      row({ num: "1", date: "20260110", compte: "706000", compteLib: "Prestations", piece: "F-700", pieceDate: "20260110", lib: "Facture F-700", credit: "10000,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    const invoice = result.invoices.find((i) => i.number === "F-700");
    expect(invoice?.amountCents).toBe(1_000_000);
    expect(invoice?.retainedCents).toBe(50_000);
    // Exigible : le net facturé, ni plus ni moins.
    expect(invoice?.residualCents).toBe(950_000);
    expect(result.overdueCents).toBe(950_000);
    // Rien d'anormal ici : la pièce se lit sans ambiguïté, aucun avertissement
    // de rattachement ne doit être émis.
    expect(result.warnings.some((w) => w.includes("non rattachée"))).toBe(false);
  });

  it("4117 sans créance 411 dans la pièce : le fait est dit, la CAUSE n'est pas devinée", () => {
    // Deux situations sont ici INDISCERNABLES : un plan « 411 + code client »
    // (le client 70003 porte le compte 41170003, il n'y a aucune retenue) ou
    // une vraie retenue orpheline. Trancher serait un diagnostic inventé —
    // et un avertissement faux, répété à chaque pièce, use la confiance aussi
    // sûrement qu'un chiffre faux.
    const rows = [
      row({ num: "1", date: "20260105", compte: "41170003", aux: "C70003", piece: "F-300", pieceDate: "20260105", lib: "Facture F-300", debit: "3000,00" }),
      row({ num: "1", date: "20260105", compte: "706000", compteLib: "Prestations", piece: "F-300", pieceDate: "20260105", lib: "Facture F-300", credit: "3000,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    const warning = result.warnings.find((w) => w.includes("4117 au débit"));
    expect(warning).toBeDefined();
    // La conséquence est dite ; la cause reste ouverte.
    expect(warning).toContain("Rien n'est déduit des impayés");
    expect(warning).toContain("ou retenue non rattachable");
    // La conséquence RÉELLE est dite : le fait sans sa conséquence n'informe
    // pas. Cette ligne peut ressortir en retard et nourrir une relance.
    expect(warning).toContain("proposition de relance");
  });

  it("sans compte auxiliaire, la retenue n'est PAS reconnue — et la limite est DITE", () => {
    // Plan sans auxiliaire : la facture vit au 411000, la retenue au 411700.
    // Deux « clients » pour la clé de regroupement, une seule facture pour
    // l'artisan. Trois versions de rattachement ont tenté de recoller les
    // deux — chacune prise en défaut sur un montage réel, TOUJOURS dans le
    // même sens : une créance disparaissait ou changeait de client.
    //
    // Le coût des deux erreurs n'est pas symétrique. Ne pas reconnaître la
    // retenue la laisse dans les impayés : c'est le défaut d'origine, visible
    // et SIGNALÉ. La reconnaître à tort fait disparaître un dû réel — muet,
    // et faux dans les comptes. On s'abstient donc, et on le dit.
    const rows = [
      row({ num: "1", date: "20260110", compte: "411000", compteLib: "Clients", piece: "F-800", pieceDate: "20260110", lib: "Facture F-800", debit: "10000,00" }),
      row({ num: "1", date: "20260110", compte: "706000", compteLib: "Prestations", piece: "F-800", pieceDate: "20260110", lib: "Facture F-800", credit: "10000,00" }),
      row({ num: "2", date: "20260110", compte: "411700", compteLib: "Retenues de garantie", piece: "F-800", lib: "Retenue 5%", debit: "500,00" }),
      row({ num: "2", date: "20260110", compte: "411000", compteLib: "Clients", piece: "F-800", lib: "Retenue 5%", credit: "500,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    // Aucune retenue déduite : comportement 2.14, strictement inchangé.
    expect(result.retainedCents).toBe(0);
    // Et l'avertissement porte la conséquence, sans deviner la cause.
    const warning = result.warnings.find((w) => w.includes("4117 au débit"));
    expect(warning).toBeDefined();
    expect(warning).toContain("Rien n'est déduit des impayés");
    expect(warning).toContain("proposition de relance");
  });

  it("BLOQUANT : un lot de facturation en UNE écriture ne fait pas changer de client", () => {
    // Le montage le plus traître : une seule écriture, deux clients, plan
    // « 411 + code ». Le client n° 70003 porte le compte 41170003 et doit
    // 3 000 € ; la facture voisine vaut 1 000 €. Toute inférence qui rattache
    // la ligne 4117 à la facture voisine fusionne les deux : 4 000 € de CA
    // chez le mauvais client, 3 000 € de retenue inventée, et un dû réel qui
    // sort des impayés sans un mot.
    const rows = [
      row({ num: "1", date: "20260105", compte: "411000", compteLib: "Clients", piece: "LOT-9", pieceDate: "20260105", lib: "Facture client A", debit: "1000,00" }),
      row({ num: "1", date: "20260105", compte: "41170003", compteLib: "Client Martin", piece: "LOT-9", pieceDate: "20260105", lib: "Facture client B", debit: "3000,00" }),
      row({ num: "1", date: "20260105", compte: "706000", compteLib: "Prestations", piece: "LOT-9", pieceDate: "20260105", lib: "Lot de facturation", credit: "4000,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    // DEUX créances, chacune chez elle, aucune retenue fabriquée.
    expect(result.invoices).toHaveLength(2);
    expect(result.retainedCents).toBe(0);
    expect(result.overdueCents).toBe(400_000);
    expect(result.invoices.map((i) => i.customerRef).sort()).toEqual(["411000", "41170003"]);
  });

  it("BLOQUANT : la libération ne gonfle pas le montant facturé", () => {
    // Levée des réserves : le solde repasse du 4117 au 411 (débit 411 /
    // crédit 4117). Ce débit n'est PAS une vente — c'est un reclassement
    // d'une somme déjà facturée. L'additionner surévaluerait le CA (2.11/3.1)
    // et le dénominateur de la marge (2.8) de 5 %, dans la direction
    // flatteuse que 2.8 s'interdit précisément.
    const rows = [
      row({ num: "1", date: "20260110", compte: "41100008", aux: "CLIB", piece: "F-900", pieceDate: "20260110", lib: "Facture F-900", debit: "10000,00" }),
      row({ num: "1", date: "20260110", compte: "706000", compteLib: "Prestations", piece: "F-900", pieceDate: "20260110", lib: "Facture F-900", credit: "10000,00" }),
      row({ num: "2", date: "20260110", compte: "41170008", aux: "CLIB", piece: "F-900", lib: "Retenue 5%", debit: "500,00" }),
      row({ num: "2", date: "20260110", compte: "41100008", aux: "CLIB", piece: "F-900", lib: "Retenue 5%", credit: "500,00" }),
      // Un an plus tard : réserves levées, la retenue redevient exigible.
      row({ num: "3", date: "20270115", compte: "41100008", aux: "CLIB", piece: "F-900", lib: "Levée des réserves", debit: "500,00" }),
      row({ num: "3", date: "20270115", compte: "41170008", aux: "CLIB", piece: "F-900", lib: "Levée des réserves", credit: "500,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    const invoice = result.invoices.find((i) => i.number === "F-900");
    expect(invoice?.amountCents).toBe(1_000_000);
    // Plus rien de retenu, et les 500 € sont redevenus exigibles.
    expect(invoice?.retainedCents).toBe(0);
    expect(result.retainedCents).toBe(0);
    expect(invoice?.residualCents).toBe(1_000_000);
  });

  it("BLOQUANT : une libération encaissée sous SA pièce ne laisse pas une retenue fantôme", () => {
    // `débit 512 / crédit 4117` sous la pièce du règlement : rattachable à
    // aucune facture. Sommer les retenues PAR FACTURE annoncerait encore
    // « 500 € de retenue en cours » sur une somme déjà encaissée. Le total se
    // lit donc sur le SOLDE du compte 4117, qui n'a rien à rattacher.
    const rows = [
      row({ num: "1", date: "20260110", compte: "41100010", aux: "CENC", piece: "F-950", pieceDate: "20260110", lib: "Facture F-950", debit: "10000,00", let: "AA" }),
      row({ num: "1", date: "20260110", compte: "706000", compteLib: "Prestations", piece: "F-950", pieceDate: "20260110", lib: "Facture F-950", credit: "10000,00" }),
      row({ num: "2", date: "20260110", compte: "41170010", aux: "CENC", piece: "F-950", lib: "Retenue 5%", debit: "500,00" }),
      row({ num: "2", date: "20260110", compte: "41100010", aux: "CENC", piece: "F-950", lib: "Retenue 5%", credit: "500,00", let: "AA" }),
      row({ journal: "BQ", num: "3", date: "20260214", compte: "512000", compteLib: "Banque", piece: "REG-950", lib: "Encaissement", debit: "9500,00" }),
      row({ journal: "BQ", num: "3", date: "20260214", compte: "41100010", aux: "CENC", piece: "F-950", lib: "Règlement", credit: "9500,00", let: "AA" }),
      // Levée des réserves encaissée, sous la pièce du règlement.
      row({ journal: "BQ", num: "4", date: "20270120", compte: "512000", compteLib: "Banque", piece: "REG-RG950", lib: "Encaissement retenue", debit: "500,00" }),
      row({ journal: "BQ", num: "4", date: "20270120", compte: "41170010", aux: "CENC", piece: "REG-RG950", lib: "Encaissement retenue", credit: "500,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    // Le compte de retenue est soldé : plus rien n'est en cours.
    expect(result.retainedCents).toBe(0);
    // Et la libération encaissée ne fabrique pas une créance de plus.
    expect(result.overdueCount).toBe(0);
    expect(result.invoices.find((i) => i.number === "REG-RG950")).toBeUndefined();
  });

  it("un crédit client qui n'est PAS un transfert ne fait pas perdre la retenue", () => {
    // Écriture de vente portant un escompte au crédit du client : le montant
    // du crédit ne correspond pas au débit 4117, ce n'est donc pas un
    // transfert. Le confondre amputerait le montant facturé de la retenue.
    const rows = [
      row({ num: "1", date: "20260110", compte: "41100011", aux: "CESC", piece: "F-960", pieceDate: "20260110", lib: "Facture F-960", debit: "9500,00" }),
      row({ num: "1", date: "20260110", compte: "41170011", aux: "CESC", piece: "F-960", pieceDate: "20260110", lib: "Retenue 5%", debit: "500,00" }),
      row({ num: "1", date: "20260110", compte: "41100011", aux: "CESC", piece: "F-960", pieceDate: "20260110", lib: "Escompte", credit: "100,00" }),
      row({ num: "1", date: "20260110", compte: "706000", compteLib: "Prestations", piece: "F-960", pieceDate: "20260110", lib: "Facture F-960", credit: "9900,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    const invoice = result.invoices.find((i) => i.number === "F-960");
    expect(invoice?.amountCents).toBe(1_000_000);
    expect(invoice?.retainedCents).toBe(50_000);
    expect(invoice?.residualCents).toBe(940_000);
  });

  it("BLOQUANT : un lot de facturation partagé ne fait pas changer de client à une créance", () => {
    // Pièce unique `LOT-1` pour deux clients, plan « 411 + code » : le client
    // n° 70003 porte le compte 41170003. Rattacher sa créance à la facture de
    // l'AUTRE client la sortirait des impayés, la ré-étiquetterait « retenue »
    // et l'attribuerait au mauvais nom — dans son CA (2.11) comme dans ses
    // signaux (3.4). Un vrai dû disparaît : pire que la relance abusive.
    //
    // Une facture a pour contrepartie une VENTE (7xx) ; un transfert de
    // retenue a pour contrepartie un crédit client du même montant. C'est ce
    // qui les sépare.
    const rows = [
      row({ num: "1", date: "20260105", compte: "411000123", aux: "CDEUX", piece: "LOT-1", pieceDate: "20260105", lib: "Facture client A", debit: "1000,00" }),
      row({ num: "1", date: "20260105", compte: "706000", compteLib: "Prestations", piece: "LOT-1", pieceDate: "20260105", lib: "Facture client A", credit: "1000,00" }),
      row({ num: "2", date: "20260105", compte: "41170003", aux: "C70003", piece: "LOT-1", pieceDate: "20260105", lib: "Facture client B", debit: "3000,00" }),
      row({ num: "2", date: "20260105", compte: "706000", compteLib: "Prestations", piece: "LOT-1", pieceDate: "20260105", lib: "Facture client B", credit: "3000,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    // DEUX créances, chacune chez son client, aucune retenue fabriquée.
    expect(result.invoices).toHaveLength(2);
    expect(result.overdueCount).toBe(2);
    expect(result.overdueCents).toBe(400_000);
    expect(result.retainedCents).toBe(0);
    expect(result.invoices.map((i) => i.customerRef).sort()).toEqual(["C70003", "CDEUX"]);
    // Et la ligne douteuse est signalée, pas avalée en silence.
    expect(result.warnings.some((w) => w.includes("4117 au débit"))).toBe(true);
  });

  it("BLOQUANT : une réaffectation sans auxiliaire ne devient pas une retenue", () => {
    // Sous la pièce d'origine, une OD débite le compte d'un AUTRE client et
    // crédite celui de la facture — la forme exacte d'un transfert de
    // retenue, mais entre deux tiers. Sans auxiliaire, rien ne les distingue
    // structurellement : on ne rattache pas, donc la créance de Martin reste
    // chez Martin.
    const rows = [
      row({ num: "1", date: "20260105", compte: "411000", compteLib: "Clients", piece: "LOT-8", pieceDate: "20260105", lib: "Facture client A", debit: "3000,00" }),
      row({ num: "1", date: "20260105", compte: "706000", compteLib: "Prestations", piece: "LOT-8", pieceDate: "20260105", lib: "Facture client A", credit: "3000,00" }),
      row({ num: "2", date: "20260105", compte: "41170004", compteLib: "Client Martin", piece: "LOT-8", lib: "Réaffectation", debit: "3000,00" }),
      row({ num: "2", date: "20260105", compte: "411000", compteLib: "Clients", piece: "LOT-8", lib: "Réaffectation", credit: "3000,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    const martin = result.invoices.find((i) => i.customerRef === "41170004");
    expect(martin?.residualCents).toBe(300_000);
    expect(result.retainedCents).toBe(0);
  });

  it("BLOQUANT : une réaffectation entre deux tiers ne devient pas une retenue", () => {
    // Sous la pièce d'origine, une OD débite le compte d'un AUTRE client et
    // crédite celui de la facture. Le crédit a beau avoir la forme d'un
    // transfert, il ne porte pas le même tiers : rattacher la ligne 4117 à la
    // facture ferait disparaître la créance du client B et gonflerait la
    // retenue du client A d'un montant qui n'a jamais été retenu.
    const rows = [
      row({ num: "1", date: "20260105", compte: "411000123", aux: "CA", piece: "LOT-2", pieceDate: "20260105", lib: "Facture client A", debit: "1000,00" }),
      row({ num: "1", date: "20260105", compte: "706000", compteLib: "Prestations", piece: "LOT-2", pieceDate: "20260105", lib: "Facture client A", credit: "1000,00" }),
      row({ num: "2", date: "20260105", compte: "41170003", aux: "CB", piece: "LOT-2", lib: "Réaffectation", debit: "1000,00" }),
      row({ num: "2", date: "20260105", compte: "411000123", aux: "CA", piece: "LOT-2", lib: "Réaffectation", credit: "1000,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    // La créance de CB existe toujours, chez CB, et reste réclamable.
    const cb = result.invoices.find((i) => i.customerRef === "CB");
    expect(cb?.residualCents).toBe(100_000);
    expect(result.retainedCents).toBe(0);
    expect(result.overdueCents).toBe(100_000);
  });

  it("le transfert sous sa propre pièce n'entre pas au chiffre d'affaires", () => {
    // La pièce `RG-510` ne porte qu'un mouvement interne (411 -> 4117). En
    // faire une « facture » de 500 € gonflerait le CA du montant même de la
    // retenue.
    const rows = [
      row({ num: "1", date: "20260110", compte: "41100015", aux: "CTRF", piece: "F-510", pieceDate: "20260110", lib: "Facture F-510", debit: "10000,00" }),
      row({ num: "1", date: "20260110", compte: "706000", compteLib: "Prestations", piece: "F-510", pieceDate: "20260110", lib: "Facture F-510", credit: "10000,00" }),
      row({ num: "2", date: "20260110", compte: "41170015", aux: "CTRF", piece: "RG-510", lib: "Retenue", debit: "500,00" }),
      row({ num: "2", date: "20260110", compte: "41100015", aux: "CTRF", piece: "RG-510", lib: "Retenue", credit: "500,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    expect(result.invoices.find((i) => i.number === "RG-510")).toBeUndefined();
    // La garde ne s'applique pas ici (transfert non rattachable) : la retenue
    // reste dans la créance, et c'est DIT.
    expect(result.warnings.some((w) => w.includes("non rattachée"))).toBe(true);
  });

  it("BLOQUANT : une retenue libérée mais non encaissée reste réclamable, à SA date", () => {
    // Levée des réserves sous sa propre pièce : la somme redevient exigible.
    // La reverser dans la facture d'origine paraissait plus propre — sauf
    // qu'une facture ne porte qu'UNE échéance : la somme héritait de celle de
    // la facture et ressortait « en retard de 146 jours » dès son
    // enregistrement. Relancer un bon client sur une somme exigible depuis
    // quatre jours, c'est la faute du ticket, un cran plus loin.
    //
    // La pièce de levée garde donc sa date, donc sa propre échéance.
    const rows = [
      row({ num: "1", date: "20260110", compte: "41100014", aux: "CLEV", piece: "F-3", pieceDate: "20260110", lib: "Facture F-3", debit: "10000,00", let: "AA" }),
      row({ num: "1", date: "20260110", compte: "706000", compteLib: "Prestations", piece: "F-3", pieceDate: "20260110", lib: "Facture F-3", credit: "10000,00" }),
      row({ num: "2", date: "20260110", compte: "41170014", aux: "CLEV", piece: "F-3", lib: "Retenue 5%", debit: "500,00" }),
      row({ num: "2", date: "20260110", compte: "41100014", aux: "CLEV", piece: "F-3", lib: "Retenue 5%", credit: "500,00", let: "AA" }),
      row({ journal: "BQ", num: "3", date: "20260214", compte: "512000", compteLib: "Banque", piece: "REG-3", lib: "Encaissement", debit: "9500,00" }),
      row({ journal: "BQ", num: "3", date: "20260214", compte: "41100014", aux: "CLEV", piece: "F-3", lib: "Règlement", credit: "9500,00", let: "AA" }),
      // Réserves levées le 1er juillet : les 500 € redeviennent dus.
      row({ num: "4", date: "20260701", compte: "41100014", aux: "CLEV", piece: "LEV-3", pieceDate: "20260701", lib: "Levée des réserves", debit: "500,00" }),
      row({ num: "4", date: "20260701", compte: "41170014", aux: "CLEV", piece: "LEV-3", lib: "Levée des réserves", credit: "500,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    // Plus rien de retenu : le compte 4117 est soldé.
    expect(result.retainedCents).toBe(0);
    const levee = result.invoices.find((i) => i.number === "LEV-3");
    // Ce n'est pas une vente (montant facturé nul, donc hors CA 2.11/3.1)…
    expect(levee?.amountCents).toBe(0);
    // …mais la somme est bien due, et réclamable.
    expect(levee?.residualCents).toBe(50_000);
    // Échéance calculée sur la date de LEVÉE, pas sur celle de la facture :
    // quatre jours après la levée, rien n'est en retard.
    expect(levee?.dueDate).toBe("2026-07-31");
    expect(result.overdueCount).toBe(0);
    // La facture d'origine, elle, reste soldée : rien n'y est rouvert.
    expect(result.invoices.find((i) => i.number === "F-3")?.settled).toBe(true);
  });

  it("une libération saisie SANS auxiliaire nette quand même la retenue", () => {
    // Cas courant : la retenue est saisie avec l'auxiliaire du client, mais
    // l'encaissement de la levée (`débit 512 / crédit 411700`) n'en porte
    // pas. Deux seaux différents, aucune compensation — et le solde
    // annoncerait « en cours » une somme déjà encaissée. Un compte de retenue
    // à UN seul tiers reconnu n'a pourtant aucune ambiguïté.
    const rows = [
      row({ num: "1", date: "20260110", compte: "41100016", aux: "CMIX", piece: "F-970", pieceDate: "20260110", lib: "Facture F-970", debit: "10000,00", let: "AA" }),
      row({ num: "1", date: "20260110", compte: "706000", compteLib: "Prestations", piece: "F-970", pieceDate: "20260110", lib: "Facture F-970", credit: "10000,00" }),
      row({ num: "2", date: "20260110", compte: "411700", compteLib: "Retenues de garantie", aux: "CMIX", piece: "F-970", lib: "Retenue 5%", debit: "500,00" }),
      row({ num: "2", date: "20260110", compte: "41100016", aux: "CMIX", piece: "F-970", lib: "Retenue 5%", credit: "500,00", let: "AA" }),
      row({ journal: "BQ", num: "3", date: "20260214", compte: "512000", compteLib: "Banque", piece: "REG-970", lib: "Encaissement", debit: "9500,00" }),
      row({ journal: "BQ", num: "3", date: "20260214", compte: "41100016", aux: "CMIX", piece: "F-970", lib: "Règlement", credit: "9500,00", let: "AA" }),
      // Encaissement de la retenue, saisi sans auxiliaire.
      row({ journal: "BQ", num: "4", date: "20270120", compte: "512000", compteLib: "Banque", piece: "REG-RG970", lib: "Encaissement retenue", debit: "500,00" }),
      row({ journal: "BQ", num: "4", date: "20270120", compte: "411700", compteLib: "Retenues de garantie", piece: "REG-RG970", lib: "Encaissement retenue", credit: "500,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    expect(result.retainedCents).toBe(0);
  });

  it("sans retenue, rien ne change (non-régression 2.14)", () => {
    const rows = [
      row({ num: "1", date: "20260105", compte: "41100002", aux: "CBETA", piece: "F-200", pieceDate: "20260105", lib: "Facture F-200", debit: "2500,00" }),
      row({ num: "1", date: "20260105", compte: "706000", compteLib: "Prestations", piece: "F-200", pieceDate: "20260105", lib: "Facture F-200", credit: "2500,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    const invoice = result.invoices.find((i) => i.number === "F-200");
    expect(invoice?.retainedCents).toBe(0);
    expect(invoice?.residualCents).toBe(250_000);
    expect(result.overdueCount).toBe(1);
    expect(result.retainedCents).toBe(0);
  });
});
