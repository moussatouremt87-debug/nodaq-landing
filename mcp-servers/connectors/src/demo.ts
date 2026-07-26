import { PennylaneClient } from "./pennylane.js";
import { QontoClient } from "./qonto.js";

/*
 * Mode démo (ticket seed démo) : quand le connecteur d'un tenant est en statut
 * "demo", le registre renvoie ces clients-fixtures au lieu des clients HTTP —
 * AUCUN appel réseau, AUCUN secret, et jamais un statut « connecté » simulé.
 * Les dates sont RELATIVES à l'instant de l'appel : les « 18 j de retard » du
 * kit de démo restent vrais dans trois mois.
 *
 * Les chiffres sont IMPOSÉS par le kit de démo (ne pas improviser) :
 * - 3 factures en retard totalisant 8 030 € ;
 * - projection de trésorerie : creux à exactement 8 900 € à J+30.
 */

const DAY_MS = 86_400_000;

/** Solde courant du compte démo : 14 660,00 €. */
export const DEMO_QONTO_BALANCE_CENTS = 1_466_000;
/** Flux net journalier moyen calibré : −192,00 €/j. */
export const DEMO_AVG_DAILY_NET_CENTS = -19_200;
/** Fenêtre d'observation (transaction la plus ancienne à J−360). */
export const DEMO_OBSERVED_DAYS = 360;
/** Le creux du kit : 14 660 − 192×30 = 8 900,00 € à J+30. */
export const DEMO_DIP_AT_30D_CENTS =
  DEMO_QONTO_BALANCE_CENTS + DEMO_AVG_DAILY_NET_CENTS * 30;

/** Les 3 factures en retard du kit (total 8 030,00 €). */
export const DEMO_LATE_INVOICES = [
  {
    id: "inv-2026-118",
    number: "2026-118",
    customer: "SCCV Les Terrasses du Parc",
    label: "Situation n°3, chantier Les Terrasses",
    amountCents: 420_000,
    daysLate: 18,
  },
  {
    id: "inv-2026-121",
    number: "2026-121",
    customer: "Syndic Lemaire & Associés",
    label: "Remise aux normes parties communes",
    amountCents: 265_000,
    daysLate: 9,
  },
  {
    id: "inv-2026-124",
    number: "2026-124",
    customer: "Entreprise Générale Bardin",
    label: "Lot électricité, solde",
    amountCents: 118_000,
    daysLate: 5,
  },
] as const;

export const DEMO_LATE_TOTAL_CENTS = DEMO_LATE_INVOICES.reduce(
  (sum, invoice) => sum + invoice.amountCents,
  0,
); // 803 000 = 8 030,00 €

function isoDaysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

function isoDaysAhead(now: Date, days: number): string {
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}

interface DemoTransaction {
  label: string;
  amountCents: number; // toujours positif, le sens est dans `side`
  side: "credit" | "debit";
  daysAgo: number;
}

/**
 * 12 mois de vie bancaire d'un artisan électricien (6 salariés) : salaires,
 * fournisseur de matériel, URSSAF/TVA, carburant, loyer du dépôt, assurance
 * décennale annuelle, encaissements par situations de travaux. Le montant de
 * la « situation B » mensuelle est ajusté pour que le flux net TOTAL vaille
 * exactement DEMO_AVG_DAILY_NET_CENTS × DEMO_OBSERVED_DAYS — c'est ce qui
 * garantit le creux à 8 900 € du kit.
 */
export function demoQontoTransactions(): DemoTransaction[] {
  const txs: DemoTransaction[] = [];
  for (let month = 0; month < 12; month++) {
    const base = month * 30;
    txs.push(
      { label: "Virement salaires (6)", amountCents: 1_428_000, side: "debit", daysAgo: base + 2 },
      { label: "URSSAF", amountCents: 412_000, side: "debit", daysAgo: base + 4 },
      { label: "Comptoir Élec Distribution", amountCents: 685_000, side: "debit", daysAgo: base + 6 },
      { label: "TotalEnergies — carburant véhicules", amountCents: 62_000, side: "debit", daysAgo: base + 9 },
      { label: "Loyer dépôt — SCI Les Aubépines", amountCents: 135_000, side: "debit", daysAgo: base + 12 },
      { label: "TVA — DGFIP", amountCents: 175_000, side: "debit", daysAgo: base + 15 },
      { label: "Situation travaux — chantier A", amountCents: 1_680_000, side: "credit", daysAgo: base + 20 },
      { label: "Situation travaux — chantier B", amountCents: 682_500, side: "credit", daysAgo: base + 26 },
    );
  }
  // Assurance décennale : une échéance annuelle.
  txs.push({ label: "Assurance décennale — AXA", amountCents: 364_000, side: "debit", daysAgo: 128 });
  // Ancre la fenêtre d'observation à J−359,5 : l'outil calcule `ceil` avec SON
  // propre new Date(), quelques ms après le client — la demi-journée de marge
  // garantit ceil(...) === DEMO_OBSERVED_DAYS quel que soit ce décalage.
  txs.push({ label: "Loyer dépôt — SCI Les Aubépines", amountCents: 135_000, side: "debit", daysAgo: DEMO_OBSERVED_DAYS - 0.5 });

  // Calibrage exact : la dernière « situation B » absorbe l'écart pour que le
  // net total soit exactement le flux imposé par le kit.
  const target = DEMO_AVG_DAILY_NET_CENTS * DEMO_OBSERVED_DAYS;
  const net = txs.reduce(
    (sum, t) => sum + (t.side === "credit" ? t.amountCents : -t.amountCents),
    0,
  );
  const anchor = txs.find((t) => t.label === "Situation travaux — chantier B");
  if (!anchor) throw new Error("demo fixture: missing calibration anchor");
  anchor.amountCents += target - net;
  if (anchor.amountCents <= 0) {
    throw new Error("demo fixture: calibration produced a non-positive credit");
  }
  return txs;
}

