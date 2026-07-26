import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EnvSecretProvider,
  FileSecretProvider,
  ScalewaySecretProvider,
  defaultProvider,
  defaultWritableProvider,
  injectSecrets,
  loadSecrets,
} from "../src/index.js";

describe("EnvSecretProvider", () => {
  it("reads from the given env and returns undefined for unknown names", async () => {
    const provider = new EnvSecretProvider({ MY_SECRET: "value-1" } as NodeJS.ProcessEnv);
    expect(await provider.get("MY_SECRET")).toBe("value-1");
    expect(await provider.get("NOPE")).toBeUndefined();
  });
});

describe("loadSecrets", () => {
  const provider = new EnvSecretProvider({ A: "1", B: "2" } as NodeJS.ProcessEnv);

  it("returns all requested secrets", async () => {
    await expect(loadSecrets([{ name: "A" }, { name: "B" }], provider)).resolves.toEqual({
      A: "1",
      B: "2",
    });
  });

  it("throws listing every missing REQUIRED name (and only names)", async () => {
    await expect(
      loadSecrets([{ name: "A" }, { name: "X" }, { name: "Y" }], provider),
    ).rejects.toThrow(/missing required secrets: X, Y/);
  });

  it("tolerates missing optional secrets", async () => {
    await expect(
      loadSecrets([{ name: "A" }, { name: "X", required: false }], provider),
    ).resolves.toEqual({ A: "1" });
  });
});

describe("injectSecrets", () => {
  it("injects into process.env without overwriting explicit values", async () => {
    process.env.INJ_KEEP = "explicit";
    delete process.env.INJ_NEW;
    const provider = new EnvSecretProvider({
      INJ_KEEP: "from-vault",
      INJ_NEW: "loaded",
    } as NodeJS.ProcessEnv);
    await injectSecrets([{ name: "INJ_KEEP" }, { name: "INJ_NEW" }], provider);
    expect(process.env.INJ_KEEP).toBe("explicit");
    expect(process.env.INJ_NEW).toBe("loaded");
    delete process.env.INJ_KEEP;
    delete process.env.INJ_NEW;
  });
});

describe("ScalewaySecretProvider (fake Secret Manager server)", () => {
  const vault: Record<string, string> = {
    "nodaq-test-AUTH_SECRET": "s3cret-from-vault",
  };
  let baseUrl: string;
  let lastReadUrl = "";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    lastReadUrl = url.pathname + url.search;
    if (req.headers["x-auth-token"] !== "scw-key-ok") {
      res.writeHead(401).end(JSON.stringify({ message: "unauthorized" }));
      return;
    }
    const name = url.searchParams.get("secret_name") ?? "";
    const value = vault[name];
    if (!value) {
      res.writeHead(404).end(JSON.stringify({ message: "not found" }));
      return;
    }
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ data: Buffer.from(value, "utf8").toString("base64") }));
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("fetches and decodes a secret by prefixed name", async () => {
    const provider = new ScalewaySecretProvider({
      secretKey: "scw-key-ok",
      prefix: "nodaq-test-",
      baseUrl,
    });
    expect(await provider.get("AUTH_SECRET")).toBe("s3cret-from-vault");
  });

  it("returns undefined on 404 and throws on other HTTP errors", async () => {
    const ok = new ScalewaySecretProvider({
      secretKey: "scw-key-ok",
      prefix: "nodaq-test-",
      baseUrl,
    });
    expect(await ok.get("UNKNOWN")).toBeUndefined();

    const badKey = new ScalewaySecretProvider({ secretKey: "wrong", baseUrl });
    await expect(badKey.get("AUTH_SECRET")).rejects.toThrow(/HTTP 401/);
  });

  it("scopes reads to the project when configured (project_id in the query)", async () => {
    const provider = new ScalewaySecretProvider({
      secretKey: "scw-key-ok",
      prefix: "nodaq-test-",
      projectId: "proj-42",
      baseUrl,
    });
    expect(await provider.get("AUTH_SECRET")).toBe("s3cret-from-vault");
    expect(lastReadUrl).toContain("project_id=proj-42");
  });

  it("defaultProvider passes SCW_DEFAULT_PROJECT_ID down to reads", async () => {
    const provider = defaultProvider({
      SCW_SECRET_KEY: "scw-key-ok",
      SCW_SECRET_PREFIX: "nodaq-test-",
      SCW_DEFAULT_PROJECT_ID: "proj-42",
      SCW_API_URL: baseUrl,
    } as NodeJS.ProcessEnv);
    expect(await provider.get("AUTH_SECRET")).toBe("s3cret-from-vault");
    expect(lastReadUrl).toContain("project_id=proj-42");
  });

  it("end to end: loadSecrets through the Scaleway provider", async () => {
    const provider = new ScalewaySecretProvider({
      secretKey: "scw-key-ok",
      prefix: "nodaq-test-",
      baseUrl,
    });
    await expect(loadSecrets([{ name: "AUTH_SECRET" }], provider)).resolves.toEqual({
      AUTH_SECRET: "s3cret-from-vault",
    });
  });
});

