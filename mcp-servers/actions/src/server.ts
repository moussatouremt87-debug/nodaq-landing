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
import { buildMonthlySeries, fetchInvoiceWindow, forecastSales } from "./salesForecast.js";
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
