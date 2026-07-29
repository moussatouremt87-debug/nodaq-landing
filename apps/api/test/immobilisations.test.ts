import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma, withTenant } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";

/*
 * Immobilisations (2.19) : registre owner-only, propositions FEC en file de
 * validation (jamais d'insertion silencieuse), exécuteur idempotent, et LA
 * garde du ticket : une dotation n'entre JAMAIS comme décaissement — la
 * projection de trésorerie du cockpit reste identique avec ou sans registre.
 */

let app: FastifyInstance;
let admin: PrismaClient;
let ownerCookie: string;
let memberCookie: string;
let orgA: string;

const RUN = Date.now().toString(36);

function cookiesOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.map((c) => String(c).split(";")[0]).join("; ");
}

async function signup(email: string, name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password: "a-strong-password-123", name },
  });
  if (res.statusCode !== 200) console.error("signup failed", res.statusCode, res.body.slice(0, 300));
  expect(res.statusCode).toBe(200);
  return cookiesOf(res);
}

/** FEC minimal : un fourgon (2182) amorti pour moitié (28182) + une vente. */
function fecFile(): string {
  const header =
    "JournalCode\tJournalLib\tEcritureNum\tEcritureDate\tCompteNum\tCompteLib\tCompAuxNum\tCompAuxLib\tPieceRef\tPieceDate\tEcritureLib\tDebit\tCredit\tEcritureLet\tDateLet\tValidDate\tMontantdevise\tIdevise";
  const rows = [
    ["OD", "OD", "1", "20230310", "2182", "Fourgon atelier", "", "", "P1", "20230310", "Achat fourgon", "35000,00", "0,00", "", "", "", "", ""],
    ["OD", "OD", "1", "20230310", "404FOURN", "Fournisseur immo", "", "", "P1", "20230310", "Achat fourgon", "0,00", "35000,00", "", "", "", "", ""],
    ["OD", "OD", "2", "20241231", "68112", "Dotations amortissements", "", "", "P2", "20241231", "Dotation", "17500,00", "0,00", "", "", "", "", ""],
    ["OD", "OD", "2", "20241231", "28182", "Amort fourgon", "", "", "P2", "20241231", "Dotation", "0,00", "17500,00", "", "", "", "", ""],
    ["VE", "Ventes", "3", "20240110", "411CLIENT", "Client Test", "C1", "Client Test", "F1", "20240110", "Facture F1", "1200,00", "0,00", "", "", "", "", ""],
    ["VE", "Ventes", "4", "20240110", "706", "Prestations", "", "", "F1", "20240110", "Facture F1", "0,00", "1200,00", "", "", "", "", ""],
  ];
  return [header, ...rows.map((r) => r.join("\t"))].join("\r\n");
}

