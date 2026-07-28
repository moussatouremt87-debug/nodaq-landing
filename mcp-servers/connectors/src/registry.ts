import { z } from "zod";
import { withTenant } from "@nodaq/db";
import { defaultProvider } from "@nodaq/secrets";
import type { SecretProvider } from "@nodaq/secrets";
import { DemoPennylaneClient, DemoQontoClient } from "./demo.js";
import { FEC_CONNECTOR_STATUS, FEC_CONNECTOR_TYPE, FecPennylaneClient } from "./fec.js";
import { PennylaneClient, PennylaneCredentials } from "./pennylane.js";
import { QontoClient, QontoCredentials } from "./qonto.js";

/*
 * Per-tenant connector registry (blueprint §5.6). The `connectors` table stores
 * a credentials REFERENCE (secret name); the actual credentials live in the
 * vault (.env in dev, Scaleway Secret Manager in prod) and are resolved here,
 * at call time, in memory only. Nothing from the secret value is ever logged.
 */

export const ConnectorType = z.enum(["pennylane", "qonto"]);
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
  let row;
  try {
    row = await loadConnectorRow(tenantId, "pennylane");
  } catch (error) {
    if (error instanceof ConnectorNotConfiguredError && (await loadFecRow(tenantId))) {
      return new FecPennylaneClient(tenantId);
    }
    throw error;
  }
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
