import { z } from "zod";
import { COST_CATEGORIES, PROSPECT_SOURCES, PROSPECT_STAGES } from "@nodaq/shared";

export { COST_CATEGORIES, PROSPECT_SOURCES, PROSPECT_STAGES };

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
  type: "pennylane" | "qonto" | "bridge" | "silae" | "pdp",
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

// Sync Silae (ticket 3.10) — alimente équipe + absences depuis le SIRH.
export const SilaeSyncResult = z.object({
  employeesCreated: z.number(),
  employeesUpdated: z.number(),
  employeesSkipped: z.number(),
  employeesDeactivated: z.number().optional(),
  absencesCreated: z.number(),
  absencesUpdated: z.number().optional(),
  absencesSkipped: z.number(),
  absencesRemoved: z.number().optional(),
  truncated: z.boolean(),
});
export type SilaeSyncResult = z.infer<typeof SilaeSyncResult>;

export const syncSilae = (): Promise<SilaeSyncResult> =>
  call(SilaeSyncResult, "/connectors/silae/sync", { method: "POST", body: "{}" });

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
      /** Limites de la dérivation (compteurs, jamais une ligne du journal) :
       * affichées en permanence, pas seulement à l'instant de l'import — une
       * limite qui change le chiffre lu n'a aucune raison de disparaître au
       * premier rechargement. */
      warnings: z.array(z.string()),
    })
    .nullable(),
  /** Retenues de garantie du dernier import (US-8) — affichées À PART des
   * impayés. Sans ce champ ici, Zod le supprimait et l'écran n'en parlait
   * jamais : la garantie annoncée ne se voyait nulle part.
   *
   * `totalCents` est `null` hors rôle owner : une créance en euros se lit avec
   * le même droit ici que dans la marge ou le rapport mensuel. */
  retention: z.object({
    /** `null` hors rôle owner (créance en euros). Pas de nombre de factures :
     * une libération sous une autre pièce n'étant rattachable à aucune
     * facture, un compteur contredirait le solde. */
    totalCents: z.number().nullable(),
    releaseDateKnown: z.boolean(),
    /** Vrai dès qu'une retenue est en cours — dit au membre qui ne voit pas
     * le montant, pour qu'il ne relance pas ces lignes à la main. */
    inProgress: z.boolean(),
  }),
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
  /** Apprentissage appliqué au classement (2.16b) — explicabilité. */
  learned: z
    .array(
      z.object({
        field: z.string(),
        value: z.string(),
        evidence: z.number(),
        kind: z.string(),
        modelValue: z.string().optional(),
      }),
    )
    .nullable()
    .optional(),
  matchedTransactionId: z.string().nullable(),
  /// Rattachement à une affaire (4.1) — nullable, et le reste la plupart du temps.
  affaireId: z.string().nullable().optional(),
  matchedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ClasseurDocument = z.infer<typeof ClasseurDocument>;

const ClasseurDocumentEnvelope = z.object({ document: ClasseurDocument });

/** Ce que le classeur a appris de l'entreprise (2.16b) — dérivé, non stocké. */
export const ClasseurMemory = z.object({
  suppliers: z.array(
    z.object({
      key: z.string(),
      displayName: z.string(),
      fields: z.array(
        z.object({ field: z.string(), value: z.string(), evidence: z.number() }),
      ),
      conflicts: z.array(z.string()),
      documents: z.number(),
    }),
  ),
  minEvidence: z.number(),
  window: z.number(),
});
export type ClasseurMemory = z.infer<typeof ClasseurMemory>;

export const getClasseurMemory = (): Promise<ClasseurMemory> =>
  call(ClasseurMemory, "/classeur/memoire");

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

/** `hasMore` remonté tel quel : une valorisation partielle doit se dire. */
export const listStockItems = (): Promise<{ items: StockItem[]; hasMore: boolean }> =>
  call(z.object({ items: z.array(StockItem), hasMore: z.boolean() }), "/stocks");

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

/*
 * Notifications push (2.17). Les clés de subscription MONTENT vers l'API et
 * ne redescendent jamais : PushDevice ne contient ni endpoint ni clés.
 */

export const PushConfig = z.object({
  configured: z.boolean(),
  vapidPublicKey: z.string().nullable(),
});
export type PushConfig = z.infer<typeof PushConfig>;