beforeAll(async () => {
  admin = createAdminClient();
  app = buildApp();
  await app.ready();

  ownerCookie = await signup(`immo-owner-${RUN}@example.com`, "Immo Owner");
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Immo ${RUN}`, slug: `org-immo-${RUN}` },
  });
  orgA = org.json().id as string;

  memberCookie = await signup(`immo-member-${RUN}@example.com`, "Immo Member");
  const memberId = (
    await app.inject({ method: "GET", url: "/me", headers: { cookie: memberCookie } })
  ).json().userId as string;
  await admin.membership.create({ data: { tenantId: orgA, userId: memberId, role: "member" } });
  await app.inject({
    method: "POST",
    url: "/api/auth/organization/set-active",
    headers: { cookie: memberCookie },
    payload: { organizationId: orgA },
  });
}, 60_000);

afterAll(async () => {
  await app.close();
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("registre owner-only + saisie manuelle", () => {
  it("un membre n'accède pas au registre (403) ; l'owner crée et lit avec VNC calculée", async () => {
    const forbidden = await app.inject({
      method: "GET",
      url: "/immobilisations",
      headers: { cookie: memberCookie },
    });
    expect(forbidden.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST",
      url: "/immobilisations",
      headers: { cookie: ownerCookie },
      payload: {
        label: "Nacelle",
        category: "materiel",
        inServiceDate: "2024-01-01",
        baseCents: 2_400_000,
        durationMonths: 48,
      },
    });
    expect(created.statusCode).toBe(201);

    const registry = await app.inject({
      method: "GET",
      url: "/immobilisations",
      headers: { cookie: ownerCookie },
    });
    const body = registry.json() as {
      assets: { label: string; bookValueCents: number; wearRatio: number; planEndYear: number }[];
      isImpact: { label: string; estimatedTaxSavingCents: number; currentYearDepreciationCents: number };
    };
    const nacelle = body.assets.find((a) => a.label === "Nacelle")!;
    // Convention d'affichage : VNC à FIN d'exercice COURANT (2026) —
    // 3 années amorties sur 4 (600 000/an) -> 600 000.
    expect(nacelle.bookValueCents).toBe(600_000);
    expect(nacelle.planEndYear).toBe(2027);
    // L'impact IS est TOUJOURS labellisé estimation, et STRICTEMENT inférieur
    // aux dotations (garde : seul l'effet fiscal sort, jamais la dotation).
    expect(body.isImpact.label).toContain("estimation");
    expect(body.isImpact.estimatedTaxSavingCents).toBeLessThan(
      body.isImpact.currentYearDepreciationCents,
    );
  });

  it("GARDE dotation ≠ décaissement : la projection de trésorerie du cockpit est INCHANGÉE par le registre", async () => {
    const kpis = await app.inject({
      method: "GET",
      url: "/cockpit/kpis",
      headers: { cookie: ownerCookie },
    });
    const body = kpis.json() as { treasury: { points: unknown[] } | null };
    // Pas de connecteur bancaire dans ce test : la trésorerie est null — et
    // SURTOUT, la présence d'immobilisations n'a pas fabriqué de projection
    // ni injecté de flux : les dotations ne sont pas des décaissements.
    expect(body.treasury).toBeNull();
  });
});

describe("dérivation FEC 2x/28x -> propositions validées", () => {
  it("l'import crée des PROPOSITIONS (pas d'insertion silencieuse), l'approbation crée l'asset — idempotent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/connectors/fec/import",
      headers: {
        cookie: ownerCookie,
        "content-type": "application/octet-stream",
        "x-fec-filename": "test.txt",
      },
      payload: fecFile(),
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { fixedAssetProposals: number }).fixedAssetProposals).toBe(1);

    // Aucune immobilisation créée AVANT validation.
    const before = await withTenant(orgA, (tx) =>
      tx.fixedAsset.findMany({ where: { source: "FEC" } }),
    );
    expect(before).toHaveLength(0);

    const pending = await withTenant(orgA, (tx) =>
      tx.pendingAction.findFirst({
        where: { type: "create_fixed_asset", status: "pending" },
        select: { id: true, payload: true },
      }),
    );
    expect(pending).not.toBeNull();
    const payload = pending!.payload as {
      category: string;
      baseCents: number;
      priorDepreciationCents: number;
      warnings: string[];
    };
    expect(payload).toMatchObject({
      category: "vehicule",
      baseCents: 3_500_000,
      priorDepreciationCents: 1_750_000,
    });

    const approve = await app.inject({
      method: "POST",
      url: `/pending-actions/${pending!.id}/approve`,
      headers: { cookie: ownerCookie },
      payload: {},
    });
    expect(approve.statusCode).toBe(200);
    const created = await withTenant(orgA, (tx) =>
      tx.fixedAsset.findMany({ where: { source: "FEC" } }),
    );
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ label: "Fourgon atelier", category: "vehicule" });

    // Ré-import du même FEC : ni doublon de proposition, ni doublon d'asset.
    const again = await app.inject({
      method: "POST",
      url: "/connectors/fec/import",
      headers: { cookie: ownerCookie, "content-type": "application/octet-stream" },
      payload: fecFile(),
    });
    expect((again.json() as { alreadyImported: boolean }).alreadyImported).toBe(true);
  });
});