const DEMO_IBAN = "FR7616958000018235694228846";

/** Client Qonto de démonstration — données fictives, zéro réseau. */
export class DemoQontoClient extends QontoClient {
  constructor(private readonly clock: () => Date = () => new Date()) {
    super({ organizationSlug: "elec-provence-demo", secretKey: "demo" });
  }

  override async getOrganization() {
    return {
      organization: {
        slug: "elec-provence-demo",
        bank_accounts: [
          {
            slug: "compte-courant",
            iban: DEMO_IBAN,
            currency: "EUR",
            balance_cents: DEMO_QONTO_BALANCE_CENTS,
            authorized_balance_cents: DEMO_QONTO_BALANCE_CENTS,
          },
        ],
      },
    };
  }

  override async listTransactions({ page = 1, perPage = 25 } = {}) {
    const now = this.clock();
    const all = demoQontoTransactions()
      .sort((a, b) => a.daysAgo - b.daysAgo)
      .map((t, i) => ({
        transaction_id: `demo-tx-${i}`,
        id: `demo-tx-${i}`,
        amount_cents: t.amountCents,
        currency: "EUR",
        side: t.side,
        operation_type: "transfer",
        settled_at: isoDaysAgo(now, t.daysAgo),
        label: t.label,
      }));
    const start = (page - 1) * perPage;
    return {
      transactions: all.slice(start, start + perPage),
      meta: { current_page: page, total_pages: Math.max(1, Math.ceil(all.length / perPage)) },
    };
  }
}

/** Client Pennylane de démonstration — 7 factures clients dont 3 en retard. */
export class DemoPennylaneClient extends PennylaneClient {
  constructor(private readonly clock: () => Date = () => new Date()) {
    super({ apiKey: "demo" });
  }

  override async listCustomerInvoices(_options = {}) {
    const now = this.clock();
    const euros = (cents: number) => (cents / 100).toFixed(2);
    const late = DEMO_LATE_INVOICES.map((invoice) => ({
      id: invoice.id,
      invoice_number: invoice.number,
      amount: euros(invoice.amountCents),
      currency: "EUR",
      date: isoDaysAgo(now, invoice.daysLate + 30),
      deadline: isoDaysAgo(now, invoice.daysLate),
      status: "late",
    }));
    const others = [
      { id: "inv-2026-125", invoice_number: "2026-125", amount: "5400.00", currency: "EUR", date: isoDaysAgo(now, 6), deadline: isoDaysAhead(now, 24), status: "pending" },
      { id: "inv-2026-126", invoice_number: "2026-126", amount: "3250.00", currency: "EUR", date: isoDaysAgo(now, 2), deadline: isoDaysAhead(now, 38), status: "pending" },
      { id: "inv-2026-112", invoice_number: "2026-112", amount: "7900.00", currency: "EUR", date: isoDaysAgo(now, 75), deadline: isoDaysAgo(now, 45), status: "paid" },
      { id: "inv-2026-109", invoice_number: "2026-109", amount: "2140.00", currency: "EUR", date: isoDaysAgo(now, 96), deadline: isoDaysAgo(now, 66), status: "paid" },
    ];
    return { items: [...late, ...others], next_cursor: null };
  }

  override async listCustomers(_options = {}) {
    return {
      items: [
        { id: "cus-1", name: "SCCV Les Terrasses du Parc", emails: ["compta@terrasses-du-parc.example"] },
        { id: "cus-2", name: "Syndic Lemaire & Associés", emails: ["gestion@lemaire-associes.example"] },
        { id: "cus-3", name: "Entreprise Générale Bardin", emails: ["achats@eg-bardin.example"] },
        { id: "cus-4", name: "M. Bernard", emails: ["bernard@exemple-client.example"] },
      ],
      next_cursor: null,
    };
  }
}
