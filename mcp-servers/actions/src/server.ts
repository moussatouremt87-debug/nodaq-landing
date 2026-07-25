import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { withTenant } from "@nodaq/db";
import { TenantId } from "@nodaq/shared";
import { extractInvoiceFields } from "./invoiceExtraction.js";
import type { OcrClientOptions } from "./ocrClient.js";
import { extractInvoiceText } from "./ocrClient.js";

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

export interface ActionsServerContext extends OcrClientOptions {
  tenantId: string;
  /** User or agent-run that prepares the actions (traceability — RGPD audit 1.4). */
  requestedBy?: string;
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
} as const satisfies Record<string, { requiresValidation: boolean }>;

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

  return server;
}