export const PushDevice = z.object({
  id: z.string(),
  userAgent: z.string().nullable(),
  actionsEnabled: z.boolean(),
  alertsEnabled: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type PushDevice = z.infer<typeof PushDevice>;

export const getPushConfig = (): Promise<PushConfig> => call(PushConfig, "/push/config");

export const listPushDevices = (): Promise<PushDevice[]> =>
  call(z.array(PushDevice), "/push/subscriptions");

export const registerPushDevice = (subscription: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}): Promise<PushDevice> =>
  call(PushDevice, "/push/subscriptions", {
    method: "POST",
    body: JSON.stringify(subscription),
  });

export const updatePushDevice = (
  id: string,
  prefs: { actionsEnabled?: boolean; alertsEnabled?: boolean },
): Promise<{ updated: boolean }> =>
  call(z.object({ updated: z.boolean() }), `/push/subscriptions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(prefs),
  });

export const revokePushDevice = (id: string): Promise<{ revoked: boolean }> =>
  call(z.object({ revoked: z.boolean() }), `/push/subscriptions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

/*
 * Back-office support (2.18) — réservé au rôle plateforme OPERATOR (un
 * non-opérateur reçoit 404). Le corps original est servi en texte brut par
 * une route dédiée, jamais dans les objets JSON.
 */

export const SupportTicket = z.object({
  id: z.string(),
  fromEmail: z.string(),
  subject: z.string(),
  tenantId: z.string().nullable(),
  origin: z.string().nullable(),
  level: z.string().nullable(),
  status: z.string(),
  authSignal: z.string().nullable(),
  repliedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SupportTicket = z.infer<typeof SupportTicket>;

export const SupportTicketDetail = SupportTicket.extend({
  draftReply: z.string().nullable(),
  agentReport: z.unknown().nullable(),
});
export type SupportTicketDetail = z.infer<typeof SupportTicketDetail>;

export const SupportIssue = z.object({
  id: z.string(),
  title: z.string(),
  symptoms: z.string(),
  cause: z.string(),
  resolution: z.string(),
  origin: z.string(),
  occurrences: z.number(),
  validated: z.boolean(),
  updatedAt: z.string(),
});
export type SupportIssue = z.infer<typeof SupportIssue>;

export const listSupportTickets = (status?: string): Promise<SupportTicket[]> =>
  call(
    z.array(SupportTicket),
    `/ops/support/tickets${status ? `?status=${encodeURIComponent(status)}` : ""}`,
  );

export const getSupportTicket = (id: string): Promise<SupportTicketDetail> =>
  call(
    SupportTicketDetail,
    `/ops/support/tickets/${encodeURIComponent(id)}`,
  );

export const getSupportTicketBody = async (id: string): Promise<string> => {
  const response = await fetch(`/backend/ops/support/tickets/${encodeURIComponent(id)}/body`);
  if (!response.ok) throw new ApiError(response.status, `HTTP ${response.status}`);
  return response.text();
};

export const updateSupportDraft = (id: string, draftReply: string): Promise<{ updated: boolean }> =>
  call(z.object({ updated: z.boolean() }), `/ops/support/tickets/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ draftReply }),
  });

export const sendSupportReply = (id: string): Promise<{ sent: boolean }> =>
  call(z.object({ sent: z.boolean() }), `/ops/support/tickets/${encodeURIComponent(id)}/send`, {
    method: "POST",
    body: "{}",
  });

export const resolveSupportTicket = (
  id: string,
  payload: {
    issueId?: string;
    issue?: { title: string; symptoms: string; cause?: string; resolution?: string; origin: string };
  },
): Promise<{ resolved: boolean; issueId: string | null }> =>
  call(
    z.object({ resolved: z.boolean(), issueId: z.string().nullable() }),
    `/ops/support/tickets/${encodeURIComponent(id)}/resolve`,
    { method: "POST", body: JSON.stringify(payload) },
  );

export const listSupportIssues = (): Promise<SupportIssue[]> =>
  call(
    z.array(SupportIssue),
    "/ops/support/issues",
  );

export const validateSupportIssue = (id: string): Promise<{ validated: boolean }> =>
  call(z.object({ validated: z.boolean() }), `/ops/support/issues/${encodeURIComponent(id)}/validate`, {
    method: "POST",
    body: "{}",
  });

/*
 * Immobilisations (2.19) — owner-only côté API. L'impact IS est une
 * ESTIMATION labellisée ; le mur de renouvellement est un SCÉNARIO.
 */

export const FixedAsset = z.object({
  id: z.string(),
  label: z.string(),
  category: z.string(),
  inServiceDate: z.string(),
  baseCents: z.number(),
  durationMonths: z.number(),
  method: z.string(),
  source: z.string(),
  status: z.string(),
  renewalCostCents: z.number().nullable(),
  bookValueCents: z.number(),
  wearRatio: z.number(),
  planEndYear: z.number().nullable(),
});
export type FixedAsset = z.infer<typeof FixedAsset>;

export const FixedAssetRegistry = z.object({
  assets: z.array(FixedAsset),
  totalBookValueCents: z.number(),
  renewalWall: z.array(
    z.object({
      quarter: z.string(),
      capexCents: z.number(),
      assets: z.array(z.object({ id: z.string(), label: z.string() })),
    }),
  ),
  isImpact: z.object({
    currentYearDepreciationCents: z.number(),
    estimatedTaxSavingCents: z.number(),
    marginalRate: z.number(),
    upcomingInstallments: z.array(z.string()),
    // Verrou : la promesse « toujours labellisé estimation » est un contrat.
    label: z.string().min(1),
    rulesVersion: z.string().optional(),
  }),
});
export type FixedAssetRegistry = z.infer<typeof FixedAssetRegistry>;

export const getFixedAssets = (): Promise<FixedAssetRegistry> =>
  call(FixedAssetRegistry, "/immobilisations");

export const getFixedAssetPlan = (
  id: string,
): Promise<{ year: number; dotationCents: number; endBookValueCents: number }[]> =>
  call(
    z.object({
      plan: z.array(
        z.object({
          year: z.number(),
          dotationCents: z.number(),
          cumulativeCents: z.number(),
          endBookValueCents: z.number(),
        }),
      ),
    }),
    `/immobilisations/${encodeURIComponent(id)}/plan`,
  ).then((r) => r.plan);

export const createFixedAsset = (asset: {
  label: string;
  category: string;
  inServiceDate: string;
  baseCents: number;
  durationMonths: number;
  method?: string;
}): Promise<{ id: string }> =>
  call(z.object({ id: z.string() }), "/immobilisations", {
    method: "POST",
    body: JSON.stringify(asset),
  });

export const updateFixedAsset = (
  id: string,
  patch: { renewalCostCents?: number | null; status?: string; disposedAt?: string | null },
): Promise<{ updated: boolean }> =>
  call(z.object({ updated: z.boolean() }), `/immobilisations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });

/*
 * Plannings RH (3.5) — owner-only côté API (PII). Le plan est TOUJOURS
 * labellisé estimation ; verdict « inconnu » sans facturier.
 */

export const StaffMember = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  weeklyHours: z.number(),
  active: z.boolean(),
});
export type StaffMember = z.infer<typeof StaffMember>;

export const StaffAbsence = z.object({
  id: z.string(),
  staffId: z.string(),
  type: z.string(),
  startDate: z.string(),
  endDate: z.string(),
});
export type StaffAbsence = z.infer<typeof StaffAbsence>;

export const StaffingPlan = z.object({
  months: z.array(
    z.object({
      month: z.string(),
      capacityHours: z.number(),
      absenceHours: z.number(),
      estimatedWorkloadHours: z.number().nullable(),
      gapHours: z.number().nullable(),
      verdict: z.string(),
      reason: z.string(),
    }),
  ),
  activeStaff: z.number(),
  hourlyRateCents: z.number(),
  label: z.string().min(1),
  truncated: z.boolean().optional(),
});
export type StaffingPlan = z.infer<typeof StaffingPlan>;

export const getRh = (): Promise<{ staff: StaffMember[]; absences: StaffAbsence[] }> =>
  call(z.object({ staff: z.array(StaffMember), absences: z.array(StaffAbsence) }), "/rh");

export const createStaff = (member: {
  name: string;
  role?: string;
  weeklyHours?: number;
}): Promise<StaffMember> =>
  call(StaffMember, "/rh/staff", { method: "POST", body: JSON.stringify(member) });

export const updateStaff = (
  id: string,
  patch: { role?: string; weeklyHours?: number; active?: boolean },
): Promise<{ updated: boolean }> =>
  call(z.object({ updated: z.boolean() }), `/rh/staff/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });

export const createAbsence = (absence: {
  staffId: string;
  type: string;
  startDate: string;
  endDate: string;
}): Promise<{ id: string }> =>
  call(z.object({ id: z.string() }), "/rh/absences", {
    method: "POST",
    body: JSON.stringify(absence),
  });

export const deleteAbsence = (id: string): Promise<{ deleted: boolean }> =>
  call(z.object({ deleted: z.boolean() }), `/rh/absences/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

export const getStaffingPlan = (hourlyRateEur?: number): Promise<StaffingPlan> =>
  call(
    StaffingPlan,
    `/rh/plan${hourlyRateEur ? `?hourlyRateEur=${encodeURIComponent(hourlyRateEur)}` : ""}`,
  );

export const HourlyPerformance = z.object({
  months: z.array(
    z.object({
      month: z.string(),
      workedHours: z.number(),
      absenceHours: z.number(),
      revenueCents: z.number(),
      revenuePerHourCents: z.number().nullable(),
      verdict: z.string(),
      reason: z.string(),
    }),
  ),
  activeStaff: z.number(),
  targetRateCents: z.number(),
  averageRateCents: z.number().nullable(),
  trendCentsPerMonth: z.number(),
  label: z.string().min(1),
  revenueUnavailable: z.boolean().optional(),
  staffTruncated: z.boolean().optional(),
  revenueTruncated: z.boolean().optional(),
  truncated: z.boolean().optional(),
});
export type HourlyPerformance = z.infer<typeof HourlyPerformance>;

export const getHourlyPerformance = (targetRateEur?: number): Promise<HourlyPerformance> =>
  call(
    HourlyPerformance,
    `/rh/performance${targetRateEur ? `?targetRateEur=${encodeURIComponent(targetRateEur)}` : ""}`,
  );

/* Rapport mensuel (2.11) — une anomalie est un écart MESURÉ : le schéma exige
 * la valeur, la référence, le seuil et l'échantillon. Une anomalie sans ses
 * chiffres serait un jugement, et le front la refuse. */
export const MonthlyReport = z.object({
  month: z.string(),
  rulesVersion: z.string(),
  revenueCents: z.number(),
  invoiceCount: z.number(),
  overdueCents: z.number(),
  overdueCount: z.number(),
  /** Factures échues dont il ne reste rien à réclamer (retenue de garantie,
   * ou déjà encaissé) — déclaré ICI, sinon Zod le supprime et le « retrait
   * est dit » ne serait vrai que dans le JSON de l'outil (US-8). */
  overdueNotClaimableCount: z.number(),
  referenceRevenueCents: z.number().nullable(),
  referenceMonths: z.number(),
  topCustomer: z
    .object({
      name: z.string().nullable(),
      totalCents: z.number(),
      share: z.number(),
    })
    .nullable(),
  unattributedCount: z.number(),
  unattributedCents: z.number(),
  anomalies: z.array(
    z.object({
      kind: z.string(),
      observed: z.number(),
      reference: z.number(),
      threshold: z.number(),
      sampleSize: z.number(),
      reason: z.string().min(1),
    }),
  ),
  notEvaluated: z.array(z.string()),
  unusableCount: z.number(),
  excludedCount: z.number(),
  windowTruncated: z.boolean(),
  label: z.string().min(1),
});
export type MonthlyReport = z.infer<typeof MonthlyReport>;

/** Refus motivé (mois en cours ou hors fenêtre) — jamais un rapport vide. */
export const MonthlyReportRefusal = z.object({ refused: z.literal(true), reason: z.string() });

export const getMonthlyReport = (
  month?: string,
): Promise<MonthlyReport | z.infer<typeof MonthlyReportRefusal>> =>
  call(
    z.union([MonthlyReportRefusal, MonthlyReport]),
    `/rapports/mensuel${month ? `?month=${encodeURIComponent(month)}` : ""}`,
  );

/* Prospection (2.12) — données personnelles de tiers non clients. Le
 * vocabulaire vient de @nodaq/shared : recopié ici, un ajout de provenance
 * laisserait le formulaire silencieusement obsolète. */
export const Prospect = z.object({
  id: z.string(),
  name: z.string(),
  company: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  stage: z.string(),
  source: z.string(),
  optedOut: z.boolean(),
  optedOutAt: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
});
export type Prospect = z.infer<typeof Prospect>;

export const getProspects = (): Promise<{ prospects: Prospect[]; truncated: boolean }> =>
  call(
    z.object({ prospects: z.array(Prospect), truncated: z.boolean() }),
    "/prospects",
  );

export const createProspect = (input: {
  name: string;
  source: string;
  company?: string;
  email?: string;
  phone?: string;
  notes?: string;
}): Promise<{ id: string }> =>
  call(z.object({ id: z.string() }), "/prospects", {
    method: "POST",
    body: JSON.stringify(input),
  });

export const updateProspect = (
  id: string,
  input: { stage?: string; notes?: string },
): Promise<{ updated: boolean }> =>
  call(z.object({ updated: z.boolean() }), `/prospects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });

export const logProspectInteraction = (
  id: string,
  input: { kind: string; occurredAt: string; note?: string },
): Promise<{ id: string }> =>
  call(z.object({ id: z.string() }), `/prospects/${encodeURIComponent(id)}/interactions`, {
    method: "POST",
    body: JSON.stringify(input),
  });

/** Opposition (art. 21) : non réversible depuis le produit. */
export const opposeProspect = (id: string): Promise<{ optedOut: boolean }> =>
  call(
    z.object({ optedOut: z.boolean(), alreadyOptedOut: z.boolean().optional() }),
    `/prospects/${encodeURIComponent(id)}/opposition`,
    { method: "POST" },
  );

export const deleteProspect = (id: string): Promise<{ deleted: boolean }> =>
  call(z.object({ deleted: z.boolean() }), `/prospects/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

export const ProspectionPlan = z.object({
  rulesVersion: z.string(),
  pipeline: z.record(z.string(), z.number()),
  followups: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      company: z.string().nullable(),
      stage: z.string(),
      source: z.string(),
      lastContactAt: z.string().nullable(),
      daysSinceContact: z.number(),
      thresholdDays: z.number().nullable(),
      verdict: z.string(),
      reason: z.string().min(1),
    }),
  ),
  retentionAlerts: z.array(z.object({ id: z.string(), daysSinceContact: z.number() })),
  optedOutCount: z.number(),
  expiredOptedOutCount: z.number(),
  unusableCount: z.number(),
  label: z.string().min(1),
  truncated: z.boolean().optional(),
});
export type ProspectionPlan = z.infer<typeof ProspectionPlan>;

