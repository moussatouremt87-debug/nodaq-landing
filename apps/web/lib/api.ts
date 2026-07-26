import { z } from "zod";

/*
 * Typed client for the NODAQ API, through the same-origin /backend proxy
 * (next.config.ts). Every response crosses a Zod boundary before reaching a
 * component (CLAUDE.md: typed frontiers). The tenant is NEVER a parameter
 * here — it is the session's active organization, resolved server-side.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function call<T>(schema: z.ZodType<T>, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/backend${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
        message = body.error;
      }
    } catch {
      /* keep the status message */
    }
    throw new ApiError(response.status, message);
  }
  return schema.parse(await response.json());
}

export const Me = z.object({
  userId: z.string(),
  activeOrganizationId: z.string().nullable(),
  memberships: z.array(
    z.object({
      tenantId: z.string(),
      role: z.string(),
      tenant: z.object({ name: z.string(), slug: z.string().nullable() }),
    }),
  ),
});
export type Me = z.infer<typeof Me>;

export const PendingActionSummary = z.object({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  requestedBy: z.string().nullable(),
  validatedBy: z.string().nullable(),
  validatedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type PendingActionSummary = z.infer<typeof PendingActionSummary>;

export const CockpitKpis = z.object({
  pendingActions: z.record(z.number()),
  conversations: z.number(),
  treasury: z
    .object({
      account: z.string(),
      currentBalanceCents: z.number(),
      avgDailyNetFlowCents: z.number(),
      observedDays: z.number(),
      points: z.array(z.object({ horizonDays: z.number(), projectedBalanceCents: z.number() })),
    })
    .nullable(),
});
export type CockpitKpis = z.infer<typeof CockpitKpis>;

export const getMe = (): Promise<Me> => call(Me, "/me");

export const getKpis = (): Promise<CockpitKpis> => call(CockpitKpis, "/cockpit/kpis");

export const listPendingActions = (): Promise<PendingActionSummary[]> =>
  call(z.array(PendingActionSummary), "/pending-actions");

// Approval executes (ticket 1.6): the response carries the outcome fields.
export const PendingActionDecision = z.object({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  validatedBy: z.string().nullable(),
  validatedAt: z.string().nullable(),
  executedAt: z.string().nullable().optional(),
  result: z.unknown().optional(),
});
export type PendingActionDecision = z.infer<typeof PendingActionDecision>;

export const decidePendingAction = (
  id: string,
  decision: "approve" | "reject",
): Promise<PendingActionDecision> =>
  // Corps JSON vide EXPLICITE : `call` pose content-type application/json, et
  // Fastify refuse (400) un body absent avec ce content-type.
  call(PendingActionDecision, `/pending-actions/${id}/${decision}`, {
    method: "POST",
    body: "{}",
  });

// Connector onboarding (ticket 1.8) — metadata only in responses; the
// credentials travel one way (in) and are never read back.
export const ConnectorSummary = z.object({
  type: z.string(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
});
export type ConnectorSummary = z.infer<typeof ConnectorSummary>;

export const listConnectors = (): Promise<ConnectorSummary[]> =>
  call(z.object({ connectors: z.array(ConnectorSummary) }), "/connectors").then(
    (body) => body.connectors,
  );

export const connectConnector = (
  type: "pennylane" | "qonto",
  credentials: Record<string, string>,
): Promise<void> =>
  call(z.object({ type: z.string() }), "/connectors", {
    method: "POST",
    body: JSON.stringify({ type, credentials }),
  }).then(() => undefined);

export const disconnectConnector = async (type: string): Promise<void> => {
  // 204: no body to Zod-parse — the status IS the contract.
  const response = await fetch(`/backend/connectors/${encodeURIComponent(type)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new ApiError(response.status, `HTTP ${response.status}`);
};

/** Formats integer cents as French euros (tabular-friendly). */
export function formatEuroCents(cents: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}
