import { z } from "zod";
import { withTenant } from "@nodaq/db";
import { defaultProvider } from "@nodaq/secrets";
import type { SecretProvider } from "@nodaq/secrets";
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

async function resolveCredentials(
  tenantId: string,
  type: ConnectorType,
  options: RegistryOptions,
): Promise<unknown> {
  // Connector row is read UNDER withTenant: RLS guarantees a tenant can only
  // ever reach its own connector registrations.
  const row = await withTenant(tenantId, (tx) =>
    tx.connector.findUnique({ where: { tenantId_type: { tenantId, type } } }),
  );
  if (!row) throw new ConnectorNotConfiguredError(tenantId, type, "not configured");
  if (row.status !== "active") {
    throw new ConnectorNotConfiguredError(tenantId, type, `status ${row.status}`);
  }
  if (!row.credentialsRef.startsWith(`connector/${tenantId}/`)) {
    throw new ConnectorNotConfiguredError(tenantId, type, "credentials ref outside tenant namespace");
  }
  const provider = options.secretProvider ?? defaultProvider();
  const raw = await provider.get(row.credentialsRef);
  if (!raw) {
    throw new ConnectorNotConfiguredError(tenantId, type, `secret "${row.credentialsRef}" missing`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ConnectorNotConfiguredError(tenantId, type, "credentials secret is not valid JSON");
  }
}

export async function getPennylaneClient(
  tenantId: string,
  options: RegistryOptions = {},
): Promise<PennylaneClient> {
  const credentials = PennylaneCredentials.parse(
    await resolveCredentials(tenantId, "pennylane", options),
  );
  return new PennylaneClient(credentials, options.pennylaneBaseUrl);
}

export async function getQontoClient(
  tenantId: string,
  options: RegistryOptions = {},
): Promise<QontoClient> {
  const credentials = QontoCredentials.parse(await resolveCredentials(tenantId, "qonto", options));
  return new QontoClient(credentials, options.qontoBaseUrl);
}
