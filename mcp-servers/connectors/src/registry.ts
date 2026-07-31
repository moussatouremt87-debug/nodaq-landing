import { z } from "zod";
import { withTenant } from "@nodaq/db";
import { defaultProvider } from "@nodaq/secrets";
import type { SecretProvider } from "@nodaq/secrets";
import { BridgeClient, BridgeCredentials } from "./bridge.js";
import { DemoPdpClient, DemoPennylaneClient, DemoQontoClient, DemoSilaeClient } from "./demo.js";
import { FEC_CONNECTOR_STATUS, FEC_CONNECTOR_TYPE, FecPennylaneClient } from "./fec.js";
import { PennylaneClient, PennylaneCredentials } from "./pennylane.js";
import { QontoClient, QontoCredentials } from "./qonto.js";
import type { QontoTransactionsOptions } from "./qonto.js";
import { SilaeClient, SilaeCredentials } from "./silae.js";
import { HttpPdpClient, PdpCredentials } from "./pdp.js";
import type { PdpClient } from "./pdp.js";

/*
 * Per-tenant connector registry (blueprint §5.6). The `connectors` table stores
 * a credentials REFERENCE (secret name); the actual credentials live in the
 * vault (.env in dev, Scaleway Secret Manager in prod) and are resolved here,
 * at call time, in memory only. Nothing from the secret value is ever logged.
 */

export const ConnectorType = z.enum(["pennylane", "qonto", "bridge", "silae", "pdp"]);
export type ConnectorType = z.infer<typeof ConnectorType>;

export class ConnectorNotConfiguredError extends Error {
  constructor(tenantId: string, type: ConnectorType, reason: string) {
    // The MCP SDK forwards error messages to the CLIENT (LLM context, traces):
    // keep it generic. Details (tenant, ref, reason) go to the server log only.
    super(`connector "${type}" unavailable`);
    this.name = "ConnectorNotConfiguredError";
    console.error("[CONNECTOR-UNAVAILABLE]", { tenantId, type, reason });
  }
}

/**
 * Vault namespace enforced per tenant: the credentials REFERENCE stored in DB
 * must live under `connector/<tenantId>/`. RLS protects the row; this protects
 * the POINTER — a row created with another tenant's ref (bad import, admin
 * mistake) or an arbitrary env name (AUTH_SECRET...) is refused before any
 * vault read (RGPD audit finding 1.2).
 */
export function connectorSecretName(tenantId: string, type: string): string {
  return `connector/${tenantId}/${type}`;
}

export interface RegistryOptions {
  secretProvider?: SecretProvider;
  pennylaneBaseUrl?: string;
  qontoBaseUrl?: string;
  bridgeBaseUrl?: string;
  silaeBaseUrl?: string;
  pdpBaseUrl?: string;
}

/**
 * Statut de connecteur du tenant de démonstration (seed démo). Un connecteur
 * "demo" renvoie un client-fixture (données fictives, zéro réseau, zéro
 * secret) — jamais le statut "active" d'une vraie connexion. Ce statut n'est
 * posable QUE par le script de seed : l'API d'onboarding crée toujours
 * "active" après test réel des identifiants.
 */
export const DEMO_CONNECTOR_STATUS = "demo";

async function loadConnectorRow(tenantId: string, type: ConnectorType) {
  // Connector row is read UNDER withTenant: RLS guarantees a tenant can only
  // ever reach its own connector registrations.
  const row = await withTenant(tenantId, (tx) =>
    tx.connector.findUnique({ where: { tenantId_type: { tenantId, type } } }),
  );
  if (!row) throw new ConnectorNotConfiguredError(tenantId, type, "not configured");
  if (row.status !== "active" && row.status !== DEMO_CONNECTOR_STATUS) {
    throw new ConnectorNotConfiguredError(tenantId, type, `status ${row.status}`);
  }
  if (!row.credentialsRef.startsWith(`connector/${tenantId}/`)) {
    throw new ConnectorNotConfiguredError(tenantId, type, "credentials ref outside tenant namespace");
  }
  return row;
}