describe("FileSecretProvider (dev vault)", () => {
  it("set/get/delete round-trip on a 0600 JSON file", async () => {
    const { mkdtemp, stat } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "vault-"));
    const path = join(dir, "vault.json");
    const provider = new FileSecretProvider(path);

    expect(await provider.get("connector/t1/qonto")).toBeUndefined();
    await provider.set("connector/t1/qonto", JSON.stringify({ secretKey: "sk" }));
    expect(await provider.get("connector/t1/qonto")).toBe(JSON.stringify({ secretKey: "sk" }));

    // Owner-only file: credentials must not be world-readable, even in dev.
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    await provider.delete("connector/t1/qonto");
    expect(await provider.get("connector/t1/qonto")).toBeUndefined();
    await provider.delete("connector/t1/qonto"); // deleting a missing key is a no-op
  });
});

describe("ScalewaySecretProvider — writes (fake Secret Manager server)", () => {
  interface StoredSecret {
    id: string;
    name: string;
    value?: string;
  }
  const secrets = new Map<string, StoredSecret>();
  let nextId = 1;
  let writeBase: string;

  const writeServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const json = (code: number, body: unknown): void => {
        res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
      };
      const versionMatch = url.pathname.match(/\/secrets\/([^/]+)\/versions$/);
      const secretMatch = url.pathname.match(/\/secrets\/([^/]+)$/);
      if (req.method === "GET" && url.pathname.endsWith("/secrets")) {
        const name = url.searchParams.get("name");
        const list = [...secrets.values()].filter((s) => s.name === name);
        json(200, { secrets: list.map(({ id, name: n }) => ({ id, name: n })) });
      } else if (req.method === "POST" && url.pathname.endsWith("/secrets")) {
        const body = JSON.parse(raw) as { project_id?: string; name: string };
        if (!body.project_id) return json(400, { message: "project_id required" });
        const secret = { id: `id-${nextId++}`, name: body.name };
        secrets.set(secret.id, secret);
        json(200, secret);
      } else if (req.method === "POST" && versionMatch) {
        const secret = secrets.get(versionMatch[1]!);
        if (!secret) return json(404, {});
        secret.value = Buffer.from((JSON.parse(raw) as { data: string }).data, "base64").toString(
          "utf8",
        );
        json(200, { revision: 1 });
      } else if (req.method === "DELETE" && secretMatch) {
        secrets.delete(secretMatch[1]!);
        json(204, {});
      } else {
        json(500, { message: "unexpected route" });
      }
    });
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => writeServer.listen(0, "127.0.0.1", resolve));
    writeBase = `http://127.0.0.1:${(writeServer.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    writeServer.close();
  });

  it("set creates the secret then pushes a version; delete removes it", async () => {
    const provider = new ScalewaySecretProvider({
      secretKey: "scw-key-ok",
      prefix: "nodaq-test-",
      projectId: "proj-1",
      baseUrl: writeBase,
    });
    await provider.set("connector/t1/qonto", "credentials-json");
    const stored = [...secrets.values()].find((s) => s.name === "nodaq-test-connector-t1-qonto");
    expect(stored?.value).toBe("credentials-json");

    // Second set = new version on the SAME secret (no duplicate creation).
    await provider.set("connector/t1/qonto", "rotated");
    expect([...secrets.values()].filter((s) => s.name === "nodaq-test-connector-t1-qonto")).toHaveLength(1);

    await provider.delete("connector/t1/qonto");
    expect([...secrets.values()].find((s) => s.name === "nodaq-test-connector-t1-qonto")).toBeUndefined();
    await provider.delete("connector/t1/qonto"); // missing -> no-op
  });

  it("refuses to CREATE without projectId (name-only error)", async () => {
    const provider = new ScalewaySecretProvider({ secretKey: "scw-key-ok", baseUrl: writeBase });
    await expect(provider.set("brand-new", "v")).rejects.toThrow(/projectId/);
  });
});

describe("defaultWritableProvider", () => {
  it("Scaleway when configured, file vault in dev, refusal in production", () => {
    expect(
      defaultWritableProvider({ SCW_SECRET_KEY: "k" } as NodeJS.ProcessEnv),
    ).toBeInstanceOf(ScalewaySecretProvider);
    expect(defaultWritableProvider({} as NodeJS.ProcessEnv)).toBeInstanceOf(FileSecretProvider);
    expect(() =>
      defaultWritableProvider({ NODE_ENV: "production" } as NodeJS.ProcessEnv),
    ).toThrow(/Secret Manager/);
  });
});

describe("defaultProvider", () => {
  it("uses Scaleway when SCW_SECRET_KEY is set, env otherwise", () => {
    expect(
      defaultProvider({ SCW_SECRET_KEY: "k" } as NodeJS.ProcessEnv),
    ).toBeInstanceOf(ScalewaySecretProvider);
    expect(defaultProvider({} as NodeJS.ProcessEnv)).toBeInstanceOf(EnvSecretProvider);
  });

  it("refuses to boot in production without the vault", () => {
    expect(() => defaultProvider({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(
      /Secret Manager/,
    );
  });
});