export const getProspectionPlan = (): Promise<ProspectionPlan> =>
  call(ProspectionPlan, "/prospection/suivi");

/* Marge (2.8) — le schéma REFUSE de porter un « marginRatio » nu : chaque
 * niveau porte son `kind`, et un plafond ne peut donc pas s'afficher comme un
 * résultat par un simple oubli de rendu. */
const MarginLevelBase = {
  level: z.string(),
  label: z.string(),
  costCents: z.number(),
  missingCategories: z.array(z.string()),
  marginCents: z.number(),
  reason: z.string().min(1),
};

/* Union DISCRIMINÉE : un niveau borné ne porte pas de `marginRatio`, donc le
 * front ne peut pas afficher un point là où il n'y a qu'un plafond. */
export const MarginLevel = z.discriminatedUnion("kind", [
  z.object({ ...MarginLevelBase, kind: z.literal("complete"), marginRatio: z.number() }),
  z.object({
    ...MarginLevelBase,
    kind: z.literal("borne_superieure"),
    maxMarginRatio: z.number(),
  }),
]);

export const MarginReport = z.object({
  month: z.string(),
  rulesVersion: z.string(),
  revenueCents: z.number(),
  invoiceCount: z.number(),
  costs: z.array(
    z.object({
      category: z.string(),
      label: z.string(),
      amountCents: z.number(),
      source: z.string(),
    }),
  ),
  levels: z.array(MarginLevel),
  missingCategories: z.array(z.object({ id: z.string(), label: z.string() })),
  unmappedCents: z.number(),
  revenueTruncated: z.boolean(),
  costsPossiblyPartial: z.boolean(),
  notEvaluated: z.array(z.string()),
  excludedCount: z.number(),
  unusableCount: z.number(),
  label: z.string().min(1),
  revenueUnavailable: z.boolean().optional(),
});
export type MarginReport = z.infer<typeof MarginReport>;

