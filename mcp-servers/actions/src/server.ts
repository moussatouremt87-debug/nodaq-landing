import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { withTenant } from "@nodaq/db";
import { route } from "@nodaq/llm";
import { getBankClient, getPennylaneClient } from "@nodaq/mcp-connectors";
import type { RegistryOptions } from "@nodaq/mcp-connectors";
import { TenantId } from "@nodaq/shared";
import { scoreLatePayment } from "./dunning.js";
import { extractInvoiceFields } from "./invoiceExtraction.js";
import type { OcrClientOptions } from "./ocrClient.js";
import { extractInvoiceText } from "./ocrClient.js";
import { analyzeCustomerSignals } from "./customerSignals.js";
import { simulateMaterialPrices } from "./materialScenario.js";
import { analyzeHourlyPerformance } from "./hourlyPerformance.js";
import { buildMonthlySeries, fetchInvoiceWindow, forecastSales } from "./salesForecast.js";
import type { MonthlyRevenuePoint } from "./salesForecast.js";
import { buildStaffingPlan } from "./staffingPlan.js";
import { forecastTreasury } from "./treasury.js";
import type { TreasuryTransaction } from "./treasury.js";

/*
 * Business-action MCP server (blueprint §5.5). One instance = ONE tenant,
 * bound at construction — never from tool input.
 *
 * HUMAN-IN-THE-LOOP (CLAUDE.md rule #4): write tools declare
 * `requiresValidation: true` and create a `pending_action` for the 1-click
 * validation queue. They NEVER execute the action themselves — booking the
 * invoice happens only after a human approves, and that approval is recorded
 * (validatedBy) for legal attribution.
 */

export interface ActionsServerContext extends OcrClientOptions, RegistryOptions {
  tenantId: string;
  /** User or agent-run that prepares the actions (traceability — RGPD audit 1.4). */
  requestedBy?: string;
  /** Virtual employee preparing the actions (e.g. 'compta') — audit attribution. */
  employee?: string;
  /**
   * Fire-and-forget doorbell rung each time a tool PREPARES a pending_action
   * (push notifications 2.17). Carries NO data by design — the recipient
   * learns "something awaits validation", nothing else.
   */
  onPendingAction?: () => void;
}

/** requiresValidation is the repo-wide convention marker for write tools. */
type NodaqToolAnnotations = ToolAnnotations & { requiresValidation: boolean };

/**
 * Tool policy registry — the AUTHORITATIVE declaration consumed by the agent
 * runtime to route write tools through the validation queue. (The MCP client
 * strips unknown annotation keys in transit, so the wire annotations alone
 * cannot carry this contract.)
 */
export const TOOL_POLICIES = {
  ocr_and_book_invoice: { requiresValidation: true },
  draft_dunning: { requiresValidation: true },
  compute_treasury_forecast: { requiresValidation: false },
  forecast_sales: { requiresValidation: false },
  analyze_customer_signals: { requiresValidation: false },
  plan_staffing: { requiresValidation: false },
  analyze_hourly_performance: { requiresValidation: false },
  check_stock_alerts: { requiresValidation: false },
  adjust_stock: { requiresValidation: true },
  simulate_material_prices: { requiresValidation: false },
} as const satisfies Record<string, { requiresValidation: boolean }>;

const DUNNING_PROMPT =
  "Rédige un e-mail de relance courtois mais ferme pour une facture impayée d'une PME " +
  "française. Ton professionnel, rappel des références et du montant, demande de " +
  "règlement sous 7 jours, mention des pénalités légales de retard (art. L441-10). " +
  "Réponds UNIQUEMENT avec le texte de l'e-mail (pas de commentaire).\n\nFaits :\n";

