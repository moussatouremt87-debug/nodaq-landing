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

/**
 * Writable vault (ticket 1.8) — used to STORE per-tenant connector
 * credentials (`connector/<tenantId>/<type>`), never to read app secrets at
 * boot. Deleting a missing secret is a no-op, not an error.
 */
export interface WritableSecretProvider extends SecretProvider {
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
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
  /** Scaleway project — required only for set()/delete() (writes). */
  projectId?: string;
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
export class ScalewaySecretProvider implements WritableSecretProvider {
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

  private root(): string {
    return `${this.baseUrl}/secret-manager/v1beta1/regions/${this.region}`;
  }

  private headers(): Record<string, string> {
    return { "X-Auth-Token": this.options.secretKey, "content-type": "application/json" };
  }

  /**
   * Vault name for a logical secret. Scaleway secret NAMES reject `/` (it
   * belongs to the separate `path` field), but our connector refs are
   * `connector/<tenantId>/<type>` — normalized to `-` symmetrically across
   * get/set/delete, so the mapping stays bijective for our name shapes.
   */
  private fullName(name: string): string {
    return (this.prefix + name).replaceAll("/", "-");
  }

  async get(name: string): Promise<string | undefined> {
    const url =
      `${this.root()}/secrets-by-path/versions/latest/access` +
      `?secret_name=${encodeURIComponent(this.fullName(name))}`;
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

  /**
   * Finds the vault id of a secret by (exact) name, or undefined. Paginates:
   * the Scaleway `name` filter can match more than one page, and a missed id
   * would turn delete() into a silent no-op (credentials surviving deletion).
   */
  private async findSecretId(fullName: string): Promise<string | undefined> {
    const pageSize = 50;
    for (let page = 1; ; page++) {
      const url =
        `${this.root()}/secrets?name=${encodeURIComponent(fullName)}` +
        `&page=${page}&page_size=${pageSize}`;
      const response = await this.fetchFn(url, { headers: this.headers() });
      if (!response.ok) {
        throw new Error(`Secret Manager list error for "${fullName}": HTTP ${response.status}`);
      }
      const body = (await response.json()) as { secrets?: { id: string; name: string }[] };
      const secrets = body.secrets ?? [];
      const match = secrets.find((secret) => secret.name === fullName);
      if (match) return match.id;
      if (secrets.length < pageSize) return undefined; // last page reached
    }
  }

  async set(name: string, value: string): Promise<void> {
    const fullName = this.fullName(name);
    let id = await this.findSecretId(fullName);
    if (!id) {
      if (!this.options.projectId) {
        throw new Error("Secret Manager writes require projectId (SCW_DEFAULT_PROJECT_ID)");
      }
      const response = await this.fetchFn(`${this.root()}/secrets`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ project_id: this.options.projectId, name: fullName }),
      });
      if (!response.ok) {
        throw new Error(`Secret Manager create error for "${name}": HTTP ${response.status}`);
      }
      id = ((await response.json()) as { id: string }).id;
    }
    const version = await this.fetchFn(`${this.root()}/secrets/${id}/versions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ data: Buffer.from(value, "utf8").toString("base64") }),
    });
    if (!version.ok) {
      await version.body?.cancel();
      throw new Error(`Secret Manager version error for "${name}": HTTP ${version.status}`);
    }
    await version.body?.cancel();
  }

  async delete(name: string): Promise<void> {
    const id = await this.findSecretId(this.fullName(name));
    if (!id) return;
    const response = await this.fetchFn(`${this.root()}/secrets/${id}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Secret Manager delete error for "${name}": HTTP ${response.status}`);
    }
    await response.body?.cancel();
  }
}

/**
 * Dev/CI writable vault: one JSON file, chmod 0600, path from DEV_VAULT_PATH
 * (gitignored — never a real production store; production REQUIRES Scaleway).
 * Values are read from disk on every call: several processes (API, tests)
 * share the same file.
 */
export class FileSecretProvider implements WritableSecretProvider {
  constructor(private readonly path: string) {
    // Same fail-closed rule as the factories: plaintext-on-disk is a DEV
    // vault, full stop — production must go through Scaleway.
    if (process.env.NODE_ENV === "production") {
      throw new Error("FileSecretProvider is dev-only: production requires Secret Manager");
    }
  }

  private async load(): Promise<Record<string, string>> {
    const { readFile } = await import("node:fs/promises");
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      // ONLY a missing file means an empty vault; any other failure (EACCES,
      // corruption…) must NOT lead to silently rewriting everyone's entries.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    return JSON.parse(raw) as Record<string, string>;
  }

  private async save(entries: Record<string, string>): Promise<void> {
    const { writeFile, chmod, rename } = await import("node:fs/promises");
    // Unique tmp name (the file is shared between processes) + rename, so a
    // crash never leaves a half-written vault — and the tmp still matches the
    // gitignore pattern (.dev-vault.json*).
    const tmp = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(entries), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }

  async get(name: string): Promise<string | undefined> {
    return (await this.load())[name];
  }

  async set(name: string, value: string): Promise<void> {
    const entries = await this.load();
    entries[name] = value;
    await this.save(entries);
  }

  async delete(name: string): Promise<void> {
    const entries = await this.load();
    if (!(name in entries)) return;
    delete entries[name];
    await this.save(entries);
  }
}