export const MarginRefusal = z.object({
  refused: z.literal(true),
  reason: z.string(),
  rulesVersion: z.string().optional(),
});

export const getMargin = (
  month?: string,
): Promise<MarginReport | z.infer<typeof MarginRefusal>> =>
  call(
    z.union([MarginRefusal, MarginReport]),
    `/marge${month ? `?month=${encodeURIComponent(month)}` : ""}`,
  );

export const CostLine = z.object({
  id: z.string(),
  category: z.string(),
  amountCents: z.number(),
  source: z.string(),
});
export type CostLine = z.infer<typeof CostLine>;

export const getCosts = (month: string): Promise<{ costs: CostLine[] }> =>
  call(
    z.object({ costs: z.array(CostLine) }),
    `/marge/charges?month=${encodeURIComponent(month)}`,
  );

export const putCost = (input: {
  month: string;
  category: string;
  amountCents: number;
}): Promise<{ id: string }> =>
  call(z.object({ id: z.string() }), "/marge/charges", {
    method: "PUT",
    body: JSON.stringify(input),
  });

export const ComplianceProfile = z.object({
  vertical: z.string(),
  headcountOverride: z.number().nullable(),
  derivedHeadcount: z.number().nullable(),
});
export type ComplianceProfile = z.infer<typeof ComplianceProfile>;

export const RegulatoryWatch = z.object({
  version: z.string(),
  label: z.string().min(1),
  profile: z.object({
    vertical: z.string(),
    headcount: z.number().nullable(),
    headcountSource: z.string(),
  }),
  matches: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      category: z.string(),
      obligation: z.string(),
      source: z.object({ label: z.string(), url: z.string() }),
      applies: z.string(),
      status: z.string(),
      nextDeadline: z.string().nullable(),
      daysUntil: z.number().nullable(),
      reason: z.string(),
    }),
  ),
});
export type RegulatoryWatch = z.infer<typeof RegulatoryWatch>;

