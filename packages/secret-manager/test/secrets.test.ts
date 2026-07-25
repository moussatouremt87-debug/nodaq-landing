import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EnvSecretProvider,
  ScalewaySecretProvider,
  defaultProvider,
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
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
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
