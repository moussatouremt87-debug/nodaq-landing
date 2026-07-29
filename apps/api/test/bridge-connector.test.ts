import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@nodaq/db";
import { buildApp } from "../src/app.js";

/*
 * Onboarding du connecteur Bridge (ticket 2.15, agrégateur DSP2) : les
 * identifiants sont TESTÉS contre le fournisseur (faux serveur ici) avant
 * d'entrer au coffre, jamais renvoyés, et le connecteur apparaît "active".
 */

const GOOD = { clientId: "client-abc", clientSecret: "sk-bridge-123", userUuid: "user-uuid-1" };

const fakeBridge = createServer((req, res) => {
  const authorized =
    req.headers["client-id"] === GOOD.clientId &&
    req.headers["client-secret"] === GOOD.clientSecret;
  if (!authorized) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "unauthorized" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  if ((req.url ?? "").includes("/authorization/token")) {
    res.end(JSON.stringify({ access_token: "tok-1" }));
  } else {
    res.end(
      JSON.stringify({
        resources: [{ id: 42, name: "Compte courant", balance: 1234.56, currency_code: "EUR" }],
      }),
    );
  }
});

let app: FastifyInstance;
let ownerCookie: string;
const vaultStore = new Map<string, string>();
const RUN = Date.now().toString(36);

function cookiesOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.map((c) => String(c).split(";")[0]).join("; ");
}

beforeAll(async () => {
  await new Promise<void>((resolve) => fakeBridge.listen(0, "127.0.0.1", resolve));
  app = buildApp({
    vault: {
      get: (name) => Promise.resolve(vaultStore.get(name)),
      set: (name, value) => {
        vaultStore.set(name, value);
        return Promise.resolve();
      },
      delete: (name) => {
        vaultStore.delete(name);
        return Promise.resolve();
      },
    },
    agentContext: {
      bridgeBaseUrl: `http://127.0.0.1:${(fakeBridge.address() as AddressInfo).port}`,
    },
  });
  await app.ready();

  const signup = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: {
      email: `bridge-owner-${RUN}@example.com`,
      password: "a-strong-password-123",
      name: "Bridge Owner",
    },
  });
  expect(signup.statusCode).toBe(200);
  ownerCookie = cookiesOf(signup);
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Bridge ${RUN}`, slug: `org-bridge-${RUN}` },
  });
  expect(org.statusCode).toBe(200);
}, 60_000);

afterAll(async () => {
  fakeBridge.close();
  await app.close();
  await prisma.$disconnect();
});

describe("POST /connectors (bridge)", () => {
  it("422 quand le test de connexion échoue — rien n'entre au coffre", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/connectors",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: { type: "bridge", credentials: { ...GOOD, clientSecret: "sk-mauvaise-cle" } },
    });
    expect(res.statusCode).toBe(422);
    expect([...vaultStore.keys()].some((k) => k.endsWith("/bridge"))).toBe(false);
  });

  it("identifiants valides : testés contre Bridge, coffre écrit, connecteur active", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/connectors",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: { type: "bridge", credentials: GOOD },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("active");
    // Jamais renvoyés, mais bien au coffre sous l'espace de noms du tenant.
    expect(res.body).not.toContain(GOOD.clientSecret);
    const key = [...vaultStore.keys()].find((k) => k.endsWith("/bridge"));
    expect(key).toBeDefined();

    const list = await app.inject({
      method: "GET",
      url: "/connectors",
      headers: { cookie: ownerCookie },
    });
    const bridge = list.json().connectors.find((c: { type: string }) => c.type === "bridge");
    expect(bridge?.status).toBe("active");
    expect(list.body).not.toContain(GOOD.clientSecret);
  });

  it("champ inconnu dans les identifiants => 400 (.strict())", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/connectors",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: { type: "bridge", credentials: { ...GOOD, extra: "x" } },
    });
    expect(res.statusCode).toBe(400);
  });
});
