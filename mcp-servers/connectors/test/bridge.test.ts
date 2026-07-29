import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BridgeClient } from "../src/bridge.js";

/** Fake Bridge API: records requests, serves canned fixtures. No real API is hit. */

interface Recorded {
  path: string;
  method: string | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
  bridgeVersion: string | undefined;
  authorization: string | undefined;
  body: string;
}

const recorded: Recorded[] = [];
let tokenCalls = 0;
let failNextTokenWith401 = false;
let failNextAccountsWith401 = false;

const fake = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    recorded.push({
      path: req.url ?? "",
      method: req.method,
      clientId: req.headers["client-id"] as string | undefined,
      clientSecret: req.headers["client-secret"] as string | undefined,
      bridgeVersion: req.headers["bridge-version"] as string | undefined,
      authorization: req.headers.authorization,
      body,
    });
    const path = req.url ?? "";
    if (path.startsWith("/aggregation/authorization/token")) {
      tokenCalls++;
      if (failNextTokenWith401) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid client credentials for user xyz" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "bridge-access-token-abc" }));
      return;
    }
    if (path.startsWith("/aggregation/accounts")) {
      if (failNextAccountsWith401) {
        failNextAccountsWith401 = false;
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "token expired" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          resources: [
            {
              id: 4242,
              name: "Compte courant",
              balance: 1234.56,
              currency_code: "EUR",
              iban: "FR7630006000011234567890189",
              // Extra field MUST be stripped by the client (data minimization):
              loan: { amount: 99999 },
            },
          ],
        }),
      );
      return;
    }
    if (path.startsWith("/aggregation/transactions")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          resources: [
            {
              id: 987,
              clean_description: "Loyer dépôt",
              provider_description: "VIR LOYER DEPOT SCI",
              amount: -1350.5,
              currency_code: "EUR",
              date: "2026-07-20",
              booking_date: "2026-07-21",
              category_id: 42, // stripped
            },
            {
              id: 988,
              clean_description: null,
              provider_description: "SITUATION TRAVAUX CHANTIER A",
              amount: 16800,
              currency_code: "EUR",
              date: "2026-07-18",
              booking_date: null,
            },
          ],
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});

let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});

afterAll(() => {
  fake.close();
});

beforeEach(() => {
  recorded.length = 0;
  tokenCalls = 0;
  failNextTokenWith401 = false;
  failNextAccountsWith401 = false;
});

function client() {
  return new BridgeClient(
    { clientId: "client-abc", clientSecret: "secret-xyz", userUuid: "user-uuid-0001" },
    baseUrl,
  );
}

