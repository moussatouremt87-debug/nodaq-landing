import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TenantId } from "@nodaq/shared";
import { getBankClient, getPennylaneClient, getSilaeClient } from "./registry.js";
import type { RegistryOptions } from "./registry.js";

/** Bornes de lecture Silae (RH/paie, 3.10) : évite qu'une page mal configurée
 * côté middleware partenaire renvoie une liste sans fin dans le contexte
 * modèle — dépassement SIGNALÉ (`truncated`), jamais tu. */
const SILAE_EMPLOYEES_BOUND = 500;
const SILAE_ABSENCES_BOUND = 2000;
const SILAE_PAGE_SIZE_MAX = 100;

/**
 * Consomme une source paginée (curseur) jusqu'à `bound` éléments : demande
 * toujours UN élément de plus que nécessaire pour distinguer « pile la
 * borne » de « la borne a coupé une liste plus longue ».
 */
async function fetchBounded<T>(
  fetchPage: (
    cursor: string | undefined,
    limit: number,
  ) => Promise<{ items: T[]; next_cursor?: string | null | undefined }>,
  bound: number,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const remaining = bound + 1 - items.length;
    if (remaining <= 0) break;
    const page = await fetchPage(cursor, Math.min(remaining, SILAE_PAGE_SIZE_MAX));
    items.push(...page.items);
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return { items: items.slice(0, bound), truncated: items.length > bound };
}

/*
 * MCP server exposing the SaaS connectors as READ-ONLY tools (blueprint §5.5).
 * One server instance is bound to ONE tenant at construction time: the tenant
 * NEVER comes from tool input (an agent must not be able to pick a tenant).
 * All tools are reads — no pending_action needed; future write tools
 * (create_invoice...) MUST declare requiresValidation: true and go through the
 * validation queue instead of executing.
 */

export interface ConnectorsServerContext extends RegistryOptions {
  tenantId: string;
}

function asJsonContent(payload: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/** Data minimization: a full IBAN never enters the model context. */
function maskIban(iban: string | null | undefined): string | null {
  if (!iban) return null;
  return `****${iban.slice(-4)}`;
}

export function createConnectorsMcpServer(context: ConnectorsServerContext): McpServer {
  const tenantId = TenantId.parse(context.tenantId);
  const server = new McpServer({ name: "nodaq-connectors", version: "0.1.0" });

  server.registerTool(
    "pennylane_get_invoices",
    {
      description:
        "Liste les factures clients Pennylane du tenant (lecture seule). " +
        "Retourne id, numéro, montant, devise, date, échéance, statut et la " +
        "référence client (id, nom — PII) quand elle est disponible.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Nombre max de factures"),
        cursor: z.string().optional().describe("Curseur de pagination"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit, cursor }) => {
      const client = await getPennylaneClient(tenantId, context);
      return asJsonContent(
        await client.listCustomerInvoices({
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        }),
      );
    },
  );

  server.registerTool(
    "pennylane_get_customers",
    {
      description: "Liste les clients Pennylane du tenant (lecture seule).",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Nombre max de clients"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const client = await getPennylaneClient(tenantId, context);
      return asJsonContent(await client.listCustomers(limit !== undefined ? { limit } : {}));
    },
  );

  server.registerTool(
    "qonto_get_organization",
    {
      description:
        "Comptes bancaires du tenant avec soldes (lecture seule) — " +
        "Qonto ou, à défaut, l'agrégateur Bridge (DSP2, toutes banques FR) ; " +
        "la donnée d'entrée de la prévision de trésorerie.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const client = await getBankClient(tenantId, context);
      const { organization } = await client.getOrganization();
      // Accounts are referenced by slug; the IBAN is masked before it can
      // reach the model context.
      return asJsonContent({
        organization: {
          slug: organization.slug,
          bank_accounts: organization.bank_accounts.map((account) => ({
            ...account,
            iban: maskIban(account.iban),
          })),
        },
      });
    },
  );

  server.registerTool(
    "qonto_get_bank_transactions",
    {
      description:
        "Transactions bancaires du tenant (lecture seule, paginées) — Qonto ou Bridge. " +
        "Compte désigné par son slug (voir qonto_get_organization) — jamais par IBAN.",
      inputSchema: {
        accountSlug: z
          .string()
          .optional()
          .describe("Slug du compte (défaut : premier compte de l'organisation)"),
        page: z.number().int().min(1).optional().describe("Page (défaut 1)"),
        perPage: z.number().int().min(1).max(100).optional().describe("Taille de page"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ accountSlug, page, perPage }) => {
      const client = await getBankClient(tenantId, context);
      // Routage par SLUG (toujours présent — l'IBAN manque souvent chez un
      // agrégateur : cartes, épargne). L'IBAN, quand il existe, est résolu
      // côté serveur pour Qonto : il transite en mémoire seulement, jamais
      // par l'interface de l'outil.
      const { organization } = await client.getOrganization();
      const account = accountSlug
        ? organization.bank_accounts.find((a) => a.slug === accountSlug)
        : organization.bank_accounts[0];
      if (!account) {
        throw new Error(`unknown bank account${accountSlug ? ` "${accountSlug}"` : ""}`);
      }
      return asJsonContent(
        await client.listTransactions({
          accountSlug: account.slug,
          ...(account.iban ? { iban: account.iban } : {}),
          ...(page !== undefined ? { page } : {}),
          ...(perPage !== undefined ? { perPage } : {}),
        }),
      );
    },
  );

  server.registerTool(
    "silae_get_employees",
    {
      description:
        "Liste les salariés Silae du tenant (RH/paie, lecture seule) : id, nom " +
        `(prénom + nom), heures hebdomadaires, actif. Bornée à ${SILAE_EMPLOYEES_BOUND} ` +
        "(dépassement signalé par `truncated`).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const client = await getSilaeClient(tenantId, context);
      const { items, truncated } = await fetchBounded(
        (cursor, limit) => client.listEmployees({ limit, ...(cursor ? { cursor } : {}) }),
        SILAE_EMPLOYEES_BOUND,
      );
      return asJsonContent({
        employees: items.map((employee) => ({
          id: employee.id,
          name: [employee.first_name, employee.last_name].filter(Boolean).join(" ") || null,
          weeklyHours: employee.weekly_hours ?? null,
          active: employee.active ?? null,
        })),
        truncated,
      });
    },
  );

  server.registerTool(
    "silae_get_absences",
    {
      description:
        "Liste les absences Silae du tenant (RH/paie, lecture seule), filtrable par " +
        `période : id, salarié, type, dates de début/fin. Bornée à ${SILAE_ABSENCES_BOUND} ` +
        "(dépassement signalé par `truncated`).",
      inputSchema: {
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "format attendu YYYY-MM-DD")
          .optional()
          .describe("Borne de début (YYYY-MM-DD)"),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "format attendu YYYY-MM-DD")
          .optional()
          .describe("Borne de fin (YYYY-MM-DD)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ from, to }) => {
      const client = await getSilaeClient(tenantId, context);
      const { items, truncated } = await fetchBounded(
        (cursor, limit) =>
          client.listAbsences({
            limit,
            ...(cursor ? { cursor } : {}),
            ...(from !== undefined ? { from } : {}),
            ...(to !== undefined ? { to } : {}),
          }),
        SILAE_ABSENCES_BOUND,
      );
      return asJsonContent({
        absences: items.map((absence) => ({
          id: absence.id,
          employeeId: absence.employee_id,
          type: absence.type ?? null,
          startDate: absence.start_date,
          endDate: absence.end_date,
        })),
        truncated,
      });
    },
  );

  return server;
}
