/**
 * Secret providers (ticket 0.3). One interface, two implementations:
 * - EnvSecretProvider: dev/CI — reads process.env (populated by gitignored .env).
 * - ScalewaySecretProvider: staging/prod — Scaleway Secret Manager (FR-PAR),
 *   plain REST so we do not pull the full Scaleway SDK for one endpoint.
 * Secrets NEVER get logged; errors carry the secret NAME only, never a value.
 */

export interface SecretProvider {
  /** Returns the secret value, or undefined if the secret does not exist. */
  get(name: string): Promise<string | undefined>;
}

export class EnvSecretProvider implements SecretProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  get(name: string): Promise<string | undefined> {
    return Promise.resolve(this.env[name]);
  }
}

export interface ScalewayProviderOptions {
  secretKey: string;
  region?: string;
  /** Secret name prefix in the vault, e.g. "nodaq-prod-" -> nodaq-prod-AUTH_SECRET. */
  prefix?: string;
  /** Override for tests (fake server). Defaults to the public Scaleway API. */
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

/**
 * Accesses the latest enabled version of a secret by name:
 * GET {base}/secret-manager/v1beta1/regions/{region}/secrets-by-path/versions/latest/access
 *     ?secret_name={prefix}{name}
 * Response: { data: base64 }. 404 -> undefined (caller decides if required).
 */
export class ScalewaySecretProvider implements SecretProvider {
  private readonly region: string;
  private readonly prefix: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: ScalewayProviderOptions) {
    this.region = options.region ?? "fr-par";
    this.prefix = options.prefix ?? "";
    this.baseUrl = options.baseUrl ?? "https://api.scaleway.com";
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async get(name: string): Promise<string | undefined> {
    const url =
      `${this.baseUrl}/secret-manager/v1beta1/regions/${this.region}` +
      `/secrets-by-path/versions/latest/access` +
      `?secret_name=${encodeURIComponent(this.prefix + name)}`;
    const response = await this.fetchFn(url, {
      headers: { "X-Auth-Token": this.options.secretKey },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`Secret Manager error for "${name}": HTTP ${response.status}`);
    }
    const body = (await response.json()) as { data?: string };
    if (typeof body.data !== "string") {
      throw new Error(`Secret Manager returned no data for "${name}"`);
    }
    return Buffer.from(body.data, "base64").toString("utf8");
  }
}