describe("BridgeClient", () => {
  it("sends Client-Id / Client-Secret / Bridge-Version app headers on the token request", async () => {
    await client().getOrganization();
    const tokenRequest = recorded.find((r) => r.path.startsWith("/aggregation/authorization/token"));
    expect(tokenRequest).toMatchObject({
      method: "POST",
      clientId: "client-abc",
      clientSecret: "secret-xyz",
      bridgeVersion: "2025-01-15",
    });
    expect(JSON.parse(tokenRequest?.body ?? "{}")).toEqual({ user_uuid: "user-uuid-0001" });
  });

  it("sends the Bearer token (plus app headers) on subsequent calls", async () => {
    await client().getOrganization();
    const accountsRequest = recorded.find((r) => r.path.startsWith("/aggregation/accounts"));
    expect(accountsRequest).toMatchObject({
      authorization: "Bearer bridge-access-token-abc",
      clientId: "client-abc",
      clientSecret: "secret-xyz",
      bridgeVersion: "2025-01-15",
    });
  });

  it("requests the token once then reuses it (cache) across getOrganization + listTransactions", async () => {
    const c = client();
    await c.getOrganization();
    await c.listTransactions();
    expect(tokenCalls).toBe(1);
  });

  it("maps accounts to bank_accounts: euros -> cents (rounded), strips unknown fields", async () => {
    const { organization } = await client().getOrganization();
    // Le slug est une empreinte OPAQUE : jamais un fragment du userUuid (qui
    // fait partie du bundle d'identifiants du coffre) vers le contexte modèle.
    expect(organization.slug).toMatch(/^bridge-[0-9a-f]{8}$/);
    expect(organization.slug).not.toContain("user-uui");
    expect(organization.bank_accounts).toHaveLength(1);
    expect(organization.bank_accounts[0]).toMatchObject({
      slug: "4242",
      iban: "FR7630006000011234567890189",
      currency: "EUR",
      balance_cents: 123456,
      // Bridge ne fournit pas le solde autorisé : null, jamais une copie.
      authorized_balance_cents: null,
    });
    expect(JSON.stringify(organization)).not.toContain("loan");
  });

  it("maps transactions to the Qonto shape: negative -> debit, date-only -> ISO, strips unknown fields", async () => {
    const { transactions, meta } = await client().listTransactions({ perPage: 10 });
    expect(transactions).toHaveLength(2);
    expect(transactions[0]).toMatchObject({
      transaction_id: "987",
      id: "987",
      amount_cents: 135050,
      currency: "EUR",
      side: "debit",
      operation_type: null,
      settled_at: "2026-07-21T00:00:00Z", // booking_date wins over date
      label: "Loyer dépôt", // clean_description wins
    });
    expect(transactions[1]).toMatchObject({
      transaction_id: "988",
      amount_cents: 1680000,
      side: "credit",
      settled_at: "2026-07-18T00:00:00Z", // no booking_date -> falls back to date
      label: "SITUATION TRAVAUX CHANTIER A", // clean_description null -> provider_description
    });
    expect(meta).toEqual({ current_page: 1, total_pages: 1 });
    expect(JSON.stringify(transactions)).not.toContain("category_id");
  });

  it("sends the requested limit as the `limit` query param", async () => {
    await client().listTransactions({ perPage: 50 });
    const txRequest = recorded.find((r) => r.path.startsWith("/aggregation/transactions"));
    expect(txRequest?.path).toContain("limit=50");
  });

  it("scope compte OBLIGATOIRE : account_id envoyé (défaut = premier compte, filtre slug/iban résolu)", async () => {
    // Un user Bridge peut agréger des comptes perso/épargne : jamais « tous ».
    await client().listTransactions();
    let txRequest = recorded.find((r) => r.path.startsWith("/aggregation/transactions"));
    expect(txRequest?.path).toContain("account_id=4242");

    recorded.length = 0;
    await client().listTransactions({ iban: "FR7630006000011234567890189" });
    txRequest = recorded.find((r) => r.path.startsWith("/aggregation/transactions"));
    expect(txRequest?.path).toContain("account_id=4242");

    // Filtre demandé mais introuvable => échec FERMÉ, aucune transaction lue.
    recorded.length = 0;
    await expect(client().listTransactions({ accountSlug: "9999" })).rejects.toThrow(
      "unknown bank account",
    );
    expect(recorded.some((r) => r.path.startsWith("/aggregation/transactions"))).toBe(false);
  });

  it("page > 1 => liste VIDE (une seule page annoncée), jamais une re-livraison", async () => {
    const { transactions, meta } = await client().listTransactions({ page: 2 });
    expect(transactions).toEqual([]);
    expect(meta).toEqual({ current_page: 2, total_pages: 1 });
  });

  it("401 sur une ressource => token invalidé et UN rejeu (puis succès)", async () => {
    failNextAccountsWith401 = true;
    const { organization } = await client().getOrganization();
    expect(organization.bank_accounts).toHaveLength(1);
    expect(tokenCalls).toBe(2); // token initial + token du rejeu
  });

  it("testConnection fails cleanly on a 401, with a generic message (no credentials leaked)", async () => {
    failNextTokenWith401 = true;
    const c = client();
    await expect(c.testConnection()).rejects.toThrow(/HTTP 401/);
    let message = "";
    try {
      await c.testConnection();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("secret-xyz");
    expect(message).not.toContain("client-abc");
    expect(message).not.toContain("user-uuid-0001");
    expect(message).not.toContain("invalid client credentials");
  });

  it("testConnection succeeds by obtaining a token then listing accounts", async () => {
    await expect(client().testConnection()).resolves.toBeUndefined();
  });
});