export function createActionsMcpServer(context: ActionsServerContext): McpServer {
  const tenantId = TenantId.parse(context.tenantId);
  const server = new McpServer({ name: "nodaq-actions", version: "0.1.0" });

  const annotations: NodaqToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    requiresValidation: true,
  };

  server.registerTool(
    "ocr_and_book_invoice",
    {
      description:
        "Extrait les champs d'une facture fournisseur (OCR + extraction souveraine) et " +
        "PRÉPARE son enregistrement comptable dans la file de validation. N'exécute " +
        "JAMAIS l'écriture : un humain valide en 1 clic (requiresValidation).",
      inputSchema: {
        filename: z.string().min(1).max(300).describe("Nom du fichier de la facture"),
        contentBase64: z.string().max(14_000_000).describe("Contenu du fichier en base64"),
      },
      annotations,
    },
    async ({ filename, contentBase64 }) => {
      // 1) Raw text extraction by the internal OCR service (no model there).
      const extracted = await extractInvoiceText(tenantId, filename, contentBase64, context);

      // 2) Structured fields through route() — confidentiel, sovereign tier,
      //    audited (classification row with content hash).
      const requestId = `ocr-invoice-${randomUUID()}`;
      const invoice = await extractInvoiceFields(tenantId, requestId, extracted.text);

      // 3) PREPARE, never execute: one pending_action in the validation queue.
      const pendingAction = await withTenant(tenantId, (tx) =>
        tx.pendingAction.create({
          data: {
            tenantId,
            type: "book_invoice",
            requestedBy: context.requestedBy ?? null,
            employee: context.employee ?? null,
            payload: {
              invoice,
              source: { filename, pages: extracted.pages },
              extraction: { requestId },
            },
          },
        }),
      );

      context.onPendingAction?.();

      // Minimization: the extracted fields are `confidentiel` — they stay in
      // the pending_action payload (validation queue), NOT in the calling
      // model's context.
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              pendingActionId: pendingAction.id,
              status: "pending_validation",
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "compute_treasury_forecast",
    {
      description:
        "Prévision de trésorerie 30/60/90 jours (lecture seule) : solde Qonto actuel " +
        "projeté avec le flux net journalier moyen observé sur les transactions.",
      inputSchema: {
        accountSlug: z
          .string()
          .optional()
          .describe("Slug du compte Qonto (défaut : premier compte)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ accountSlug }) => {
      // Banque agnostique (2.15) : Qonto direct, sinon agrégateur Bridge.
      const qonto = await getBankClient(tenantId, context);
      const { organization } = await qonto.getOrganization();
      const account = accountSlug
        ? organization.bank_accounts.find((a) => a.slug === accountSlug)
        : organization.bank_accounts[0];
      // Routage par slug (toujours présent) — l'IBAN manque souvent chez un
      // agrégateur ; solde ET flux portent ainsi sur le MÊME compte.
      if (!account) {
        throw new Error(`unknown bank account${accountSlug ? ` "${accountSlug}"` : ""}`);
      }
      const { transactions } = await qonto.listTransactions({
        accountSlug: account.slug,
        ...(account.iban ? { iban: account.iban } : {}),
        perPage: 100,
      });
      if (account.balance_cents == null) {
        // A missing balance must not silently become a zero-balance forecast.
        throw new Error(`bank account "${account.slug}" has no balance available`);
      }
      const usable: TreasuryTransaction[] = transactions.flatMap((t) =>
        t.amount_cents != null && t.settled_at && (t.side === "credit" || t.side === "debit")
          ? [{ amountCents: t.amount_cents, side: t.side, settledAt: t.settled_at }]
          : [],
      );
      const forecast = forecastTreasury(account.balance_cents, usable, new Date());
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ account: account.slug, ...forecast }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "forecast_sales",
    {
      description:
        "Prévision des ventes (lecture seule, ticket 3.1) : chiffre d'affaires mensuel " +
        "observé sur les factures clients (12 derniers mois) projeté sur 3 mois par " +
        "régression linéaire explicable. Fonctionne avec Pennylane, la démo ou un " +
        "import FEC.",
      inputSchema: {
        horizonMonths: z
          .number()
          .int()
          .min(1)
          .max(6)
          .optional()
          .describe("Horizon de prévision en mois (défaut 3)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ horizonMonths }) => {
      const pennylane = await getPennylaneClient(tenantId, context);
      // Fenêtre bornée par DATE et par pages, avec signal de troncature : un
      // historique tronqué ne doit jamais se lire comme « mois sans ventes ».
      const { invoices, truncated } = await fetchInvoiceWindow(pennylane, new Date());
      const series = buildMonthlySeries(invoices, new Date());
      const forecast = forecastSales(series, horizonMonths ?? 3);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ...forecast, truncated }) }],
      };
    },
  );

  server.registerTool(
    "analyze_customer_signals",
    {
      description:
        "Signaux clients (lecture seule, ticket 3.4) : analyse cadence, récence et " +
        "tendance des montants par client sur 24 mois de factures — segments « à " +
        "risque » (régulier devenu silencieux), « en croissance » (opportunité " +
        "upsell), « fidèle », « nouveau », « ponctuel », chacun justifié par ses " +
        "chiffres. Fonctionne avec Pennylane, la démo ou un import FEC.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const pennylane = await getPennylaneClient(tenantId, context);
      // 24 mois : il faut voir la régularité PASSÉE pour détecter le silence.
      // Fenêtre bornée + signal de troncature (jamais une analyse partielle
      // présentée comme complète).
      const { invoices, truncated } = await fetchInvoiceWindow(pennylane, new Date(), {
        monthsBack: 24,
      });
      const { customers, analyzedInvoices, unattributedInvoices } = analyzeCustomerSignals(
        invoices,
        new Date(),
      );
      // Liste bornée pour le contexte du modèle ; le compte total reste
      // exact et le bornage est SIGNALÉ (jamais une vue partielle présentée
      // comme exhaustive).
      const MAX_CUSTOMERS = 100;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              customers: customers.slice(0, MAX_CUSTOMERS),
              totalCustomers: customers.length,
              customersTruncated: customers.length > MAX_CUSTOMERS,
              analyzedInvoices,
              unattributedInvoices,
              truncated,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "plan_staffing",
    {
      description:
        "Plannings RH (lecture seule, ticket 3.5) : capacité mensuelle de l'équipe " +
        "(heures contractuelles moins absences) vs charge ESTIMÉE depuis la prévision " +
        "de ventes, avec un taux horaire facturé moyen configurable. Verdicts " +
        "sous/sur-capacité chiffrés, TOUJOURS labellisés estimation.",
      inputSchema: {
        hourlyRateEur: z
          .number()
          .min(10)
          .max(500)
          .optional()
          .describe("Taux horaire facturé moyen en euros (défaut 60)"),
        horizonMonths: z.number().int().min(1).max(6).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ hourlyRateEur, horizonMonths }) => {
      // Bornes de lecture (audit 3.5) : jamais une boucle non plafonnée —
      // le dépassement est SIGNALÉ, pas silencieux. Le nom (PII) n'est pas
      // sélectionné : il n'entre jamais dans le processus de l'outil.
      const staff = await withTenant(tenantId, (tx) =>
        tx.staffMember.findMany({
          select: { id: true, weeklyHours: true, active: true },
          take: 501,
        }),
      );
      const absences = await withTenant(tenantId, (tx) =>
        tx.staffAbsence.findMany({
          select: { staffId: true, startDate: true, endDate: true },
          take: 5001,
        }),
      );
      const inputTruncated = staff.length > 500 || absences.length > 5000;
      // Prévision de ventes (3.1) : absente (pas de connecteur) = verdicts
      // « inconnu » — jamais une charge fabriquée.
      let points: { month: string; revenueCents: number }[] = [];
      let truncated = false;
      let forecastUnavailable = false;
      try {
        const pennylane = await getPennylaneClient(tenantId, context);
        const window = await fetchInvoiceWindow(pennylane, new Date());
        truncated = window.truncated;
        const forecast = forecastSales(
          buildMonthlySeries(window.invoices, new Date()),
          horizonMonths ?? 3,
        );
        points = forecast.points;
      } catch {
        // Pas de facturier configuré OU fournisseur en erreur : capacité
        // seule, et le drapeau le DIT (jamais un motif indistinct).
        forecastUnavailable = true;
      }
      const plan = buildStaffingPlan(
        staff.slice(0, 500),
        absences.slice(0, 5000).map((absence) => ({
          staffId: absence.staffId,
          startDate: absence.startDate.toISOString().slice(0, 10),
          endDate: absence.endDate.toISOString().slice(0, 10),
        })),
        points,
        new Date(),
        {
          ...(horizonMonths !== undefined ? { horizonMonths } : {}),
          ...(hourlyRateEur !== undefined
            ? { hourlyRateCents: Math.round(hourlyRateEur * 100) }
            : {}),
        },
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ...plan,
              truncated: truncated || inputTruncated,
              forecastUnavailable,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "analyze_hourly_performance",
    {
      description:
        "Performance horaire réalisée (lecture seule, ticket 3.6) : CA mensuel observé " +
        "sur les factures ÷ heures travaillées ESTIMÉES depuis les contrats de l'équipe " +
        "(absences déduites), comparé à un objectif de taux horaire configurable. " +
        "Verdicts chiffrés, TOUJOURS labellisés estimation (pas de pointage en V1).",
      inputSchema: {
        targetRateEur: z
          .number()
          .min(10)
          .max(500)
          .optional()
          .describe("Objectif de taux horaire facturé en euros (défaut 60)"),
        monthsBack: z
          .number()
          .int()
          .min(3)
          .max(12)
          .optional()
          .describe("Fenêtre d'observation en mois révolus (défaut 6)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ targetRateEur, monthsBack }) => {
      // Mêmes bornes de lecture que plan_staffing (audit 3.5) : dépassement
      // SIGNALÉ, jamais silencieux ; le nom (PII) n'est pas sélectionné ;
      // orderBy = sous-ensemble DÉTERMINISTE quand la borne coupe.
      const staff = await withTenant(tenantId, (tx) =>
        tx.staffMember.findMany({
          select: { id: true, weeklyHours: true, active: true },
          orderBy: { id: "asc" },
          take: 501,
        }),
      );
      const absences = await withTenant(tenantId, (tx) =>
        tx.staffAbsence.findMany({
          select: { staffId: true, startDate: true, endDate: true },
          orderBy: { id: "asc" },
          take: 5001,
        }),
      );
      // Deux causes de troncature aux effets OPPOSÉS sur le €/h : elles sont
      // exposées séparément (audit 3.6), `truncated` reste l'OR de synthèse.
      const staffTruncated = staff.length > 500 || absences.length > 5000;
      const windowMonths = monthsBack ?? 6;
      // CA observé (3.1) : facturier absent ou en erreur = AUCUN mois calculé
      // et le drapeau le DIT — jamais un taux fabriqué sur un CA inconnu. Le
      // try ne couvre QUE l'appel réseau : un bug du modèle pur doit remonter
      // en erreur d'outil, pas se déguiser en « CA indisponible ».
      let window: Awaited<ReturnType<typeof fetchInvoiceWindow>> | null = null;
      let revenueUnavailable = false;
      try {
        const pennylane = await getPennylaneClient(tenantId, context);
        window = await fetchInvoiceWindow(pennylane, new Date(), {
          monthsBack: windowMonths,
        });
      } catch {
        revenueUnavailable = true;
      }
      const revenueTruncated = window?.truncated ?? false;
      const series: MonthlyRevenuePoint[] = window
        ? buildMonthlySeries(window.invoices, new Date(), windowMonths)
        : [];
      const report = analyzeHourlyPerformance(
        staff.slice(0, 500),
        absences.slice(0, 5000).map((absence) => ({
          staffId: absence.staffId,
          startDate: absence.startDate.toISOString().slice(0, 10),
          endDate: absence.endDate.toISOString().slice(0, 10),
        })),
        series,
        {
          ...(targetRateEur !== undefined
            ? { targetRateCents: Math.round(targetRateEur * 100) }
            : {}),
          ...(revenueTruncated ? { revenueTruncated: true } : {}),
        },
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ...report,
              staffTruncated,
              revenueTruncated,
              truncated: staffTruncated || revenueTruncated,
              revenueUnavailable,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "check_stock_alerts",
    {
      description:
        "Suivi des stocks (lecture seule, ticket 3.2) : liste les articles dont la " +
        "quantité est au niveau ou sous leur seuil d'alerte. Accessible à tous les " +
        "rôles — le stock n'est pas une donnée financière.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      // Comparaison colonne à colonne côté SQL (RLS scelle au tenant) : le
      // compte n'est jamais tronqué, la liste est bornée pour le contexte.
      const [alerts, totals] = await withTenant(tenantId, async (tx) => {
        const alertRows = await tx.$queryRaw<
          { name: string; unit: string; quantity: number; alertThreshold: number }[]
        >`
          SELECT name, unit, quantity, alert_threshold AS "alertThreshold"
          FROM stock_items
          WHERE alert_threshold > 0 AND quantity <= alert_threshold
          ORDER BY name ASC LIMIT 200`;
        const totalItems = await tx.stockItem.count();
        const alertCount = await tx.$queryRaw<{ count: number }[]>`
          SELECT count(*)::int AS count FROM stock_items
          WHERE alert_threshold > 0 AND quantity <= alert_threshold`;
        return [alertRows, { totalItems, alertCount: alertCount[0]?.count ?? 0 }] as const;
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              alerts,
              alertCount: totals.alertCount,
              totalItems: totals.totalItems,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "simulate_material_prices",
    {
      description:
        "Simulation prix matières premières (lecture seule, ticket 3.3) : valorise le " +
        "stock aux coûts de remplacement courants puis sous un scénario de prix " +
        "(« cuivre +10 % », « tout +5 % »). Donnée financière agrégée — owner only.",
      inputSchema: {
        globalChangePct: z
          .number()
          .min(-90)
          .max(500)
          .optional()
          .describe("Variation en % appliquée à toutes les matières"),
        items: z
          .array(
            z.object({
              itemName: z.string().min(1).max(200).describe("Nom exact de l'article"),
              changePct: z.number().min(-90).max(500).describe("Variation en %"),
            }),
          )
          .max(50)
          .optional()
          .describe("Variations ciblées par article (prioritaires sur la globale)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ globalChangePct, items }) => {
      const stock = await withTenant(tenantId, (tx) =>
        tx.stockItem.findMany({
          orderBy: { name: "asc" },
          take: 1001,
          select: { name: true, unit: true, quantity: true, unitCostCents: true },
        }),
      );
      // Troncature SIGNALÉE, jamais silencieuse : un total financier partiel
      // doit se présenter comme tel (même règle que GET /stocks).
      const truncated = stock.length > 1000;
      const window = stock.slice(0, 1000);
      let result;
      try {
        result = simulateMaterialPrices(window, {
          ...(globalChangePct !== undefined ? { globalChangePct } : {}),
          ...(items !== undefined ? { items } : {}),
        });
      } catch {
        // Défensif : une ZodError interne ne remonte jamais dans le transcript.
        throw new Error("invalid scenario");
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ...result,
              truncated,
              // 0 = coût non renseigné : compté pour que le modèle le dise.
              itemsWithoutCost: window.filter((item) => item.unitCostCents === 0).length,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "adjust_stock",
    {
      description:
        "PRÉPARE un ajustement de stock (entrée ou sortie) dans la file de validation. " +
        "N'exécute JAMAIS le mouvement : un humain valide en 1 clic (requiresValidation).",
      inputSchema: {
        itemName: z.string().min(1).max(200).describe("Nom exact de l'article"),
        delta: z
          .number()
          .int()
          .min(-1_000_000)
          .max(1_000_000)
          .refine((value) => value !== 0, { message: "delta must not be zero" })
          .describe("Quantité : négatif = sortie, positif = entrée"),
        reason: z.string().max(200).optional().describe("Motif du mouvement"),
      },
      annotations,
    },
    async ({ itemName, delta, reason }) => {
      const item = await withTenant(tenantId, (tx) =>
        tx.stockItem.findUnique({
          where: { tenantId_name: { tenantId, name: itemName } },
          select: { id: true, name: true, unit: true, quantity: true },
        }),
      );
      if (!item) throw new Error("unknown stock item");

      // PREPARE, never execute: one pending_action in the validation queue.
      const pendingAction = await withTenant(tenantId, (tx) =>
        tx.pendingAction.create({
          data: {
            tenantId,
            type: "adjust_stock",
            requestedBy: context.requestedBy ?? null,
            employee: context.employee ?? null,
            payload: {
              itemId: item.id,
              itemName: item.name,
              unit: item.unit,
              quantityBefore: item.quantity,
              delta,
              reason: reason ?? null,
            },
          },
        }),
      );
      context.onPendingAction?.();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ pendingActionId: pendingAction.id, status: "pending_validation" }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "draft_dunning",
    {
      description:
        "Prépare une relance d'impayé : score de risque + brouillon d'e-mail (généré en " +
        "tier souverain) déposés dans la file de validation. N'ENVOIE JAMAIS la relance : " +
        "un humain valide en 1 clic (requiresValidation).",
      inputSchema: {
        invoiceId: z.string().min(1).max(100).describe("Id Pennylane de la facture impayée"),
      },
      annotations,
    },
    async ({ invoiceId }) => {
      const pennylane = await getPennylaneClient(tenantId, context);
      const { items } = await pennylane.listCustomerInvoices({ limit: 100 });
      const invoice = items.find((i) => i.id === invoiceId);
      if (!invoice) {
        throw new Error(`invoice "${invoiceId}" not found`);
      }

      // Financial data feeding a write action is validated, never defaulted:
      // a silent "0 EUR / 0 days overdue" pending action would mislead the
      // human validator (RGPD audit 1.5).
      const UNPAID_STATUSES = new Set(["late", "overdue", "unpaid", "pending"]);
      if (!invoice.status || !UNPAID_STATUSES.has(invoice.status)) {
        throw new Error(
          `invoice "${invoiceId}" is not eligible for dunning (status: ${invoice.status ?? "unknown"})`,
        );
      }
      const amountCents = Math.round(Number.parseFloat(String(invoice.amount)) * 100);
      if (!Number.isFinite(amountCents) || amountCents <= 0) {
        throw new Error(`invoice "${invoiceId}" has no readable amount`);
      }
      const dueDate = invoice.deadline;
      if (!dueDate) {
        throw new Error(`invoice "${invoiceId}" has no due date`);
      }
      const risk = scoreLatePayment(
        {
          invoiceNumber: invoice.invoice_number ?? null,
          amountCents,
          dueDate,
          status: invoice.status,
        },
        new Date(),
      );

      // Sovereign draft via route() — confidentiel, audited (hash only).
      const requestId = `dunning-${randomUUID()}`;
      const facts =
        `Facture ${invoice.invoice_number ?? invoice.id}, montant ${amountCents / 100} ` +
        `${invoice.currency ?? "EUR"}, échéance ${dueDate}, ` +
        `retard ${risk.daysOverdue} jours.`;
      const draft = await route({
        text: DUNNING_PROMPT + facts,
        category: "confidentiel",
        tenantId,
        requestId,
      });

      // PREPARE, never send: the draft lives in the validation queue only.
      const pendingAction = await withTenant(tenantId, (tx) =>
        tx.pendingAction.create({
          data: {
            tenantId,
            type: "send_dunning",
            requestedBy: context.requestedBy ?? null,
            employee: context.employee ?? null,
            payload: {
              invoice: {
                id: invoice.id,
                number: invoice.invoice_number ?? null,
                amountCents,
                currency: invoice.currency ?? "EUR",
                dueDate,
              },
              risk,
              draft: draft.text,
              extraction: { requestId },
            },
          },
        }),
      );
      context.onPendingAction?.();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              pendingActionId: pendingAction.id,
              status: "pending_validation",
              riskBand: risk.band,
            }),
          },
        ],
      };
    },
  );

  return server;
}
