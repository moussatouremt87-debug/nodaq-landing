import { EnvSecretProvider, FileSecretProvider, ScalewaySecretProvider } from "./providers.js";
import type { SecretProvider, WritableSecretProvider } from "./providers.js";

export { EnvSecretProvider, FileSecretProvider, ScalewaySecretProvider } from "./providers.js";
export type {
  SecretProvider,
  WritableSecretProvider,
  ScalewayProviderOptions,
} from "./providers.js";

export interface SecretSpec {
  /** Secret / env variable name, e.g. "AUTH_SECRET". */
  name: string;
  /** Loading fails if a required secret is missing. Defaults to true. */
  required?: boolean;
}

/**
 * Picks the provider from the environment:
 * - SCW_SECRET_KEY set (staging/prod) -> Scaleway Secret Manager (FR-PAR),
 *   secret names prefixed by SCW_SECRET_PREFIX (e.g. "nodaq-prod-").
 * - otherwise (dev/CI) -> process.env, populated by the gitignored .env files.
 * In production the Scaleway provider is mandatory: refusing to boot beats
 * silently falling back to plaintext env secrets.
 */
export function defaultProvider(env: NodeJS.ProcessEnv = process.env): SecretProvider {
  const scwKey = env.SCW_SECRET_KEY;
  if (scwKey) {
    return new ScalewaySecretProvider({
      secretKey: scwKey,
      region: env.SCW_DEFAULT_REGION ?? "fr-par",
      prefix: env.SCW_SECRET_PREFIX ?? "",
      // Scope name lookups to OUR project: an IAM key whose default project
      // differs would otherwise resolve nothing (missing required secrets).
      ...(env.SCW_DEFAULT_PROJECT_ID ? { projectId: env.SCW_DEFAULT_PROJECT_ID } : {}),
      ...(env.SCW_API_URL ? { baseUrl: env.SCW_API_URL } : {}),
    });
  }
  if (env.NODE_ENV === "production") {
    throw new Error("production requires Scaleway Secret Manager (SCW_SECRET_KEY missing)");
  }
  return new EnvSecretProvider(env);
}

/**
 * Writable vault for per-tenant connector credentials (ticket 1.8):
 * - SCW_SECRET_KEY set -> Scaleway Secret Manager (writes need
 *   SCW_DEFAULT_PROJECT_ID) ;
 * - production without Scaleway -> refuse to boot (same rule as reads) ;
 * - dev/CI -> FileSecretProvider on DEV_VAULT_PATH (gitignored JSON, 0600).
 */
export function defaultWritableProvider(
  env: NodeJS.ProcessEnv = process.env,
): WritableSecretProvider {
  const scwKey = env.SCW_SECRET_KEY;
  if (scwKey) {
    return new ScalewaySecretProvider({
      secretKey: scwKey,
      region: env.SCW_DEFAULT_REGION ?? "fr-par",
      prefix: env.SCW_SECRET_PREFIX ?? "",
      ...(env.SCW_DEFAULT_PROJECT_ID ? { projectId: env.SCW_DEFAULT_PROJECT_ID } : {}),
      ...(env.SCW_API_URL ? { baseUrl: env.SCW_API_URL } : {}),
    });
  }
  if (env.NODE_ENV === "production") {
    throw new Error("production requires Scaleway Secret Manager (SCW_SECRET_KEY missing)");
  }
  return new FileSecretProvider(env.DEV_VAULT_PATH ?? ".dev-vault.json");
}

/** Loads the requested secrets. Throws listing every missing required NAME (never a value). */
export async function loadSecrets(
  specs: SecretSpec[],
  provider: SecretProvider = defaultProvider(),
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    specs.map(async (spec) => [spec.name, await provider.get(spec.name)] as const),
  );
  const missing = specs.filter((spec, i) => spec.required !== false && entries[i]![1] === undefined);
  if (missing.length > 0) {
    throw new Error(`missing required secrets: ${missing.map((s) => s.name).join(", ")}`);
  }
  return Object.fromEntries(entries.filter(([, v]) => v !== undefined)) as Record<string, string>;
}

/**
 * Loads secrets and injects them into process.env WITHOUT overwriting values
 * already set (explicit env always wins — useful in CI and for local overrides).
 * Call this at the very start of a service, BEFORE importing any module that
 * reads process.env at import time (e.g. @nodaq/db).
 */
export async function injectSecrets(
  specs: SecretSpec[],
  provider: SecretProvider = defaultProvider(),
): Promise<void> {
  const toLoad = specs.filter((spec) => process.env[spec.name] === undefined);
  const loaded = await loadSecrets(toLoad, provider);
  for (const [name, value] of Object.entries(loaded)) {
    process.env[name] = value;
  }
}
