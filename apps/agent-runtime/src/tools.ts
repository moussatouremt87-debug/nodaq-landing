import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { ToolDefinition } from "@nodaq/llm";
import { createActionsMcpServer, TOOL_POLICIES } from "@nodaq/mcp-actions";
import type { ActionsServerContext } from "@nodaq/mcp-actions";
import { createConnectorsMcpServer } from "@nodaq/mcp-connectors";
import { inactiveModuleTools, resolveModules, TenantId, VERTICALS } from "@nodaq/shared";
import type { Vertical } from "@nodaq/shared";
import { withTenant } from "@nodaq/db";

/*
 * Toolset of the Compta/Direction employee. THE provenance rule (1.2/1.3
 * follow-up, closed here): every tool is bound to ONE tenant at construction —
 * the MCP servers are instantiated for that tenant, and rag_search injects the
 * tenant server-side. No tool accepts a tenant in its input; any extra key an
 * agent invents is dropped by the MCP input schemas / ignored here.
 */

export interface ToolsetContext extends Omit<ActionsServerContext, "tenantId"> {
  tenantId: string;
  /** Membership role of the human behind the run (owner|member|accountant). */
  role?: string;
  ragBaseUrl?: string;
  ragToken?: string;
}

/*
 * Role gate on sensitive tools (RGPD audit 1.7): the tenant's aggregate
 * financial picture is reserved to the OWNER — a member or an accountant
 * (delegated third party) must not obtain it through the agent either.
 * Fail-closed: no role provided = not owner.
 */
// Le tableau financier du tenant est OWNER-ONLY de bout en bout (même
// raisonnement tiers-délégué que la trésorerie du cockpit) : les agrégats
// (prévisions) ET les listes brutes qui permettraient de les reconstituer
// (factures avec montants, soldes, transactions). Audit RGPD 3.1 : un gate
// sur l'agrégat seul serait contournable par l'outil de liste.
export const OWNER_ONLY_TOOLS = new Set([
  "compute_treasury_forecast",
  "forecast_sales",
  // CA par client + noms clients (PII) : même statut que les factures (3.4).
  "analyze_customer_signals",
  // CA du mois, encours échu et nom du meilleur client (PII) : même statut
  // que les factures dont le rapport est tiré (2.11).
  "build_monthly_report",
  // Noms des salariés (PII RH) + charge dérivée du CA : owner-only (3.5).
  "plan_staffing",
  // CA réalisé + heures RH : même statut que le plan de charge (3.6).
  "analyze_hourly_performance",
  // Profil stratégique (vertical, effectif RH) : owner-only (3.7).
  "check_regulatory_watch",
  // Registre des traitements = document de conformité stratégique (3.9).
  "check_rgpd_register",
  // Régime fiscal + montants d'impôts et de cotisations à payer (2.9).
  "check_tax_calendar",
  "pennylane_get_invoices",
  "qonto_get_organization",
  "qonto_get_bank_transactions",
  // SIRH Silae : noms de salariés (PII RH), même statut que plan_staffing (3.10).
  "silae_get_employees",
  "silae_get_absences",
  // Valorisation du stock = donnée financière agrégée (3.3).
  "simulate_material_prices",
]);

export interface Toolset {
  definitions: ToolDefinition[];
  /** Executes a tool call; returns the text result for the model. */
  execute(name: string, args: unknown): Promise<string>;
  close(): Promise<void>;
}

const RagSearchInput = z.object({
  query: z.string().min(1).max(10_000),
  dept: z.string().min(1).max(50).optional(),
  topK: z.number().int().min(1).max(20).optional(),
});

