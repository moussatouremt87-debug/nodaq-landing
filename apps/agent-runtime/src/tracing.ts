/*
 * Run tracing (ticket 1.6 §6) — METADATA ONLY, by design: tenant, employee,
 * tool NAMES, iteration count, latency, outcome. Never a message, a tool
 * payload, an IBAN or an invoice content (same masking discipline as 1.2).
 * Exporter: Langfuse ingestion API when LANGFUSE_* env is set, no-op
 * otherwise (dev/test). Tracing must NEVER break or slow a run: errors are
 * swallowed, the HTTP call is bounded by a short timeout.
 */

export interface AgentRunTrace {
  tenantId: string;
  employee: string;
  conversationId: string;
  requestIds: string[];
  iterations: number;
  toolCalls: { name: string; ok: boolean }[];
  durationMs: number;
  outcome: "ok" | "error";
}

export interface AgentTracer {
  record(trace: AgentRunTrace): Promise<void>;
}

export const noopTracer: AgentTracer = {
  record: () => Promise.resolve(),
};

export interface LangfuseTracerOptions {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
}

/** Posts one trace event per run to the Langfuse ingestion API. */
export function createLangfuseTracer(options: LangfuseTracerOptions): AgentTracer {
  const authorization =
    "Basic " + Buffer.from(`${options.publicKey}:${options.secretKey}`).toString("base64");
  return {
    async record(trace) {
      try {
        const now = new Date().toISOString();
        const response = await fetch(`${options.baseUrl}/api/public/ingestion`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization },
          body: JSON.stringify({
            batch: [
              {
                id: crypto.randomUUID(),
                type: "trace-create",
                timestamp: now,
                body: {
                  id: crypto.randomUUID(),
                  timestamp: now,
                  name: `agent-${trace.employee}`,
                  // Metadata only — the transcript stays in the tenant's DB.
                  metadata: {
                    tenantId: trace.tenantId,
                    conversationId: trace.conversationId,
                    requestIds: trace.requestIds,
                    iterations: trace.iterations,
                    toolCalls: trace.toolCalls,
                    durationMs: trace.durationMs,
                    outcome: trace.outcome,
                  },
                  tags: [`tenant:${trace.tenantId}`, `employee:${trace.employee}`],
                },
              },
            ],
          }),
          signal: AbortSignal.timeout(5_000),
        });
        await response.body?.cancel();
      } catch {
        // Tracing is best-effort: never let observability break a run.
      }
    },
  };
}

/** Env-driven default: Langfuse when configured, silent no-op otherwise. */
export function createTracerFromEnv(): AgentTracer {
  const baseUrl = process.env.LANGFUSE_BASE_URL;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!baseUrl || !publicKey || !secretKey) return noopTracer;
  return createLangfuseTracer({ baseUrl, publicKey, secretKey });
}