async function resolveCredentials(
  tenantId: string,
  type: ConnectorType,
  options: RegistryOptions,
  credentialsRef: string,
): Promise<unknown> {
  const provider = options.secretProvider ?? defaultProvider();
  const raw = await provider.get(credentialsRef);
  if (!raw) {
    throw new ConnectorNotConfiguredError(tenantId, type, `secret "${credentialsRef}" missing`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ConnectorNotConfiguredError(tenantId, type, "credentials secret is not valid JSON");
  }
}

/**
 * Repli « connecteur fichier » : sans Pennylane configuré, un import FEC
 * (row type "fec", statut "file", posé UNIQUEMENT par l'endpoint d'import)
 * sert les factures dérivées à travers la même interface. Le badge UI reste
 * « importé », jamais « connecté ».
 */
async function loadFecRow(tenantId: string) {
  const row = await withTenant(tenantId, (tx) =>
    tx.connector.findUnique({
      where: { tenantId_type: { tenantId, type: FEC_CONNECTOR_TYPE } },
    }),
  );
  return row && row.status === FEC_CONNECTOR_STATUS ? row : null;
}

export async function getPennylaneClient(
  tenantId: string,
  options: RegistryOptions = {},
): Promise<PennylaneClient> {
  // Repli AVANT loadConnectorRow (pas d'exception pilote, pas de fausse
  // alerte [CONNECTOR-UNAVAILABLE] pour un tenant en mode FEC seul).
  const pennylaneRow = await withTenant(tenantId, (tx) =>
    tx.connector.findUnique({
      where: { tenantId_type: { tenantId, type: "pennylane" } },
      select: { id: true },
    }),
  );
  if (!pennylaneRow && (await loadFecRow(tenantId))) {
    return new FecPennylaneClient(tenantId);
  }
  const row = await loadConnectorRow(tenantId, "pennylane");
  if (row.status === DEMO_CONNECTOR_STATUS) return new DemoPennylaneClient();
  const credentials = PennylaneCredentials.parse(
    await resolveCredentials(tenantId, "pennylane", options, row.credentialsRef),
  );
  return new PennylaneClient(credentials, options.pennylaneBaseUrl);
}

export async function getQontoClient(
  tenantId: string,
  options: RegistryOptions = {},
): Promise<QontoClient> {
  const row = await loadConnectorRow(tenantId, "qonto");
  if (row.status === DEMO_CONNECTOR_STATUS) return new DemoQontoClient();
  const credentials = QontoCredentials.parse(
    await resolveCredentials(tenantId, "qonto", options, row.credentialsRef),
  );
  return new QontoClient(credentials, options.qontoBaseUrl);
}

export async function getSilaeClient(
  tenantId: string,
  options: RegistryOptions = {},
): Promise<SilaeClient> {
  const row = await loadConnectorRow(tenantId, "silae");
  if (row.status === DEMO_CONNECTOR_STATUS) return new DemoSilaeClient();
  const credentials = SilaeCredentials.parse(
    await resolveCredentials(tenantId, "silae", options, row.credentialsRef),
  );
  return new SilaeClient(credentials, options.silaeBaseUrl);
}

/**
 * Plateforme de dématérialisation (2.4). Aucun opérateur n'est câblé en
 * dur : le tenant choisit sa PDP, l'adaptateur suit son contrat.
 */
export async function getPdpClient(
  tenantId: string,
  options: RegistryOptions = {},
): Promise<PdpClient> {
  const row = await loadConnectorRow(tenantId, "pdp");
  if (row.status === DEMO_CONNECTOR_STATUS) return new DemoPdpClient();
  const credentials = PdpCredentials.parse(
    await resolveCredentials(tenantId, "pdp", options, row.credentialsRef),
  );
  return new HttpPdpClient(credentials, options.pdpBaseUrl);
}

/** Sous-ensemble commun consommé par l'agent Compta — agnostique de la banque. */
export interface BankClient {
  getOrganization: () => ReturnType<QontoClient["getOrganization"]>;
  listTransactions: (
    options?: QontoTransactionsOptions,
  ) => ReturnType<QontoClient["listTransactions"]>;
}

export async function getBridgeClient(
  tenantId: string,
  options: RegistryOptions = {},
): Promise<BankClient> {
  const row = await loadConnectorRow(tenantId, "bridge");
  // Fixtures bancaires démo existantes (mêmes chiffres, même contrat) : le
  // mode démo ne dépend pas du fournisseur choisi par le tenant.
  if (row.status === DEMO_CONNECTOR_STATUS) return new DemoQontoClient();
  const credentials = BridgeCredentials.parse(
    await resolveCredentials(tenantId, "bridge", options, row.credentialsRef),
  );
  return new BridgeClient(credentials, options.bridgeBaseUrl);
}

/**
 * Résout le connecteur bancaire du tenant : Qonto s'il existe (priorité —
 * connecteur historique), sinon Bridge (agrégateur DSP2 toutes banques),
 * sinon échec explicite. Comme pour le repli FEC de `getPennylaneClient`, les
 * existences sont vérifiées AVANT `loadConnectorRow` (pas d'exception pilote,
 * pas de fausse alerte [CONNECTOR-UNAVAILABLE] pour un tenant en Bridge seul).
 */
export async function getBankClient(
  tenantId: string,
  options: RegistryOptions = {},
): Promise<BankClient> {
  // Sondes filtrées par statut UTILISABLE : une ligne qonto "disabled" ne
  // doit pas masquer un Bridge actif (le repli irait sinon dans le mur).
  const usable = { in: ["active", DEMO_CONNECTOR_STATUS] };
  const qontoRow = await withTenant(tenantId, (tx) =>
    tx.connector.findFirst({
      where: { tenantId, type: "qonto", status: usable },
      select: { id: true },
    }),
  );
  if (qontoRow) return getQontoClient(tenantId, options);

  const bridgeRow = await withTenant(tenantId, (tx) =>
    tx.connector.findFirst({
      where: { tenantId, type: "bridge", status: usable },
      select: { id: true },
    }),
  );
  if (bridgeRow) return getBridgeClient(tenantId, options);

  throw new ConnectorNotConfiguredError(tenantId, "qonto", "no bank connector (qonto or bridge)");
}