export const getComplianceProfile = (): Promise<ComplianceProfile> =>
  call(ComplianceProfile, "/reglementaire/profil");

export const putComplianceProfile = (profile: {
  vertical: string;
  headcountOverride?: number | null;
}): Promise<{ vertical: string; headcountOverride: number | null }> =>
  call(
    z.object({ vertical: z.string(), headcountOverride: z.number().nullable() }),
    "/reglementaire/profil",
    { method: "PUT", body: JSON.stringify(profile) },
  );

export const getRegulatoryWatch = (): Promise<RegulatoryWatch> =>
  call(RegulatoryWatch, "/reglementaire");

export const CustomerReview = z.object({
  id: z.string(),
  source: z.string(),
  authorName: z.string().nullable(),
  rating: z.number(),
  text: z.string(),
  reviewedAt: z.string(),
  replyText: z.string().nullable(),
  repliedAt: z.string().nullable(),
});
export type CustomerReview = z.infer<typeof CustomerReview>;

export const ReputationReport = z.object({
  totalReviews: z.number(),
  averageRating: z.number().nullable(),
  distribution: z.record(z.string(), z.number()),
  replyRatePct: z.number().nullable(),
  trend: z
    .object({
      recentAverage: z.number(),
      previousAverage: z.number(),
      verdict: z.string(),
    })
    .nullable(),
  unansweredNegative: z.array(
    z.object({ id: z.string(), rating: z.number(), daysAgo: z.number() }),
  ),
  label: z.string().min(1),
  truncated: z.boolean().optional(),
});
export type ReputationReport = z.infer<typeof ReputationReport>;

export const getReviews = (): Promise<{ reviews: CustomerReview[] }> =>
  call(z.object({ reviews: z.array(CustomerReview) }), "/avis");

export const createReview = (review: {
  source: string;
  authorName?: string;
  rating: number;
  text: string;
  reviewedAt: string;
}): Promise<{ id: string }> =>
  call(z.object({ id: z.string() }), "/avis", {
    method: "POST",
    body: JSON.stringify(review),
  });

export const importReviews = (
  reviews: unknown[],
): Promise<{ imported: number; skipped: number }> =>
  call(z.object({ imported: z.number(), skipped: z.number() }), "/avis/import", {
    method: "POST",
    body: JSON.stringify({ reviews }),
  });

export const deleteReview = (reviewId: string): Promise<{ deleted: boolean }> =>
  call(z.object({ deleted: z.boolean() }), `/avis/${encodeURIComponent(reviewId)}`, {
    method: "DELETE",
  });

export const getReputation = (): Promise<ReputationReport> =>
  call(ReputationReport, "/avis/reputation");

export const draftReviewReply = (reviewId: string): Promise<{ pendingActionId: string }> =>
  call(
    z.object({ pendingActionId: z.string() }),
    `/avis/${encodeURIComponent(reviewId)}/reponse`,
    { method: "POST" },
  );

export const ProcessingActivity = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.string(),
  legalBasis: z.string(),
  dataCategories: z.array(z.string()),
  dataSubjects: z.array(z.string()),
  recipients: z.string().nullable(),
  retention: z.string(),
  sensitiveData: z.boolean(),
  sourceTemplate: z.string().nullable(),
});
export type ProcessingActivity = z.infer<typeof ProcessingActivity>;

export const RgpdRegister = z.object({
  activities: z.array(ProcessingActivity),
  activitiesTruncated: z.boolean().optional(),
  // L'audit peut être indisponible (503 outil) : le registre reste servi.
  audit: z
    .object({
      version: z.string(),
      activityCount: z.number(),
      issues: z.array(
        z.object({
          code: z.string(),
          severity: z.string(),
          activityName: z.string().optional(),
          reason: z.string(),
        }),
      ),
      label: z.string().min(1),
      truncated: z.boolean().optional(),
    })
    .nullable(),
  templates: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      purpose: z.string(),
      legalBasis: z.string(),
      retention: z.string(),
      source: z.object({ label: z.string(), url: z.string().url() }),
    }),
  ),
});
export type RgpdRegister = z.infer<typeof RgpdRegister>;

export const getRgpdRegister = (): Promise<RgpdRegister> => call(RgpdRegister, "/rgpd");

export const addActivityFromTemplate = (templateId: string): Promise<{ id: string }> =>
  call(z.object({ id: z.string() }), `/rgpd/modele/${encodeURIComponent(templateId)}`, {
    method: "POST",
    body: "{}",
  });

