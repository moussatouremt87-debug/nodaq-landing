import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { verifyPassword } from "better-auth/crypto";
import { prisma } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";

/**
 * Seed démo : rejouable (deux exécutions -> état strictement identique),
 * isolé (aucun autre tenant touché), gardé (refus en production sans flag) et
 * conforme au kit (5 pending_actions, 8 030 € d'impayés relancés, connecteurs
 * en statut "demo").
 */

const API_DIR = fileURLToPath(new URL("..", import.meta.url));
const DEMO_SLUG = "elec-provence-demo";
const PASSWORD = "demo-password-vitest";
const OTHER_TENANT = "Seed Other";

let admin: PrismaClient;
let otherTenantId: string;

function runSeed(env: Record<string, string> = {}): void {
  execFileSync("pnpm", ["exec", "tsx", "src/scripts/seed-demo.ts"], {
    cwd: API_DIR,
    stdio: "pipe",
    env: { ...process.env, DEMO_USER_PASSWORD: PASSWORD, ...env },
  });
}

/**
 * État métier normalisé du tenant démo — sans ids ni timestamps générés.
 *
 * L'ordre est rendu TOTAL côté JS, et c'est le sujet : `orderBy: [{ type }]`
 * ne départage pas trois `send_dunning`, donc Postgres pouvait rendre les
 * mêmes lignes dans un ordre différent d'un seed à l'autre et faire échouer
 * `toEqual` au hasard (issue #64). Un tri partiel dans un test de rejouabilité
 * ne teste pas la rejouabilité : il teste la chance.
 */
function canonical(row: Record<string, unknown>): string {
  return JSON.stringify(row, Object.keys(row).sort());
}

async function snapshot() {
  const tenant = await admin.tenant.findUniqueOrThrow({ where: { slug: DEMO_SLUG } });
  const pendingActions = await admin.pendingAction.findMany({
    where: { tenantId: tenant.id },
    select: { type: true, status: true, employee: true, payload: true },
  });
  const connectors = await admin.connector.findMany({
    where: { tenantId: tenant.id },
    select: { type: true, status: true, credentialsRef: true },
  });
  return {
    name: tenant.name,
    // Tri sur le CONTENU entier : deux lignes identiques sont interchangeables,
    // deux lignes différentes sont toujours ordonnées de la même façon.
    pendingActions: [...pendingActions].sort((a, b) => canonical(a).localeCompare(canonical(b))),
    connectors: [...connectors].sort((a, b) => canonical(a).localeCompare(canonical(b))),
  };
}

beforeAll(async () => {
  admin = createAdminClient();
  // Tenant témoin pour le test d'isolation : présent AVANT le seed.
  await admin.pendingAction.deleteMany({ where: { tenant: { name: OTHER_TENANT } } });
  await admin.note.deleteMany({ where: { tenant: { name: OTHER_TENANT } } });
  await admin.tenant.deleteMany({ where: { name: OTHER_TENANT } });
  otherTenantId = (await admin.tenant.create({ data: { name: OTHER_TENANT } })).id;
  await admin.note.create({
    data: { tenantId: otherTenantId, title: "témoin", body: "ne doit pas bouger" },
  });
  await admin.pendingAction.create({
    data: { tenantId: otherTenantId, type: "send_dunning", status: "pending", payload: { probe: 1 } },
  });
}, 30_000);

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("pnpm seed:demo", () => {
  it("garde fail-closed : refus en production ET en environnement inconnu", () => {
    expect(() => runSeed({ NODE_ENV: "production", DEMO_SEED_ALLOWED: "" })).toThrow();
    // NODE_ENV absent (poste inconnu, DATABASE_URL pointant n'importe où) :
    // liste blanche -> refus sans flag explicite.
    expect(() => runSeed({ NODE_ENV: "", DEMO_SEED_ALLOWED: "" })).toThrow();
  }, 120_000);

  it("crée le tenant démo conforme au kit, puis le RESTAURE à l'identique", async () => {
    runSeed();
    const first = await snapshot();

    // Cohérence kit : 5 actions en attente, dont 3 relances qui couvrent
    // exactement les 8 030 € d'impayés.
    expect(first.name).toBe("Élec Provence");
    expect(first.pendingActions).toHaveLength(5);
    expect(first.pendingActions.every((a) => a.status === "pending")).toBe(true);
    const dunnings = first.pendingActions.filter((a) => a.type === "send_dunning");
    expect(dunnings).toHaveLength(3);
    const lateCents = dunnings.reduce((sum, action) => {
      const payload = action.payload as { invoice?: { amountCents?: number } };
      return sum + (payload.invoice?.amountCents ?? 0);
    }, 0);
    expect(lateCents).toBe(803_000);
    expect(first.pendingActions.map((a) => a.type).sort()).toEqual([
      "create_quote",
      "send_dunning",
      "send_dunning",
      "send_dunning",
      "submit_reconciliation",
    ]);
    // Connecteurs : statut « demo », JAMAIS « active » — pas de fausse connexion.
    expect(first.connectors.map((c) => [c.type, c.status]).sort()).toEqual([
      ["pennylane", "demo"],
      ["qonto", "demo"],
    ]);

    // Le user démo peut réellement se connecter (hash better-auth valide).
    const user = await admin.user.findUniqueOrThrow({ where: { email: "demo@nodaq.fr" } });
    const account = await admin.account.findFirstOrThrow({
      where: { userId: user.id, providerId: "credential" },
    });
    expect(account.password).toBeTruthy();
    await expect(
      verifyPassword({ hash: account.password ?? "", password: PASSWORD }),
    ).resolves.toBe(true);

    // Rejouabilité : consommer une action, re-seeder -> état initial identique.
    const tenant = await admin.tenant.findUniqueOrThrow({ where: { slug: DEMO_SLUG } });
    await admin.pendingAction.updateMany({
      where: { tenantId: tenant.id, type: "send_dunning" },
      data: { status: "executed" },
    });
    runSeed();
    const second = await snapshot();
    expect(second).toEqual(first);
  }, 120_000);

  it("isolation : aucun autre tenant n'est touché", async () => {
    const note = await admin.note.findMany({ where: { tenantId: otherTenantId } });
    const actions = await admin.pendingAction.findMany({ where: { tenantId: otherTenantId } });
    expect(note).toHaveLength(1);
    expect(note[0]?.title).toBe("témoin");
    expect(actions).toHaveLength(1);
    expect(actions[0]?.status).toBe("pending");
  });

  it("refuse de réécrire le mot de passe d'un compte lié à d'autres organisations", async () => {
    const user = await admin.user.findUniqueOrThrow({ where: { email: "demo@nodaq.fr" } });
    const foreign = await admin.membership.create({
      data: { tenantId: otherTenantId, userId: user.id, role: "member" },
    });
    try {
      expect(() => runSeed()).toThrow();
    } finally {
      await admin.membership.delete({ where: { id: foreign.id } });
    }
    // Redevenu strictement démo -> le seed repasse.
    runSeed();
  }, 120_000);
});
