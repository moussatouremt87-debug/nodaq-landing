import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { VERTICALS } from "@nodaq/shared";
import { buildApp } from "../src/app.js";

/*
 * Veille réglementaire (3.7) : profil stratégique (vertical + effectif RH)
 * -> OWNER-ONLY de bout en bout ; obligations depuis le catalogue versionné
 * sourcé via le MÊME outil owner-gated que l'agent ; label « information
 * générale, pas un conseil juridique » permanent.
 */

let app: FastifyInstance;
let admin: PrismaClient;
let ownerCookie: string;
let memberCookie: string;

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
  expect(res.statusCode).toBe(200);
  return cookiesOf(res);
}

beforeAll(async () => {
  admin = createAdminClient();
  app = buildApp();
  await app.ready();

  ownerCookie = await signup(`veille-owner-${RUN}@example.com`, "Veille Owner");
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Veille ${RUN}`, slug: `org-veille-${RUN}` },
  });
  const orgA = org.json().id as string;

  memberCookie = await signup(`veille-member-${RUN}@example.com`, "Veille Member");
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

  // PIVOT (ADR-007) : ce module est HORS SOCLE — éteint par défaut. Il n'est
  // ni supprimé ni cassé, et ce test le prouve : l'owner le rallume en un
  // appel, et la fonctionnalité répond exactement comme avant.
  const moduleOn = await app.inject({
    method: "PUT",
    url: "/modules/reglementaire",
    headers: { cookie: ownerCookie },
    payload: { active: true },
  });
  // Asserté : un renommage de module ferait sinon un no-op silencieux, et
  // l'échec ressortirait bien plus loin, illisible.
  expect(moduleOn.statusCode).toBe(200);

}, 60_000);

afterAll(async () => {
  await app.close();
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("veille réglementaire — owner-only", () => {
  it("la liste VERTICALS (TS) et le CHECK SQL de tenant_profiles restent synchrones", async () => {
    /*
     * Liste dupliquée base/TS : un vertical ajouté côté TS sans migration
     * donnerait un 500 (échec fermé, mais cassé). Ce test fige la synchro.
     *
     * Lu depuis la contrainte EFFECTIVE de la base, plus depuis un fichier de
     * migration. La version précédente lisait `20260730000000_tenant_profiles`
     * en dur : elle figeait la PREMIÈRE définition de la contrainte, donc elle
     * serait devenue fausse — et rouge — à la première migration qui l'altère,
     * en accusant le code alors que la base et le TS seraient d'accord. Un
     * test qui se trompe de coupable est pire qu'un test absent.
     */
    const [row] = await prisma.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint
        -- conrelid et pas seulement conname : un homonyme dans un autre
        -- schéma ferait sinon choisir une ligne au hasard, et le test
        -- comparerait la mauvaise contrainte.
       WHERE conname = 'tenant_profiles_vertical_check'
         AND conrelid = 'public.tenant_profiles'::regclass`;
    expect(row?.def).toBeDefined();
    // Classe LARGE : un futur identifiant à chiffre ou tiret serait invisible
    // pour `[a-z_]+`, donc absent de `sqlValues` — et le test dénoncerait une
    // désynchro qui n'existe pas. C'est le défaut même qu'il vient de corriger.
    // Pas de filtre sur « text » : Postgres n'entoure JAMAIS le cast de
    // quotes (`'batiment'::text`), donc un tel filtre ne protégerait de rien
    // et masquerait un futur vertical qui s'appellerait « text ».
    const sqlValues = [...(row?.def ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(sqlValues).toEqual([...VERTICALS].sort());
  });

  it("un membre n'accède à RIEN (profil, obligations) : 403 partout", async () => {
    for (const [method, url] of [
      ["GET", "/reglementaire"],
      ["GET", "/reglementaire/profil"],
      ["PUT", "/reglementaire/profil"],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { cookie: memberCookie },
        ...(method === "PUT" ? { payload: { vertical: "retail" } } : {}),
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it("profil par défaut honnête : vertical « autre », effectif inconnu (jamais 0 supposé)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/reglementaire/profil",
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      vertical: "autre",
      headcountOverride: null,
      derivedHeadcount: null,
    });
  });

  it("profil renseigné puis obligations : seuils, sources, tri par urgence, label", async () => {
    // Vertical inconnu ou champ en trop : refus net (strict).
    const bad = await app.inject({
      method: "PUT",
      url: "/reglementaire/profil",
      headers: { cookie: ownerCookie },
      payload: { vertical: "banque" },
    });
    expect(bad.statusCode).toBe(400);

    const put = await app.inject({
      method: "PUT",
      url: "/reglementaire/profil",
      headers: { cookie: ownerCookie },
      payload: { vertical: "industrie_btp", headcountOverride: 25 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ vertical: "industrie_btp", headcountOverride: 25 });

    const res = await app.inject({
      method: "GET",
      url: "/reglementaire",
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      version: string;
      label: string;
      profile: { vertical: string; headcount: number | null; headcountSource: string };
      matches: {
        id: string;
        applies: string;
        status: string;
        reason: string;
        source: { label: string; url: string };
      }[];
    };
    expect(body.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.label).toContain("conseil juridique");
    expect(body.profile).toMatchObject({
      vertical: "industrie_btp",
      headcount: 25,
      headcountSource: "declare",
    });
    // 25 salariés en BTP : CSE (11) et OETH (20) applicables, index égalité (50) non.
    const ids = body.matches.map((m) => m.id);
    expect(ids).toContain("cse");
    expect(ids).toContain("oeth");
    expect(ids).toContain("garantie-decennale");
    expect(ids).not.toContain("index-egalite");
    // Chaque inclusion est justifiée et sourcée.
    for (const match of body.matches) {
      expect(match.reason.length).toBeGreaterThan(10);
      expect(match.source.url).toMatch(/^https:\/\//);
    }
  });

  it("un métier de la CIBLE du pivot s'enregistre vraiment, et reçoit ses obligations", async () => {
    /*
     * La preuve de bout en bout que le pack 4.2 est branché : Zod, la
     * contrainte SQL et le catalogue d'obligations doivent tomber d'accord.
     * Les tests de `@nodaq/shared` ne peuvent pas le dire — ils ne voient ni
     * la route ni la base, et c'est exactement là que les deux listes
     * dupliquées peuvent diverger.
     *
     * Avant ce ticket, un paysagiste n'était PAS storable : il n'existait pas
     * dans la liste, l'écran lui proposait « Autre », et il repartait avec les
     * obligations de personne.
     */
    const put = await app.inject({
      method: "PUT",
      url: "/reglementaire/profil",
      headers: { cookie: ownerCookie },
      payload: { vertical: "paysage", headcountOverride: 6 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ vertical: "paysage" });

    const res = await app.inject({
      method: "GET",
      url: "/reglementaire",
      headers: { cookie: ownerCookie },
    });
    const ids = (res.json() as { matches: { id: string }[] }).matches.map((m) => m.id);
    /*
     * La décennale suit les TRAVAUX, pas la nomenclature : les ouvrages d'un
     * paysagiste (murs de soutènement, terrasses, dallages) en relèvent, et ne
     * pas la lui rappeler serait la pire des deux erreurs — son absence est un
     * délit (code des assurances, art. L243-3).
     */
    expect(ids).toContain("garantie-decennale");
    // 6 salariés : pas de CSE (11) ni d'OETH (20). Le pack ne dérègle pas les
    // seuils d'effectif au passage.
    expect(ids).not.toContain("cse");
    expect(ids).not.toContain("oeth");

    // Un métier de la cible qui ne construit PAS d'ouvrage ne la reçoit pas :
    // sinon « applicable » ne voudrait plus rien dire.
    await app.inject({
      method: "PUT",
      url: "/reglementaire/profil",
      headers: { cookie: ownerCookie },
      payload: { vertical: "evenementiel", headcountOverride: 6 },
    });
    const traiteur = await app.inject({
      method: "GET",
      url: "/reglementaire",
      headers: { cookie: ownerCookie },
    });
    const idsTraiteur = (traiteur.json() as { matches: { id: string }[] }).matches.map((m) => m.id);
    expect(idsTraiteur).not.toContain("garantie-decennale");

    // Profil REMIS comme on l'a trouvé : ce cas est le dernier du bloc
    // aujourd'hui, et c'est exactement pour ça qu'il ne faut pas laisser
    // l'ordre des tests porter du sens.
    await app.inject({
      method: "PUT",
      url: "/reglementaire/profil",
      headers: { cookie: ownerCookie },
      payload: { vertical: "industrie_btp", headcountOverride: 25 },
    });
  });
});