export const deleteActivity = (id: string): Promise<{ deleted: boolean }> =>
  call(z.object({ deleted: z.boolean() }), `/rgpd/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

export const ModuleStates = z.object({
  version: z.string(),
  // Vertical + source : OWNER-ONLY (donnée stratégique 3.7) — absents pour
  // les membres, dont la nav n'a besoin que de {id, href, active}.
  vertical: z.string().optional(),
  modules: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      /** Absent pour un module sans page à lui (outils d'agent ou carte
       * cockpit seulement) — la nav n'a alors rien à masquer. */
      href: z.string().optional(),
      active: z.boolean(),
      source: z.string().optional(),
    }),
  ),
});
export type ModuleStates = z.infer<typeof ModuleStates>;

export const getModules = (): Promise<ModuleStates> => call(ModuleStates, "/modules");

export const setModule = (id: string, active: boolean): Promise<{ active: boolean }> =>
  call(
    z.object({ id: z.string(), active: z.boolean() }),
    `/modules/${encodeURIComponent(id)}`,
    { method: "PUT", body: JSON.stringify({ active }) },
  );

// Webhooks entrants (2.13) — le secret ne transite qu'UNE fois, à la
// création : il n'est jamais relisible ensuite (ni en base, ni par l'API).
export const WebhookEndpoint = z.object({
  id: z.string(),
  provider: z.string(),
  active: z.boolean(),
  description: z.string(),
  createdAt: z.string(),
});
export type WebhookEndpoint = z.infer<typeof WebhookEndpoint>;

export const WebhookEvent = z.object({
  id: z.string(),
  provider: z.string(),
  eventType: z.string(),
  externalId: z.string(),
  status: z.string(),
  attempts: z.number(),
  receivedAt: z.string(),
  processedAt: z.string().nullable(),
});
export type WebhookEvent = z.infer<typeof WebhookEvent>;

export const listWebhookEndpoints = (): Promise<WebhookEndpoint[]> =>
  call(z.object({ endpoints: z.array(WebhookEndpoint) }), "/webhooks/endpoints").then(
    (body) => body.endpoints,
  );

export const createWebhookEndpoint = (
  provider: string,
  description?: string,
): Promise<WebhookEndpoint & { url: string; secret: string; signatureHeader: string }> =>
  call(
    WebhookEndpoint.extend({
      url: z.string(),
      secret: z.string(),
      signatureHeader: z.string(),
    }),
    "/webhooks/endpoints",
    { method: "POST", body: JSON.stringify({ provider, ...(description ? { description } : {}) }) },
  );

export const deleteWebhookEndpoint = (provider: string): Promise<{ deleted: boolean }> =>
  call(z.object({ deleted: z.boolean() }), `/webhooks/endpoints/${encodeURIComponent(provider)}`, {
    method: "DELETE",
  });

export const listWebhookEvents = (): Promise<WebhookEvent[]> =>
  call(z.object({ events: z.array(WebhookEvent) }), "/webhooks/events").then(
    (body) => body.events,
  );

/*
 * Soumission PDP + e-reporting (2.4). Le dépôt n'est jamais appelé d'ici :
 * la page PROPOSE, la file de validation exécute — l'envoi sur le réseau
 * national engage l'entreprise.
 */
export const EInvoiceSubmission = z.object({
  id: z.string(),
  invoiceNumber: z.string(),
  profile: z.string(),
  direction: z.string(),
  status: z.string(),
  pdpReference: z.string().nullable(),
  documentHash: z.string(),
  amountCents: z.number(),
  currency: z.string(),
  statusHistory: z.unknown(),
  submittedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type EInvoiceSubmission = z.infer<typeof EInvoiceSubmission>;

export const EInvoiceSubmissions = z.object({
  items: z.array(EInvoiceSubmission),
  statusLabels: z.record(z.string()),
  rulesVersion: z.string(),
});
export type EInvoiceSubmissions = z.infer<typeof EInvoiceSubmissions>;

export const EReportingPreview = z.object({
  periodStart: z.string(),
  periodEnd: z.string(),
  transactionCount: z.number(),
  totalCents: z.number(),
  currency: z.string(),
  outOfPeriodCount: z.number(),
  unusableCount: z.number(),
  otherCurrencyCount: z.number(),
  vatDerivable: z.boolean(),
  caveats: z.array(z.string()),
  truncated: z.boolean(),
});
export type EReportingPreview = z.infer<typeof EReportingPreview>;

export const getSubmissions = (): Promise<EInvoiceSubmissions> =>
  call(EInvoiceSubmissions, "/factures/soumissions");

export const previewEReporting = (
  periodStart: string,
  periodEnd: string,
): Promise<EReportingPreview> =>
  call(
    EReportingPreview,
    `/factures/ereporting/apercu?periodStart=${encodeURIComponent(periodStart)}&periodEnd=${encodeURIComponent(periodEnd)}`,
  );

export const proposeEReporting = (declaration: {
  periodStart: string;
  periodEnd: string;
  totalCents: number;
  vatCents: number;
  transactionCount: number;
}): Promise<{ pendingActionId: string; period: string }> =>
  call(z.object({ pendingActionId: z.string(), period: z.string() }), "/factures/ereporting", {
    method: "POST",
    body: JSON.stringify(declaration),
  });

/*
 * Échéancier fiscal & social (2.9). Le calendrier est DÉRIVÉ à chaque
 * lecture ; seules les décisions du dirigeant (montant, payé, non
 * applicable) sont enregistrées.
 */
export const FiscalProfile = z.object({
  vatRegime: z.string(),
  corporateTaxLiable: z.boolean(),
  fiscalYearEndMonth: z.number(),
  payrollPeriodicity: z.string(),
  rulesVersion: z.string().optional(),
});
export type FiscalProfile = z.infer<typeof FiscalProfile>;

export const TaxDeadline = z.object({
  obligationId: z.string(),
  label: z.string(),
  category: z.string(),
  dueDate: z.string(),
  period: z.string(),
  basis: z.string(),
  dateIsApproximate: z.boolean(),
  source: z.object({ label: z.string(), url: z.string() }),
  amountCents: z.number().nullable(),
  status: z.string(),
  note: z.string().nullable(),
});
export type TaxDeadline = z.infer<typeof TaxDeadline>;

export const TaxSchedule = z.object({
  rulesVersion: z.string(),
  from: z.string(),
  to: z.string(),
  deadlines: z.array(TaxDeadline),
  gaps: z.array(z.string()),
  plannedOutflowCents: z.number(),
  unpricedCount: z.number(),
  label: z.string(),
});
export type TaxSchedule = z.infer<typeof TaxSchedule>;

export const getTaxSchedule = (monthsAhead = 3): Promise<TaxSchedule> =>
  call(TaxSchedule, `/echeancier?monthsAhead=${monthsAhead}`);

/**
 * Variante pour le cockpit : l'échéancier est owner-only côté API, alors on
 * ne l'appelle QUE pour un owner. Sans ce garde, chaque ouverture du cockpit
 * par un membre ou un expert-comptable produirait un 403 dans les logs API.
 */
export const getTaxScheduleIfOwner = async (
  monthsAhead = 3,
): Promise<TaxSchedule | null> => {
  const session = await getMe();
  const active = session.memberships.find((m) => m.tenantId === session.activeOrganizationId);
  if (active?.role !== "owner") return null;
  return getTaxSchedule(monthsAhead);
};

export const getFiscalProfile = (): Promise<FiscalProfile> =>
  call(FiscalProfile, "/echeancier/profil");

export const putFiscalProfile = (profile: {
  vatRegime: string;
  corporateTaxLiable: boolean;
  fiscalYearEndMonth: number;
  payrollPeriodicity: string;
}): Promise<unknown> =>
  call(z.unknown(), "/echeancier/profil", { method: "PUT", body: JSON.stringify(profile) });

export const putTaxDeadline = (deadline: {
  obligationId: string;
  dueDate: string;
  amountCents: number | null;
  status: string;
  note: string | null;
}): Promise<unknown> =>
  call(z.unknown(), "/echeancier/deadline", { method: "PUT", body: JSON.stringify(deadline) });

/*
 * Cockpit conversationnel (2.5). Une question en français, une réponse
 * chiffrée sur les données du tenant — et la liste des outils réellement
 * utilisés, pour voir d'où vient le chiffre.
 */
export const CockpitAnswer = z.object({
  answer: z.string(),
  tools: z.array(z.string()),
});
export type CockpitAnswer = z.infer<typeof CockpitAnswer>;

export const askCockpit = (question: string): Promise<CockpitAnswer> =>
  call(CockpitAnswer, "/cockpit/ask", { method: "POST", body: JSON.stringify({ question }) });

/*
 * Devis depuis un e-mail (2.7). Le corps part dans UN sens : il n'est jamais
 * renvoyé, et la réponse ne porte que des compteurs + l'id de l'action à
 * valider.
 */
export const QuoteDraftResult = z.object({
  pendingActionId: z.string(),
  status: z.string(),
  lines: z.number(),
  unmatchedCount: z.number(),
  pricing: z.string(),
});
export type QuoteDraftResult = z.infer<typeof QuoteDraftResult>;

export const draftQuoteFromEmail = (
  emailBody: string,
  from?: string,
): Promise<QuoteDraftResult> =>
  call(QuoteDraftResult, "/devis/depuis-email", {
    method: "POST",
    body: JSON.stringify({ emailBody, ...(from ? { from } : {}) }),
  });

/*
 * Affaires (4.1) — le pivot du produit.
 *
 * Les montants sont NULL pour un membre (l'API les retire, elle ne les masque
 * pas côté écran) : `amountsVisible` dit lequel des deux cas on regarde, pour
 * qu'un tiret ne se lise jamais comme « zéro euro ».
 */
export const Affaire = z.object({
  id: z.string(),
  reference: z.string(),
  label: z.string(),
  clientName: z.string().nullable(),
  status: z.string(),
  address: z.string().nullable(),
  quotedAmountCents: z.number().nullable(),
  estimatedHours: z.number().nullable(),
  hoursWorked: z.number().nullable(),
  estimatedMaterialCents: z.number().nullable(),
  depositsCents: z.number().nullable(),
  retentionRateBps: z.number().nullable(),
  retentionReleaseDate: z.string().nullable(),
  startDate: z.string().nullable(),
  plannedEndDate: z.string().nullable(),
  actualEndDate: z.string().nullable(),
  createdAt: z.string(),
});
export type Affaire = z.infer<typeof Affaire>;

const BudgetGap = z.object({ deltaCents: z.number(), deltaBps: z.number() });

/**
 * Marge — UNION DISCRIMINÉE, transportée telle quelle depuis le moteur.
 * L'écran choisit son rendu sur `kind` : il ne peut pas afficher une marge qui
 * n'existe pas, parce que le champ n'est pas là.
 */
export const AffaireMarge = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("donnees_insuffisantes"),
    materialCents: z.number(),
    subcontractCents: z.number(),
    ttcOnlyCents: z.number(),
    ttcOnlyCount: z.number(),
    unknownAmountCount: z.number(),
    depositsCents: z.number(),
    retentionCents: z.number(),
    missing: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("couts_seuls"),
    materialCents: z.number(),
    subcontractCents: z.number(),
    ttcOnlyCents: z.number(),
    ttcOnlyCount: z.number(),
    unknownAmountCount: z.number(),
    depositsCents: z.number(),
    retentionCents: z.number(),
    missing: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("marge"),
    materialCents: z.number(),
    subcontractCents: z.number(),
    ttcOnlyCents: z.number(),
    ttcOnlyCount: z.number(),
    unknownAmountCount: z.number(),
    depositsCents: z.number(),
    retentionCents: z.number(),
    labourCents: z.number(),
    totalCostCents: z.number(),
    marginCents: z.number(),
    marginBps: z.number().nullable(),
    remainingToInvoiceCents: z.number().nullable(),
    budgetGap: BudgetGap.nullable(),
    missing: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("marge_borne_superieure"),
    materialCents: z.number(),
    subcontractCents: z.number(),
    ttcOnlyCents: z.number(),
    ttcOnlyCount: z.number(),
    unknownAmountCount: z.number(),
    depositsCents: z.number(),
    retentionCents: z.number(),
    upperBoundCents: z.number(),
    remainingToInvoiceCents: z.number().nullable(),
    budgetGap: BudgetGap.nullable(),
    missing: z.array(z.string()),
  }),
]);
export type AffaireMarge = z.infer<typeof AffaireMarge>;

export const AffaireImputation = z.object({
  id: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  source: z.string(),
  subcontract: z.boolean(),
  amountCents: z.number().nullable(),
  amountBasis: z.string().nullable(),
  createdAt: z.string(),
});
export type AffaireImputation = z.infer<typeof AffaireImputation>;

const AffaireList = z.object({
  affaires: z.array(Affaire),
  vertical: z.string().nullable(),
  amountsVisible: z.boolean(),
});
export type AffaireList = z.infer<typeof AffaireList>;

const AffaireDetail = z.object({
  affaire: Affaire,
  vertical: z.string().nullable(),
  amountsVisible: z.boolean(),
  hourlyCostKnown: z.boolean(),
  imputations: z.array(AffaireImputation),
  documents: z.array(
    z.object({
      id: z.string(),
      fileName: z.string(),
      docType: z.string(),
      status: z.string(),
      createdAt: z.string(),
    }),
  ),
  marge: AffaireMarge.nullable(),
  margeRefus: z.string().nullable(),
  invoicedCents: z.number().nullable(),
});
export type AffaireDetail = z.infer<typeof AffaireDetail>;

export const listAffaires = (options?: {
  statut?: string;
  inclureArchivees?: boolean;
}): Promise<AffaireList> => {
  const params = new URLSearchParams();
  if (options?.statut) params.set("statut", options.statut);
  if (options?.inclureArchivees) params.set("inclureArchivees", "true");
  const query = params.toString();
  return call(AffaireList, `/affaires${query ? `?${query}` : ""}`);
};

export const getAffaire = (id: string): Promise<AffaireDetail> =>
  call(AffaireDetail, `/affaires/${encodeURIComponent(id)}`);

export const createAffaire = (input: Record<string, unknown>): Promise<Affaire> =>
  call(Affaire, "/affaires", { method: "POST", body: JSON.stringify(input) });

export const updateAffaire = (id: string, input: Record<string, unknown>): Promise<Affaire> =>
  call(Affaire, `/affaires/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });

