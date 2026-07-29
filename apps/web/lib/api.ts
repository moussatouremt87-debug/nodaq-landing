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
  name: z.string().nullable().optional(),
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
  /** Articles sous leur seuil d'alerte (3.2) — visible de tout membre. */
  stockAlerts: z.number(),
  treasury: z
    .object({
      account: z.string(),
      currentBalanceCents: z.number(),
      avgDailyNetFlowCents: z.number(),
      observedDays: z.number(),
      points: z.array(z.object({ horizonDays: z.number(), projectedBalanceCents: z.number() })),
    })
    .nullable(),
  // Prévision des ventes (3.1) — owner only côté API, null sinon.
  sales: z
    .object({
      series: z.array(
        z.object({ month: z.string(), revenueCents: z.number(), invoiceCount: z.number() }),
      ),
      points: z.array(z.object({ month: z.string(), revenueCents: z.number() })),
      observedMonths: z.number(),
      trendCentsPerMonth: z.number(),
      method: z.string(),
    })
    .nullable(),
});
export type CockpitKpis = z.infer<typeof CockpitKpis>;

export const getMe = (): Promise<Me> => call(Me, "/me");

export const getKpis = (): Promise<CockpitKpis> => call(CockpitKpis, "/cockpit/kpis");

export const listPendingActions = (): Promise<PendingActionSummary[]> =>
  call(z.array(PendingActionSummary), "/pending-actions");

// Owner-gated detail: the payload carries the confidential draft the human
// reviews (and may edit) before deciding.
export const PendingActionDetail = PendingActionSummary.extend({
  payload: z.unknown(),
});
export type PendingActionDetail = z.infer<typeof PendingActionDetail>;

export const getPendingAction = (id: string): Promise<PendingActionDetail> =>
  call(PendingActionDetail, `/pending-actions/${encodeURIComponent(id)}`);

export const DraftUpdate = z.object({
  id: z.string(),
  status: z.string(),
  draft: z.string(),
});
export type DraftUpdate = z.infer<typeof DraftUpdate>;

export const updatePendingActionDraft = (id: string, draft: string): Promise<DraftUpdate> =>
  call(DraftUpdate, `/pending-actions/${encodeURIComponent(id)}/draft`, {
    method: "PATCH",
    body: JSON.stringify({ draft }),
  });

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
  type: "pennylane" | "qonto" | "bridge",
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

// Import FEC (ticket 2.14) — le « connecteur fichier » universel. Le contenu
// du fichier voyage dans UN sens (upload) ; les réponses ne contiennent que
// des compteurs et avertissements, jamais une ligne du journal comptable.
export const FecImportReport = z.object({
  alreadyImported: z.boolean(),
  entryCount: z.number(),
  customerCount: z.number(),
  invoiceCount: z.number(),
  overdueCount: z.number(),
  overdueCents: z.number(),
  warnings: z.array(z.string()),
});
export type FecImportReport = z.infer<typeof FecImportReport>;

export const FecStatus = z.object({
  imported: z.boolean(),
  lastImport: z
    .object({
      importedAt: z.string(),
      fileName: z.string().nullable(),
      entryCount: z.number(),
      invoiceCount: z.number(),
      overdueCount: z.number(),
    })
    .nullable(),
});
export type FecStatus = z.infer<typeof FecStatus>;

export const getFecStatus = (): Promise<FecStatus> => call(FecStatus, "/connectors/fec");

export interface FecLineIssue {
  line: number;
  message: string;
}

/** Erreur d'import FEC : fichier invalide (422) avec rapport ligne à ligne. */
export class FecInvalidError extends ApiError {
  constructor(public readonly issues: FecLineIssue[]) {
    super(422, "FEC invalide");
    this.name = "FecInvalidError";
  }
}

export const importFec = async (bytes: ArrayBuffer, fileName: string): Promise<FecImportReport> => {
  const response = await fetch("/backend/connectors/fec/import", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      // Métadonnée d'affichage uniquement (encodée ASCII pour l'en-tête).
      "x-fec-filename": encodeURIComponent(fileName),
    },
    body: bytes,
  });
  if (response.status === 422) {
    const body: unknown = await response.json().catch(() => ({}));
    const issues =
      body && typeof body === "object" && "details" in body && Array.isArray(body.details)
        ? (body.details as FecLineIssue[])
        : [];
    throw new FecInvalidError(issues);
  }
  if (!response.ok) throw new ApiError(response.status, `HTTP ${response.status}`);
  return FecImportReport.parse(await response.json());
};

// ── Classeur documentaire photo (ticket 2.16) ────────────────────────────────
// La photo elle-même ne transite JAMAIS en JSON : elle est servie par la
// route binaire dédiée (classeurPhotoUrl), authentifiée et scellée au tenant.

export const ClasseurExtraction = z
  .object({
    docType: z.string().optional(),
    supplierName: z.string().nullable().optional(),
    pieceNumber: z.string().nullable().optional(),
    docDate: z.string().nullable().optional(),
    currency: z.string().nullable().optional(),
    totalExclTax: z.number().nullable().optional(),
    totalTax: z.number().nullable().optional(),
    totalInclTax: z.number().nullable().optional(),
  })
  .nullable();
export type ClasseurExtraction = z.infer<typeof ClasseurExtraction>;

