import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;
let admin: PrismaClient;

/** Collect cookies from an inject() response into a reusable Cookie header. */
function cookiesOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.map((c) => String(c).split(";")[0]).join("; ");
}

/** Sign up a user (better-auth auto sign-in) and return its session cookie. */
async function signup(email: string, name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: "a-strong-password-123", name },
  });
  expect(res.statusCode).toBe(200);
  return cookiesOf(res);
}

/** Create an organization (becomes the session's active org) and return its id. */
async function createOrg(cookie: string, name: string, slug: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie },
    payload: { name, slug },
  });
  expect(res.statusCode).toBe(200);
  return res.json().id as string;
}

beforeAll(async () => {
  admin = createAdminClient();
  await admin.note.deleteMany();
  await admin.invitation.deleteMany();
  await admin.membership.deleteMany();
  await admin.session.deleteMany();
  await admin.account.deleteMany();
  await admin.user.deleteMany();
  await admin.tenant.deleteMany();
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("GET /health", () => {
  it("returns ok when the database is reachable", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", db: "ok" });
  });
});

describe("authorization chain (requireAuth → resolveTenant → requireMembership)", () => {
  let cookieA: string;
  let cookieB: string;
  let orgA: string;
  let orgB: string;

  it("rejects unauthenticated requests (401)", async () => {
    for (const [method, url] of [
      ["GET", "/notes"],
      ["POST", "/notes"],
      ["GET", "/me"],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode).toBe(401);
    }
  });

  it("sign-up → organization/create sets the active org with role owner", async () => {
    cookieA = await signup("alice@example.com", "Alice");
    orgA = await createOrg(cookieA, "Org Alice", "org-alice");

    const me = await app.inject({ method: "GET", url: "/me", headers: { cookie: cookieA } });
    expect(me.statusCode).toBe(200);
    expect(me.json().activeOrganizationId).toBe(orgA);
    expect(me.json().memberships).toEqual([
      { tenantId: orgA, role: "owner", tenant: { name: "Org Alice", slug: "org-alice" } },
    ]);
  });

  it("resolveTenant: without an active organization, business routes return 400", async () => {
    const cookie = await signup("no-org@example.com", "No Org");
    const res = await app.inject({ method: "GET", url: "/notes", headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/active organization/);
  });

  it("notes are scoped to the session's active organization", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/notes",
      headers: { cookie: cookieA },
      payload: { title: "alice note", body: "content A" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().tenantId).toBe(orgA);

    const list = await app.inject({ method: "GET", url: "/notes", headers: { cookie: cookieA } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
  });

  it("another user in another organization sees nothing", async () => {
    cookieB = await signup("bob@example.com", "Bob");
    orgB = await createOrg(cookieB, "Org Bob", "org-bob");

    const list = await app.inject({ method: "GET", url: "/notes", headers: { cookie: cookieB } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(0);
  });

  it("KEY — set-active on a foreign organization is refused by the plugin (403, fail-closed)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/organization/set-active",
      headers: { cookie: cookieB },
      payload: { organizationId: orgA },
    });
    expect(res.statusCode).toBe(403);

    // Fail-closed: the plugin also resets the active org to null on that attempt.
    const notes = await app.inject({ method: "GET", url: "/notes", headers: { cookie: cookieB } });
    expect(notes.statusCode).toBe(400);

    // Bob re-selects his own org and regains access.
    const back = await app.inject({
      method: "POST",
      url: "/api/auth/organization/set-active",
      headers: { cookie: cookieB },
      payload: { organizationId: orgB },
    });
    expect(back.statusCode).toBe(200);
    const ok = await app.inject({ method: "GET", url: "/notes", headers: { cookie: cookieB } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toHaveLength(0);
  });

  it("KEY — session ≠ authorization: a tampered active org is stopped by requireMembership (403)", async () => {
    // Simulate a stale/forged session: point Bob's session at Alice's org in DB.
    const bobUser = await admin.user.findUniqueOrThrow({ where: { email: "bob@example.com" } });
    await admin.session.updateMany({
      where: { userId: bobUser.id },
      data: { activeOrganizationId: orgA },
    });

    const res = await app.inject({ method: "GET", url: "/notes", headers: { cookie: cookieB } });
    expect(res.statusCode).toBe(403);

    // Restore Bob's legitimate active org.
    await admin.session.updateMany({
      where: { userId: bobUser.id },
      data: { activeOrganizationId: orgB },
    });
  });

  it("the x-tenant-id header is dead: it is ignored entirely", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/notes",
      headers: { cookie: cookieB, "x-tenant-id": orgA },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(0); // still scoped to Bob's own org
  });

  it("sign-in auto-selects the user's organization (session-create hook)", async () => {
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "alice@example.com", password: "a-strong-password-123" },
    });
    expect(signIn.statusCode).toBe(200);
    const freshCookie = cookiesOf(signIn);

    const me = await app.inject({ method: "GET", url: "/me", headers: { cookie: freshCookie } });
    expect(me.json().activeOrganizationId).toBe(orgA);

    const notes = await app.inject({
      method: "GET",
      url: "/notes",
      headers: { cookie: freshCookie },
    });
    expect(notes.statusCode).toBe(200);
    expect(notes.json()).toHaveLength(1);
  });

  it("switching between own organizations via set-active works", async () => {
    const orgB2 = await createOrg(cookieB, "Org Bob 2", "org-bob-2");

    const me = await app.inject({ method: "GET", url: "/me", headers: { cookie: cookieB } });
    expect(me.json().activeOrganizationId).toBe(orgB2);

    const back = await app.inject({
      method: "POST",
      url: "/api/auth/organization/set-active",
      headers: { cookie: cookieB },
      payload: { organizationId: orgB },
    });
    expect(back.statusCode).toBe(200);

    const me2 = await app.inject({ method: "GET", url: "/me", headers: { cookie: cookieB } });
    expect(me2.json().activeOrganizationId).toBe(orgB);
  });

  it("validation queue: human 1-click approval with role gate and state machine", async () => {
    const { withTenant } = await import("@nodaq/db");

    // A member (non-owner) inside Alice's org.
    const cookieM = await signup("membre@example.com", "Membre");
    const memberId = (
      await app.inject({ method: "GET", url: "/me", headers: { cookie: cookieM } })
    ).json().userId as string;
    await admin.membership.create({ data: { tenantId: orgA, userId: memberId, role: "member" } });
    await app.inject({
      method: "POST",
      url: "/api/auth/organization/set-active",
      headers: { cookie: cookieM },
      payload: { organizationId: orgA },
    });

    // An agent prepared two pending actions (simulated).
    const [pa1, pa2] = await withTenant(orgA, async (tx) => [
      await tx.pendingAction.create({
        data: { tenantId: orgA, type: "send_dunning", payload: { draft: "..." } },
      }),
      await tx.pendingAction.create({
        data: { tenantId: orgA, type: "book_invoice", payload: { invoice: {} } },
      }),
    ]);

    // Unauthenticated => 401 on every queue route.
    for (const [method, url] of [
      ["GET", "/pending-actions"],
      ["GET", `/pending-actions/${pa1!.id}`],
      ["POST", `/pending-actions/${pa1!.id}/approve`],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(401);
    }

    // Listing: any member of the tenant sees the queue — METADATA ONLY
    // (payloads carry confidential drafts, reserved to the owner detail).
    const list = await app.inject({
      method: "GET",
      url: "/pending-actions",
      headers: { cookie: cookieM },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((a: { id: string }) => a.id)).toEqual(
      expect.arrayContaining([pa1!.id, pa2!.id]),
    );
    expect(JSON.stringify(list.json())).not.toContain("payload");

    // Detail with payload: OWNER only.
    const memberDetail = await app.inject({
      method: "GET",
      url: `/pending-actions/${pa1!.id}`,
      headers: { cookie: cookieM },
    });
    expect(memberDetail.statusCode).toBe(403);
    const ownerDetail = await app.inject({
      method: "GET",
      url: `/pending-actions/${pa1!.id}`,
      headers: { cookie: cookieA },
    });
    expect(ownerDetail.statusCode).toBe(200);
    expect(ownerDetail.json().payload).toEqual({ draft: "..." });

    // Cross-tenant: Bob's list never contains Alice's queue (RLS).
    const bobList = await app.inject({
      method: "GET",
      url: "/pending-actions",
      headers: { cookie: cookieB },
    });
    expect(bobList.json().map((a: { id: string }) => a.id)).not.toEqual(
      expect.arrayContaining([pa1!.id]),
    );

    // A MEMBER cannot approve (owner-only sensitive action).
    const memberApprove = await app.inject({
      method: "POST",
      url: `/pending-actions/${pa1!.id}/approve`,
      headers: { cookie: cookieM },
    });
    expect(memberApprove.statusCode).toBe(403);

    // The OWNER approves: state machine + human attribution.
    const aliceId = (
      await app.inject({ method: "GET", url: "/me", headers: { cookie: cookieA } })
    ).json().userId as string;
    const approve = await app.inject({
      method: "POST",
      url: `/pending-actions/${pa1!.id}/approve`,
      headers: { cookie: cookieA },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json()).toMatchObject({ status: "approved", validatedBy: aliceId });
    expect(approve.json().validatedAt).toBeTruthy();

    // Double-approve => conflict, the first decision stands.
    const again = await app.inject({
      method: "POST",
      url: `/pending-actions/${pa1!.id}/approve`,
      headers: { cookie: cookieA },
    });
    expect(again.statusCode).toBe(409);

    // Reject path.
    const reject = await app.inject({
      method: "POST",
      url: `/pending-actions/${pa2!.id}/reject`,
      headers: { cookie: cookieA },
    });
    expect(reject.json()).toMatchObject({ status: "rejected", validatedBy: aliceId });

    // Cross-tenant id (Bob's org) => indistinguishable from missing (404, RLS).
    const paB = await withTenant(orgB, (tx) =>
      tx.pendingAction.create({
        data: { tenantId: orgB, type: "send_dunning", payload: {} },
      }),
    );
    const cross = await app.inject({
      method: "POST",
      url: `/pending-actions/${paB.id}/approve`,
      headers: { cookie: cookieA },
    });
    expect(cross.statusCode).toBe(404);

    // Malformed id => 400.
    const bad = await app.inject({
      method: "POST",
      url: "/pending-actions/not-a-uuid/approve",
      headers: { cookie: cookieA },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("rejects an invalid note payload (400)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/notes",
      headers: { cookie: cookieA },
      payload: { title: "" },
    });
    expect(res.statusCode).toBe(400);
  });
});