/** Archiver — il n'existe PAS de suppression, et ce n'est pas un oubli. */
export const archiveAffaire = (id: string): Promise<Affaire> =>
  call(Affaire, `/affaires/${encodeURIComponent(id)}/archiver`, { method: "POST", body: "{}" });

export const imputeToAffaire = (
  affaireId: string,
  input: {
    targetType: string;
    targetId: string;
    /** CONFIRMEE quand l'humain accepte une suggestion, MANUELLE quand il choisit seul. */
    source?: "AUTO" | "CONFIRMEE" | "MANUELLE";
    amountCents?: number | null;
    amountBasis?: "ht" | "ttc" | null;
    subcontract?: boolean;
  },
): Promise<{ id: string }> =>
  call(z.object({ id: z.string() }), `/affaires/${encodeURIComponent(affaireId)}/imputations`, {
    method: "POST",
    body: JSON.stringify(input),
  });

export const removeImputation = (
  affaireId: string,
  imputationId: string,
): Promise<{ revoked: boolean }> =>
  call(
    z.object({ revoked: z.boolean() }),
    `/affaires/${encodeURIComponent(affaireId)}/imputations/${encodeURIComponent(imputationId)}`,
    { method: "DELETE" },
  );

/*
 * F4 — la marge de chaque chantier, pour le cockpit.
 *
 * Trois groupes SÉPARÉS, jamais un classement unique : mélanger une marge
 * exacte, un plafond et une affaire dont on ne sait rien ferait passer
 * « inconnu » pour « va bien ».
 */
