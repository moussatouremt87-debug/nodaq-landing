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
    expect(result.retentionCount).toBe(1);
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
    expect(warning).toContain("rien n'est déduit des impayés");
    expect(warning).toContain("ou retenue non rattachable");
  });

  it("BLOQUANT : sans compte auxiliaire, la retenue reste rattachée à SA facture", () => {
    // Plan sans auxiliaire : la facture vit au 411000, la retenue au 411700.
    // Notre clé de regroupement est (client, pièce) et le « client » vient du
    // compte à défaut d'auxiliaire : deux clients pour la clé, une seule
    // facture pour l'artisan. La retenue formait alors une facture FANTÔME de
    // 500 €, comptée en impayé — donc relançable. Le défaut du ticket, intact.
    const rows = [
      row({ num: "1", date: "20260110", compte: "411000", compteLib: "Clients", piece: "F-800", pieceDate: "20260110", lib: "Facture F-800", debit: "10000,00" }),
      row({ num: "1", date: "20260110", compte: "706000", compteLib: "Prestations", piece: "F-800", pieceDate: "20260110", lib: "Facture F-800", credit: "10000,00" }),
      row({ num: "2", date: "20260110", compte: "411700", compteLib: "Retenues de garantie", piece: "F-800", lib: "Retenue 5%", debit: "500,00" }),
      row({ num: "2", date: "20260110", compte: "411000", compteLib: "Clients", piece: "F-800", lib: "Retenue 5%", credit: "500,00" }),
    ];
    const result = deriveReceivables(entriesOf(rows), { today: TODAY });
    // UNE facture, pas deux : la retenue n'est pas une créance de plus.
    expect(result.invoices).toHaveLength(1);
    const invoice = result.invoices[0];
    expect(invoice?.number).toBe("F-800");
    expect(invoice?.amountCents).toBe(1_000_000);
    expect(invoice?.retainedCents).toBe(50_000);
    // Exigible : 9 500 €. Et surtout : la retenue n'est pas dans les impayés.
    expect(result.overdueCents).toBe(950_000);
    expect(result.overdueCount).toBe(1);
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
