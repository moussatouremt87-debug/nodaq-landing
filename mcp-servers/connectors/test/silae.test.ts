import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SilaeClient, SilaeCredentials } from "../src/silae.js";

/** Fake Silae middleware API: records requests, serves canned fixtures. No real API is hit. */

interface Recorded {
  path: string;
  authorization: string | undefined;
  dossierId: string | undefined;
}

const recorded: Recorded[] = [];
let failuresLeft = 0;
let employeesPayload: unknown = {
  items: [
    { id: "emp-1", first_name: "Karim", last_name: "Haddad", weekly_hours: 35, active: true },
  ],
  next_cursor: null,
};
let absencesPayload: unknown = {
  items: [
    {
      id: "abs-1",
      employee_id: "emp-1",
      type: "maladie",
      start_date: "2026-07-10",
      end_date: "2026-07-11",
    },
  ],
  next_cursor: null,
};

const fake = createServer((req, res) => {
  recorded.push({
    path: req.url ?? "",
    authorization: req.headers.authorization,
    dossierId: req.headers["x-dossier-id"] as string | undefined,
  });
  if (failuresLeft > 0) {
    failuresLeft--;
    res.writeHead(503).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  const path = req.url ?? "";
  if (path.startsWith("/employees")) {
    res.end(JSON.stringify(employeesPayload));
  } else if (path.startsWith("/absences")) {
    res.end(JSON.stringify(absencesPayload));
  } else {
    res.end("{}");
  }
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
  failuresLeft = 0;
  employeesPayload = {
    items: [
      { id: "emp-1", first_name: "Karim", last_name: "Haddad", weekly_hours: 35, active: true },
    ],
    next_cursor: null,
  };
  absencesPayload = {
    items: [
      {
        id: "abs-1",
        employee_id: "emp-1",
        type: "maladie",
        start_date: "2026-07-10",
        end_date: "2026-07-11",
      },
    ],
    next_cursor: null,
  };
});

function client() {
  return new SilaeClient({ apiKey: "silae-api-key-1234", dossierId: "dossier-42" }, baseUrl);
}

describe("SilaeCredentials", () => {
  it("accepts a well-formed credentials pair", () => {
    expect(() => SilaeCredentials.parse({ apiKey: "abcdefgh", dossierId: "d1" })).not.toThrow();
  });

  it("rejects an apiKey shorter than 8 chars", () => {
    expect(() => SilaeCredentials.parse({ apiKey: "short", dossierId: "d1" })).toThrow();
  });

  it("rejects a missing dossierId", () => {
    expect(() => SilaeCredentials.parse({ apiKey: "abcdefgh" })).toThrow();
  });

  it("is strict: rejects unknown fields", () => {
    expect(() =>
      SilaeCredentials.parse({ apiKey: "abcdefgh", dossierId: "d1", extra: "nope" }),
    ).toThrow();
  });
});

describe("SilaeClient", () => {
  it("sends the Bearer key and the X-Dossier-Id header on listEmployees", async () => {
    await client().listEmployees();
    expect(recorded[0]).toMatchObject({
      authorization: "Bearer silae-api-key-1234",
      dossierId: "dossier-42",
    });
    expect(recorded[0]?.path).toContain("/employees");
  });

  it("parses employees, stripping unknown fields", async () => {
    employeesPayload = {
      items: [
        {
          id: "emp-1",
          first_name: "Karim",
          last_name: "Haddad",
          weekly_hours: 35,
          active: true,
          // Extra field MUST be stripped by the client (data minimization):
          salary_gross_cents: 250_000,
        },
      ],
      next_cursor: null,
    };
    const { items } = await client().listEmployees();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "emp-1", first_name: "Karim", weekly_hours: 35 });
    expect(JSON.stringify(items)).not.toContain("salary_gross_cents");
  });

  it("ignores a malformed employee row instead of throwing (per-item tolerant parsing)", async () => {
    employeesPayload = {
      items: [
        { id: "emp-1", first_name: "Karim", last_name: "Haddad", weekly_hours: 35, active: true },
        // Missing required `id` -> dropped silently, never an exception.
        { first_name: "Sans Id" },
        "not even an object",
        null,
      ],
      next_cursor: null,
    };
    const { items } = await client().listEmployees();
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("emp-1");
  });

  it("supports pagination via cursor", async () => {
    employeesPayload = { items: [{ id: "emp-2" }], next_cursor: "next-page-token" };
    const { next_cursor } = await client().listEmployees({ limit: 1 });
    expect(next_cursor).toBe("next-page-token");
    await client().listEmployees({ cursor: "next-page-token" });
    expect(recorded[1]?.path).toContain("cursor=next-page-token");
  });

  it("sends from/to as query params on listAbsences", async () => {
    await client().listAbsences({ from: "2026-07-01", to: "2026-07-31" });
    expect(recorded[0]?.path).toContain("from=2026-07-01");
    expect(recorded[0]?.path).toContain("to=2026-07-31");
  });

  it("parses absences, stripping unknown fields", async () => {
    absencesPayload = {
      items: [
        {
          id: "abs-1",
          employee_id: "emp-1",
          type: "conges_payes",
          start_date: "2026-07-30",
          end_date: "2026-08-03",
          approved_by: "should be stripped",
        },
      ],
      next_cursor: null,
    };
    const { items } = await client().listAbsences();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "abs-1",
      employee_id: "emp-1",
      start_date: "2026-07-30",
      end_date: "2026-08-03",
    });
    expect(JSON.stringify(items)).not.toContain("approved_by");
  });

  it("ignores a malformed absence row instead of throwing", async () => {
    absencesPayload = {
      items: [
        {
          id: "abs-1",
          employee_id: "emp-1",
          type: "maladie",
          start_date: "2026-07-10",
          end_date: "2026-07-11",
        },
        // Missing required `end_date` -> dropped silently.
        { id: "abs-2", employee_id: "emp-2", start_date: "2026-07-15" },
      ],
      next_cursor: null,
    };
    const { items } = await client().listAbsences();
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("abs-1");
  });

  it("retries once on 5xx then succeeds", async () => {
    failuresLeft = 1;
    const { items } = await client().listEmployees();
    expect(items).toHaveLength(1);
    expect(recorded).toHaveLength(2);
  });

  it("gives up after retries with a status-only error (no credentials/body leakage)", async () => {
    failuresLeft = 5;
    let message = "";
    try {
      await client().listEmployees();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/HTTP 503 on \/employees/);
    expect(message).not.toContain("silae-api-key-1234");
    expect(message).not.toContain("dossier-42");
  });

  it("testConnection succeeds via listEmployees({ limit: 1 }), response discarded", async () => {
    await expect(client().testConnection()).resolves.toBeUndefined();
    expect(recorded[0]?.path).toContain("limit=1");
  });

  it("testConnection fails cleanly on error (no credentials leaked)", async () => {
    failuresLeft = 5;
    let message = "";
    try {
      await client().testConnection();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("silae-api-key-1234");
    expect(message).not.toContain("dossier-42");
  });
});
