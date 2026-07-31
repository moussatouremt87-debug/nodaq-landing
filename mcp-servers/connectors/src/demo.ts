import type { PdpClient, PdpDeposit } from "./pdp.js";
import { PennylaneClient } from "./pennylane.js";
import { QontoClient } from "./qonto.js";
import { SilaeClient } from "./silae.js";

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
    // Attribution client (3.4) : mêmes identités que listCustomers.
    const customersByName: Record<string, { id: string; name: string }> = {
      "SCCV Les Terrasses du Parc": { id: "cus-1", name: "SCCV Les Terrasses du Parc" },
      "Syndic Lemaire & Associés": { id: "cus-2", name: "Syndic Lemaire & Associés" },
      "Entreprise Générale Bardin": { id: "cus-3", name: "Entreprise Générale Bardin" },
      "M. Bernard": { id: "cus-4", name: "M. Bernard" },
    };
    const late = DEMO_LATE_INVOICES.map((invoice) => ({
      id: invoice.id,
      invoice_number: invoice.number,
      amount: euros(invoice.amountCents),
      currency: "EUR",
      date: isoDaysAgo(now, invoice.daysLate + 30),
      deadline: isoDaysAgo(now, invoice.daysLate),
      status: "late",
      customer: customersByName[invoice.customer] ?? null,
    }));
    const others = [
      { id: "inv-2026-125", invoice_number: "2026-125", amount: "5400.00", currency: "EUR", date: isoDaysAgo(now, 6), deadline: isoDaysAhead(now, 24), status: "pending", customer: customersByName["Entreprise Générale Bardin"] },
      { id: "inv-2026-126", invoice_number: "2026-126", amount: "3250.00", currency: "EUR", date: isoDaysAgo(now, 2), deadline: isoDaysAhead(now, 38), status: "pending", customer: customersByName["Syndic Lemaire & Associés"] },
      { id: "inv-2026-112", invoice_number: "2026-112", amount: "7900.00", currency: "EUR", date: isoDaysAgo(now, 75), deadline: isoDaysAgo(now, 45), status: "paid", customer: customersByName["SCCV Les Terrasses du Parc"] },
      { id: "inv-2026-109", invoice_number: "2026-109", amount: "2140.00", currency: "EUR", date: isoDaysAgo(now, 96), deadline: isoDaysAgo(now, 66), status: "paid", customer: customersByName["Syndic Lemaire & Associés"] },
    ];
    // Historique 12 mois pour la prévision des ventes (3.1) : électricien du
    // bâtiment — creux d'hiver, gros chantiers au printemps, légère croissance.
    const monthlyPaidCents = [
      812_000, 743_000, 918_000, 1_065_000, 1_231_000, 1_148_000, 1_309_000, 986_000, 1_074_000,
      1_282_000, 1_390_000, 1_243_000,
    ];
    const history = monthlyPaidCents.map((cents, index) => {
      const monthsAgo = monthlyPaidCents.length - index; // 12 -> 1 mois en arrière
      const issued = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 12));
      return {
        id: `inv-hist-${index + 1}`,
        invoice_number: `H-${String(index + 1).padStart(3, "0")}`,
        amount: euros(cents),
        currency: "EUR",
        date: issued.toISOString(),
        deadline: new Date(issued.getTime() + 30 * 86_400_000).toISOString(),
        status: "paid",
        // Alternance : SCCV (fidèle) / Syndic (montants croissants = upsell).
        customer:
          index % 2 === 0
            ? customersByName["SCCV Les Terrasses du Parc"]
            : customersByName["Syndic Lemaire & Associés"],
      };
    });
    // M. Bernard : 3 chantiers réguliers puis plus rien depuis 8 mois — le
    // cas « à risque » (churn) que l'employé doit repérer (3.4).
    const dormant = [14, 12, 10].map((monthsAgo, index) => {
      const issued = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 20));
      return {
        id: `inv-bernard-${index + 1}`,
        invoice_number: `B-${String(index + 1).padStart(3, "0")}`,
        amount: euros(84_000 + index * 6_000),
        currency: "EUR",
        date: issued.toISOString(),
        deadline: new Date(issued.getTime() + 30 * 86_400_000).toISOString(),
        status: "paid",
        customer: customersByName["M. Bernard"],
      };
    });
    return { items: [...late, ...others, ...history, ...dormant], next_cursor: null };
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

/**
 * Salariés démo (RH/paie, ticket 3.10) : 4 électriciens à 35 h/semaine,
 * cohérents avec « Élec Provence » (6 salariés dans les fixtures bancaires —
 * on n'en détaille ici que 4, l'effectif de paie n'a pas à matcher au
 * salarié près) et avec les conventions du planning RH (3.5 : capacité =
 * heures hebdo × 4,348).
 */