function ragConfig(context: ToolsetContext): { baseUrl: string; token: string } {
  const baseUrl = context.ragBaseUrl ?? process.env.RAG_SERVICE_URL ?? "http://localhost:8100";
  const token = context.ragToken ?? process.env.RAG_INTERNAL_TOKEN;
  if (!token) throw new Error("RAG_INTERNAL_TOKEN must be set (internal service token)");
  return { baseUrl, token };
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

async function connectInMemory(server: McpServer): Promise<Client> {
  const client = new Client({ name: "agent-runtime", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/**
 * Tools carried by modules the tenant deactivated (3.11): resolved from the
 * versioned catalog (vertical default + owner overrides in tenant_profiles).
 * Fail-open: no profile row = pure vertical defaults for "autre" (everything
 * on) — a missing profile must never amputate the agent.
 */
async function moduleFilteredTools(tenantId: string): Promise<Set<string>> {
  const profile = await withTenant(tenantId, (tx) =>
    tx.tenantProfile.findFirst({
      select: { vertical: true, moduleOverrides: true },
    }),
  );
  const vertical: Vertical = (VERTICALS as readonly string[]).includes(profile?.vertical ?? "")
    ? (profile?.vertical as Vertical)
    : "autre";
  const overrides =
    profile?.moduleOverrides !== null &&
    typeof profile?.moduleOverrides === "object" &&
    !Array.isArray(profile?.moduleOverrides)
      ? (profile?.moduleOverrides as Record<string, unknown>)
      : {};
  return inactiveModuleTools(resolveModules(vertical, overrides));
}

export async function buildToolset(context: ToolsetContext): Promise<Toolset> {
  const tenantId = TenantId.parse(context.tenantId);
  const serverContext = { ...context, tenantId };

  const connectorsClient = await connectInMemory(createConnectorsMcpServer(serverContext));
  const actionsClient = await connectInMemory(createActionsMcpServer(serverContext));

  const isOwner = context.role === "owner";
  const disabledTools = await moduleFilteredTools(tenantId);
  const routing = new Map<string, Client>();
  const definitions: ToolDefinition[] = [];
  for (const [client, source] of [
    [connectorsClient, "connectors"],
    [actionsClient, "actions"],
  ] as const) {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      if (OWNER_ONLY_TOOLS.has(tool.name) && !isOwner) continue;
      // Module désactivé (3.11) : l'outil sort du toolset — même mécanique
      // fail-closed que le gate owner (absent du routage => unknown tool).
      if (disabledTools.has(tool.name)) continue;
      routing.set(tool.name, client);
      definitions.push({
        name: tool.name,
        description: `${tool.description ?? ""} [source:${source}]`,
        parameters: tool.inputSchema as Record<string, unknown>,
      });
    }
  }

  definitions.push({
    name: "rag_search",
    description:
      "Recherche sémantique dans les documents internes du tenant (procédures, notes, " +
      "contrats indexés). Retourne les extraits les plus pertinents avec score.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Question ou mots-clés" },
        dept: { type: "string", description: "Filtre département (ex. compta)" },
        topK: { type: "number", description: "Nombre d'extraits (défaut 5)" },
      },
      required: ["query"],
    },
  });

  async function ragSearch(args: unknown): Promise<string> {
    const input = RagSearchInput.parse(args);
    const { baseUrl, token } = ragConfig(context);
    const response = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        // Tenant injected HERE, from the bound context — never from the agent.
        tenantId,
        query: input.query,
        ...(input.dept ? { dept: input.dept } : {}),
        ...(input.topK ? { topK: input.topK } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`rag_search failed: HTTP ${response.status}`);
    }
    return JSON.stringify(await response.json());
  }

  return {
    definitions,
    async execute(name, args) {
      if (name === "rag_search") return ragSearch(args);
      const client = routing.get(name);
      if (!client) throw new Error(`unknown tool: ${name}`);
      const result = await client.callTool({
        name,
        arguments: (args ?? {}) as Record<string, unknown>,
      });
      const content = (result.content as { type: string; text?: string }[] | undefined) ?? [];
      const text = content
        .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
        .filter(Boolean)
        .join("\n");
      if (result.isError) {
        // Status-style message for the model; the tool already sanitized it.
        throw new Error(text || `tool ${name} failed`);
      }
      // Runtime-side HITL guard (rule #4): a write tool declared
      // requiresValidation MUST have gone through the validation queue — its
      // result carries the pendingActionId. A future tool that executed
      // directly (no pending action) is refused here, as a last rampart.
      const policy = (TOOL_POLICIES as Record<string, { requiresValidation: boolean }>)[name];
      if (policy?.requiresValidation && !text.includes("pendingActionId")) {
        throw new Error(`tool ${name} requires validation but returned no pendingActionId`);
      }
      return text;
    },
    async close() {
      await connectorsClient.close();
      await actionsClient.close();
    },
  };
}