const AffaireMarginRow = z.object({
  id: z.string(),
  reference: z.string(),
  label: z.string(),
  status: z.string(),
  margin: AffaireMarge,
});
export type AffaireMarginRow = z.infer<typeof AffaireMarginRow>;

const AffairesMarges = z.object({
  aSurveiller: z.array(AffaireMarginRow),
  chiffrables: z.array(AffaireMarginRow),
  nonChiffrables: z.array(AffaireMarginRow),
  ignorees: z.number(),
  hourlyCostKnown: z.boolean(),
});
export type AffairesMarges = z.infer<typeof AffairesMarges>;

export const getAffairesMarges = (): Promise<AffairesMarges> =>
  call(AffairesMarges, "/affaires/marges");

/*
 * F2 — suggestion d'affaire pour une pièce photographiée.
 *
 * Union discriminée : l'ABSTENTION est une réponse à part entière, avec son
 * motif. Un écran ne peut pas la confondre avec « pas encore chargé », ni la
 * remplacer par une suggestion vide.
 */
export const AffaireSuggestionReason = z.union([
  z.object({ kind: z.literal("historique_fournisseur"), count: z.number() }),
  z.object({ kind: z.literal("dans_la_periode") }),
  z.object({ kind: z.literal("seule_affaire_en_cours") }),
]);

export const AffaireSuggestions = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("suggestions"),
    items: z.array(
      z.object({
        affaireId: z.string(),
        reference: z.string(),
        label: z.string(),
        reasons: z.array(AffaireSuggestionReason),
      }),
    ),
    version: z.string(),
  }),
  z.object({
    kind: z.literal("abstention"),
    // Union fermée, pas `string` : un motif mal orthographié doit échouer à la
    // frontière, pas s'afficher tel quel à l'utilisateur.
    why: z.enum([
      "aucune_affaire_ouverte",
      "aucun_signal",
      "signaux_partages",
      "piece_illisible",
      "deja_rattachee",
    ]),
    version: z.string(),
  }),
]);
export type AffaireSuggestions = z.infer<typeof AffaireSuggestions>;

export const getAffaireSuggestions = (documentId: string): Promise<AffaireSuggestions> =>
  call(AffaireSuggestions, `/classeur/documents/${encodeURIComponent(documentId)}/affaires-suggerees`);

/** Formats integer cents as French euros (tabular-friendly). */
export function formatEuroCents(cents: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}