export const DEMO_SILAE_EMPLOYEES = [
  { id: "emp-1", first_name: "Karim", last_name: "Haddad", weekly_hours: 35, active: true },
  { id: "emp-2", first_name: "Julien", last_name: "Moreau", weekly_hours: 35, active: true },
  { id: "emp-3", first_name: "Sofiane", last_name: "Belkacem", weekly_hours: 35, active: true },
  { id: "emp-4", first_name: "Nordine", last_name: "Fassi", weekly_hours: 35, active: true },
] as const;

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Absences démo, calculées PAR RAPPORT au mois courant (jamais des dates en
 * dur — le kit reste plausible quel que soit le moment de la démo) :
 * - un arrêt maladie court, en milieu de mois courant ;
 * - des congés payés À CHEVAL sur le mois prochain (dernier jours du mois
 *   courant -> premiers jours du mois suivant), pour exercer un planning RH
 *   qui doit gérer une absence chevauchant deux mois.
 */
export interface DemoSilaeAbsence {
  id: string;
  employee_id: string;
  type: string;
  start_date: string;
  end_date: string;
}

export function demoSilaeAbsences(now: Date): DemoSilaeAbsence[] {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return [
    {
      id: "abs-1",
      employee_id: "emp-3",
      type: "maladie",
      start_date: ymd(new Date(Date.UTC(year, month, 10))),
      end_date: ymd(new Date(Date.UTC(year, month, 11))),
    },
    {
      id: "abs-2",
      employee_id: "emp-2",
      type: "conges_payes",
      // À cheval : les 2 derniers jours du mois courant + les 4 premiers du
      // mois suivant (Date.UTC normalise l'overflow de mois automatiquement).
      start_date: ymd(new Date(Date.UTC(year, month, lastDayOfMonth - 1))),
      end_date: ymd(new Date(Date.UTC(year, month + 1, 4))),
    },
  ];
}

/** Client Silae de démonstration (RH/paie, 3.10) — données fictives, zéro réseau, zéro secret. */
export class DemoSilaeClient extends SilaeClient {
  constructor(private readonly clock: () => Date = () => new Date()) {
    super({ apiKey: "demo-silae-key", dossierId: "demo-dossier" });
  }

  override async listEmployees({ limit = 25, cursor }: { limit?: number; cursor?: string } = {}) {
    const offset = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
    const page = DEMO_SILAE_EMPLOYEES.slice(offset, offset + limit);
    const hasMore = offset + limit < DEMO_SILAE_EMPLOYEES.length;
    return {
      items: page.map((employee) => ({ ...employee })),
      next_cursor: hasMore ? String(offset + limit) : null,
    };
  }

  override async listAbsences({
    from,
    to,
    limit = 25,
    cursor,
  }: { from?: string; to?: string; limit?: number; cursor?: string } = {}) {
    const all = demoSilaeAbsences(this.clock()).filter((absence) => {
      if (from && absence.end_date < from) return false;
      if (to && absence.start_date > to) return false;
      return true;
    });
    const offset = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
    const page = all.slice(offset, offset + limit);
    const hasMore = offset + limit < all.length;
    return {
      items: page,
      next_cursor: hasMore ? String(offset + limit) : null,
    };
  }
}


/*
 * Démo PDP (2.4) : le cycle de vie complet sans réseau — dépôt accepté,
 * statut qui progresse. Sert la démonstration et les tests ; jamais présenté
 * comme un dépôt réel (le connecteur est en statut `demo`).
 */
export class DemoPdpClient implements PdpClient {
  private counter = 0;

  deposit(input: {
    invoiceNumber: string;
    documentBase64: string;
    profile: string;
  }): Promise<PdpDeposit> {
    this.counter += 1;
    return Promise.resolve({
      reference: `demo-${input.invoiceNumber}-${this.counter}`,
      status: "deposee",
    });
  }

  getStatus(reference: string): Promise<{ status: string; updatedAt: string | null }> {
    return Promise.resolve({
      status: reference.includes("demo-") ? "recue" : "deposee",
      updatedAt: null,
    });
  }

  reportTransactions(input: {
    periodStart: string;
    periodEnd: string;
    totalCents: number;
    vatCents: number;
    transactionCount: number;
  }): Promise<PdpDeposit> {
    return Promise.resolve({ reference: `demo-ereporting-${input.periodStart}`, status: "deposee" });
  }

  testConnection(): Promise<void> {
    return Promise.resolve();
  }
}