export const ClasseurDocument = z.object({
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  byteSize: z.number(),
  docType: z.string(),
  status: z.string(),
  extraction: ClasseurExtraction,
  originalExtraction: ClasseurExtraction,
  corrections: z.array(z.unknown()),
  matchedTransactionId: z.string().nullable(),
  matchedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ClasseurDocument = z.infer<typeof ClasseurDocument>;

const ClasseurDocumentEnvelope = z.object({ document: ClasseurDocument });

export const listClasseurDocuments = (): Promise<ClasseurDocument[]> =>
  call(z.object({ documents: z.array(ClasseurDocument) }), "/classeur/documents").then(
    (r) => r.documents,
  );

export interface ClasseurUpload {
  alreadyImported: boolean;
  document: ClasseurDocument;
}

export const uploadClasseurDocument = async (
  bytes: ArrayBuffer,
  fileName: string,
): Promise<ClasseurUpload> => {
  const response = await fetch("/backend/classeur/documents", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-doc-filename": encodeURIComponent(fileName),
    },
    body: bytes,
  });
  if (!response.ok) throw new ApiError(response.status, `HTTP ${response.status}`);
  const body: unknown = await response.json();
  const parsed = z
    .object({ alreadyImported: z.boolean(), document: ClasseurDocument })
    .parse(body);
  return parsed;
};

export interface ClasseurCorrection {
  docType?: string;
  supplierName?: string | null;
  pieceNumber?: string | null;
  docDate?: string | null;
  currency?: string | null;
  totalExclTax?: number | null;
  totalTax?: number | null;
  totalInclTax?: number | null;
}

export const correctClasseurDocument = (
  id: string,
  fields: ClasseurCorrection,
): Promise<ClasseurDocument> =>
  call(ClasseurDocumentEnvelope, `/classeur/documents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  }).then((r) => r.document);

export const MatchCandidate = z.object({
  transactionId: z.string(),
  label: z.string().nullable(),
  amountCents: z.number(),
  settledAt: z.string().nullable(),
  score: z.number(),
});
export type MatchCandidate = z.infer<typeof MatchCandidate>;

export const getClasseurCandidates = (
  id: string,
): Promise<{ candidates: MatchCandidate[]; reason?: string }> =>
  call(
    z.object({ candidates: z.array(MatchCandidate), reason: z.string().optional() }),
    `/classeur/documents/${encodeURIComponent(id)}/candidates`,
  );

export const matchClasseurDocument = (
  id: string,
  transactionId: string | null,
): Promise<ClasseurDocument> =>
  call(ClasseurDocumentEnvelope, `/classeur/documents/${encodeURIComponent(id)}/match`, {
    method: "POST",
    body: JSON.stringify({ transactionId }),
  }).then((r) => r.document);

export const deleteClasseurDocument = async (id: string): Promise<void> => {
  const response = await fetch(`/backend/classeur/documents/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new ApiError(response.status, `HTTP ${response.status}`);
};

export const classeurPhotoUrl = (id: string): string =>
  `/backend/classeur/documents/${encodeURIComponent(id)}/photo`;

// ── Suivi des stocks (ticket 3.2) ────────────────────────────────────────────

export const StockItem = z.object({
  id: z.string(),
  name: z.string(),
  sku: z.string().nullable(),
  unit: z.string(),
  quantity: z.number(),
  alertThreshold: z.number(),
  belowThreshold: z.boolean(),
  updatedAt: z.string(),
  // Coût de remplacement et valorisation (3.3) — présents pour l'owner seulement.
  unitCostCents: z.number().optional(),
  valueCents: z.number().optional(),
});
export type StockItem = z.infer<typeof StockItem>;

const StockItemEnvelope = z.object({ item: StockItem });

export const listStockItems = (): Promise<StockItem[]> =>
  call(z.object({ items: z.array(StockItem), hasMore: z.boolean() }), "/stocks").then(
    (r) => r.items,
  );

export const createStockItem = (input: {
  name: string;
  sku?: string;
  unit?: string;
  alertThreshold?: number;
}): Promise<StockItem> =>
  call(StockItemEnvelope, "/stocks", { method: "POST", body: JSON.stringify(input) }).then(
    (r) => r.item,
  );

export const updateStockItem = (
  id: string,
  input: {
    name?: string;
    sku?: string | null;
    unit?: string;
    alertThreshold?: number;
    unitCostCents?: number;
  },
): Promise<StockItem> =>
  call(StockItemEnvelope, `/stocks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  }).then((r) => r.item);

export const deleteStockItem = async (id: string): Promise<void> => {
  const response = await fetch(`/backend/stocks/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw new ApiError(response.status, `HTTP ${response.status}`);
};

export const moveStock = (id: string, delta: number, reason?: string): Promise<StockItem> =>
  call(StockItemEnvelope, `/stocks/${encodeURIComponent(id)}/movements`, {
    method: "POST",
    body: JSON.stringify({ delta, ...(reason ? { reason } : {}) }),
  }).then((r) => r.item);

export const StockMovement = z.object({
  id: z.string(),
  delta: z.number(),
  reason: z.string().nullable(),
  createdAt: z.string(),
});
export type StockMovement = z.infer<typeof StockMovement>;

export const listStockMovements = (id: string): Promise<StockMovement[]> =>
  call(
    z.object({ movements: z.array(StockMovement) }),
    `/stocks/${encodeURIComponent(id)}/movements`,
  ).then((r) => r.movements);

/** Formats integer cents as French euros (tabular-friendly). */
export function formatEuroCents(cents: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}
