import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { prisma, withTenant } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { buildApp } from "../src/app.js";

/*
 * Encaissé ≠ acquis (4.2, bloc 3), côté API.
 *
 * Le découpage est testé en pur à part. Ici on éprouve ce que le moteur ne
 * peut pas voir : que la ROUTE charge bien les affaires terminées (l'acquis y
 * vit), qu'elle ne rend jamais d'écart entre deux bases incomparables, et
 * qu'elle est réservée au dirigeant.
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
  expect(res.statusCode).toBe(200);
  return cookiesOf(res);
}

async function seedAffaire(
  reference: string,
  status: string,
  quotedAmountCents: number | null,
  depositsCents = 0,
): Promise<string> {
  const created = await withTenant(orgA, (tx) =>
    tx.affaire.create({
      data: {
        tenantId: orgA,
        reference,
        label: `Affaire ${reference}`,
        status,
        quotedAmountCents,
        depositsCents,
      },
    }),
  );
  return created.id;
}

const revenus = async (cookie: string) =>
  app.inject({ method: "GET", url: "/affaires/revenus", headers: { cookie } });

beforeAll(async () => {
  admin = createAdminClient();
  app = buildApp();
  await app.ready();

  ownerCookie = await signup(`revenus-owner-${RUN}@example.com`, "Revenus Owner");
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Revenus ${RUN}`, slug: `org-revenus-${RUN}` },
  });
  orgA = org.json().id as string;

  memberCookie = await signup(`revenus-member-${RUN}@example.com`, "Revenus Member");
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

describe("le découpage des revenus", () => {
  it("un membre n'y accède pas : c'est un agrégat financier du tenant", async () => {
    expect((await revenus(memberCookie)).statusCode).toBe(403);
  });

  it("sépare livré, vendu et encaissé — et charge bien les TERMINÉES", async () => {
    /*
     * La route des marges ne lit QUE les affaires ouvertes. Réutiliser sa
     * requête aurait donné un acquis structurellement nul : un chiffre faux
     * qui ne se serait jamais fait remarquer, puisqu'il aurait l'air d'un
     * démarrage tranquille.
     */
    await seedAffaire(`${RUN}-1`, "TERMINEE", 100_000);
    await seedAffaire(`${RUN}-2`, "EN_COURS", 60_000, 20_000);
    await seedAffaire(`${RUN}-3`, "DEVIS_ENVOYE", 500_000);

    const res = await revenus(ownerCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;

    expect(body.acquisCents).toBe(100_000);
    // Vendu, pas livré. Et le devis ENVOYÉ ne compte nulle part : personne n'a
    // encore dit oui.
    expect(body.engageCents).toBe(60_000);
    // L'acompte est sur le compte, quoi qu'il arrive au chantier.
    expect(body.encaisseDeclareCents).toBe(20_000);
    expect(body.exact).toBe(true);
  });

  it("ne rend AUCUN écart entre deux bases incomparables", async () => {
    /*
     * L'encaissé est du TTC, l'acquis du HT. Un « reste à encaisser » calculé
     * par différence vaudrait à peu près la TVA — de l'argent qui n'appartient
     * pas à l'entreprise — et ferait arrêter de facturer trop tôt. Les deux
     * bases voyagent avec leurs chiffres ; l'écran ne peut pas les soustraire
     * par accident.
     */
    const body = (await revenus(ownerCookie)).json() as Record<string, unknown>;
    expect(body.acquisBasis).toBe("ht");
    expect(body.encaisseBasis).toBe("ttc");
    expect(Object.keys(body)).not.toContain("ecartCents");
    expect(Object.keys(body)).not.toContain("resteAEncaisserCents");
  });

  it("une affaire signée SANS devis est comptée et dite, jamais ignorée", async () => {
    await seedAffaire(`${RUN}-4`, "EN_COURS", null);
    const body = (await revenus(ownerCookie)).json() as Record<string, unknown>;
    expect(body.sansDevis).toBe(1);
    // Le résultat cesse de se dire exact : c'est ça, « ce qui n'est pas
    // calculé est DIT ».
    expect(body.exact).toBe(false);
  });

  it("module affaires éteint ⇒ 409 motivé, pas un zéro trompeur", async () => {
    // Un zéro rendu module éteint se lirait « vous n'avez rien gagné ».
    await app.inject({
      method: "PUT",
      url: "/modules/affaires",
      headers: { cookie: ownerCookie },
      payload: { active: false },
    });
    const res = await revenus(ownerCookie);
    expect(res.statusCode).toBe(409);
    await app.inject({
      method: "PUT",
      url: "/modules/affaires",
      headers: { cookie: ownerCookie },
      payload: { active: true },
    });
  });
});

describe("le RÉGLÉ vient des factures, et il exclut la retenue", () => {
  /*
   * LE chemin où vivaient les deux bugs de la revue, et qu'aucun test ne
   * couvrait : la suite restait verte si l'on supprimait purement et
   * simplement la requête sur les factures.
   */
  async function seedFacture(
    number: string,
    amountCents: number,
    residualCents: number,
    /** SOLDE du 4117 porté par l'import — la retenue ENCORE détenue. */
    retenueEnCours: number,
  ): Promise<void> {
    const imp = await withTenant(orgA, (tx) =>
      tx.fecImport.create({
        data: {
          tenantId: orgA,
          fileHash: `${RUN}-${number}`,
          entryCount: 1,
          customerCount: 1,
          invoiceCount: 1,
          overdueCount: 0,
          overdueCents: 0,
          retainedCents: retenueEnCours,
          warnings: [],
        },
      }),
    );
    await withTenant(orgA, (tx) =>
      tx.fecInvoice.create({
        data: {
          tenantId: orgA,
          importId: imp.id,
          customerRef: "C1",
          number,
          issuedDate: new Date("2026-01-10T12:00:00Z"),
          dueDate: new Date("2026-02-10T12:00:00Z"),
          amountCents,
          residualCents,
          settled: residualCents === 0,
        },
      }),
    );
  }

  it("la retenue de garantie n'est PAS de l'argent encaissé", async () => {
    /*
     * `residualCents` exclut la retenue par construction, donc
     * `facturé − résiduel` la CONTIENT : 10 000 € encaissés le jour où le
     * client en verse 9 500.
     *
     * On soustrait le SOLDE du 4117 (`fec_imports.retained_cents`), pas la
     * retenue ligne à ligne : une libération se comptabilise souvent sous sa
     * propre pièce, et la facture d'origine garde son `retained_cents` à vie —
     * les 500 € seraient amputés pour toujours, même une fois versés.
     */
    await seedFacture(`${RUN}-F1`, 1_000_000, 0, 50_000);
    const body = (await revenus(ownerCookie)).json() as Record<string, number>;
    // 1 000 000 facturés, 0 résiduel, mais 50 000 encore RETENUS (solde 4117).
    expect(body.encaisseFactureCents).toBe(950_000);
  });

  it("une facture NON RATTACHÉE à une affaire compte quand même", async () => {
    /*
     * Le rattachement est nullable, et son absence est le cas MAJORITAIRE.
     * N'agréger que les factures rattachées afficherait « encaissé » sur une
     * fraction de l'encaissé, sous un libellé qui promet le compte en banque.
     */
    await seedFacture(`${RUN}-F2`, 300_000, 100_000, 0);
    const apres = (await revenus(ownerCookie)).json() as Record<string, number>;
    /*
     * Valeur ABSOLUE, pas un delta : le solde du 4117 du DERNIER import fait
     * autorité, et ce second import déclare une retenue nulle (elle a été
     * libérée). Les 50 000 précédemment retenus sont donc désormais encaissés
     * — c'est précisément ce qu'un `retained_cents` ligne à ligne aurait
     * amputé pour toujours.
     *
     * F1 : 1 000 000 − 0. F2 : 300 000 − 100 000. Retenue en cours : 0.
     */
    expect(apres.encaisseFactureCents).toBe(1_200_000);
  });

  it("acomptes déclarés et factures réglées restent DEUX chiffres", async () => {
    // Les additionner double-compterait la facture d'acompte du bâtiment.
    const body = (await revenus(ownerCookie)).json() as Record<string, unknown>;
    expect(typeof body.encaisseDeclareCents).toBe("number");
    expect(typeof body.encaisseFactureCents).toBe("number");
    expect(Object.keys(body)).not.toContain("encaisseCents");
  });
});

describe("archiver ne défait plus ce qui a été LIVRÉ", () => {
  it("terminée puis archivée : le montant RESTE dans l'acquis", async () => {
    /*
     * Ce que le bloc 3 assumait comme sous-estimation : `status` est une
     * colonne unique, donc archiver écrasait `TERMINEE` et le chiffre acquis
     * d'un exercice baissait quand le patron rangeait.
     *
     * `completedAt` le corrige sans rouvrir la faute inverse. Il est posé par
     * la TRANSITION vers `TERMINEE` et par rien d'autre, là où `actualEndDate`
     * est un champ libre qu'une affaire abandonnée pouvait porter.
     */
    const avant = (await revenus(ownerCookie)).json() as Record<string, number>;
    const cree = await app.inject({
      method: "POST",
      url: "/affaires",
      headers: { cookie: ownerCookie },
      payload: { label: `Livrée ${RUN}`, status: "TERMINEE", quotedAmountCents: 70_000 },
    });
    expect(cree.statusCode).toBe(201);
    const id = cree.json().id as string;
    expect(cree.json().completedAt).not.toBeNull();

    const pendant = (await revenus(ownerCookie)).json() as Record<string, number>;
    expect(pendant.acquisCents - avant.acquisCents).toBe(70_000);

    const range = await app.inject({
      method: "POST",
      url: `/affaires/${id}/archiver`,
      headers: { cookie: ownerCookie },
    });
    expect(range.statusCode).toBe(200);
    // Ranger n'est pas défaire : la date de livraison SURVIT à l'archivage.
    expect(range.json().completedAt).toBe(cree.json().completedAt);

    const apres = (await revenus(ownerCookie)).json() as Record<string, number>;
    expect(apres.acquisCents).toBe(pendant.acquisCents);
  });

  it("archiver par PATCH préserve aussi la date — deux chemins, une règle", async () => {
    /*
     * `POST /affaires/:id/archiver` n'est pas le seul chemin vers `ARCHIVEE` :
     * `PATCH { status: "ARCHIVEE" }` y mène aussi, et c'est LUI qui traverse
     * `nextCompletedAt`. Sans ce test, la branche « ARCHIVEE préserve » n'était
     * couverte par rien — la retirer laissait la suite entièrement verte
     * pendant qu'un archivage par mise à jour effaçait la livraison.
     */
    const id = await seedAffaire(`${RUN}-patch-arch`, "EN_COURS", 30_000);
    const patch = async (payload: Record<string, unknown>) =>
      app.inject({
        method: "PATCH",
        url: `/affaires/${id}`,
        headers: { cookie: ownerCookie },
        payload,
      });
    const pose = (await patch({ status: "TERMINEE" })).json().completedAt as string;
    expect(pose).not.toBeNull();

    const avant = (await revenus(ownerCookie)).json() as Record<string, number>;
    const range = await patch({ status: "ARCHIVEE" });
    expect(range.json().completedAt).toBe(pose);
    const apres = (await revenus(ownerCookie)).json() as Record<string, number>;
    expect(apres.acquisCents).toBe(avant.acquisCents);
  });

  it("PERDUE puis archivée ne compte RIEN, même avec une date de fin saisie", async () => {
    /*
     * LE CAS QUI AVAIT FAIT RETIRER `actualEndDate`. `/affaires/:id/archiver`
     * accepte n'importe quel statut de départ ; une affaire abandonnée dont
     * quelqu'un avait saisi la date d'arrêt aurait compté à 100 % du devis.
     *
     * Ici la date de fin est saisie ET l'affaire est archivée : elle ne compte
     * toujours rien, parce qu'aucune transition vers `TERMINEE` n'a eu lieu.
     * C'est la différence entre un fait et une déduction.
     */
    const avant = (await revenus(ownerCookie)).json() as Record<string, number>;
    const id = await seedAffaire(`${RUN}-perdue-arch`, "PERDUE", 90_000);
    await app.inject({
      method: "PATCH",
      url: `/affaires/${id}`,
      headers: { cookie: ownerCookie },
      payload: { actualEndDate: "2026-06-30" },
    });
    await app.inject({
      method: "POST",
      url: `/affaires/${id}/archiver`,
      headers: { cookie: ownerCookie },
    });

    const apres = (await revenus(ownerCookie)).json() as Record<string, number>;
    expect(apres.acquisCents).toBe(avant.acquisCents);
    const ligne = await withTenant(orgA, (tx) =>
      tx.affaire.findUniqueOrThrow({ where: { id } }),
    );
    expect(ligne.completedAt).toBeNull();
  });

  it("une affaire REPRISE perd sa date de livraison, et sort de l'acquis", async () => {
    /*
     * `TERMINEE -> EN_COURS` est une correction : le chantier n'était pas
     * fini. Garder `completedAt` ferait recompter l'affaire en acquis le jour
     * où elle serait archivée — donc DEUX fois si elle se termine à nouveau.
     */
    const id = await seedAffaire(`${RUN}-reprise`, "ACCEPTEE", 50_000);
    await app.inject({
      method: "PATCH",
      url: `/affaires/${id}`,
      headers: { cookie: ownerCookie },
      payload: { status: "TERMINEE" },
    });
    const termine = await withTenant(orgA, (tx) =>
      tx.affaire.findUniqueOrThrow({ where: { id } }),
    );
    expect(termine.completedAt).not.toBeNull();

    await app.inject({
      method: "PATCH",
      url: `/affaires/${id}`,
      headers: { cookie: ownerCookie },
      payload: { status: "EN_COURS" },
    });
    const repris = await withTenant(orgA, (tx) =>
      tx.affaire.findUniqueOrThrow({ where: { id } }),
    );
    expect(repris.completedAt).toBeNull();

    // Et l'archivage d'une affaire reprise ne la remet pas dans l'acquis.
    const avant = (await revenus(ownerCookie)).json() as Record<string, number>;
    await app.inject({
      method: "POST",
      url: `/affaires/${id}/archiver`,
      headers: { cookie: ownerCookie },
    });
    const apres = (await revenus(ownerCookie)).json() as Record<string, number>;
    expect(apres.acquisCents).toBe(avant.acquisCents);
  });

  it("la date de livraison ne GLISSE pas à chaque modification", async () => {
    /*
     * Sans idempotence, corriger une faute de frappe sur une affaire déjà
     * terminée repousserait sa livraison à aujourd'hui. Le jour où un exercice
     * se calculera par période, toutes les affaires anciennes basculeraient
     * dans le mois en cours à la première correction.
     */
    const id = await seedAffaire(`${RUN}-idem`, "EN_COURS", 40_000);
    const patch = async (payload: Record<string, unknown>) =>
      app.inject({
        method: "PATCH",
        url: `/affaires/${id}`,
        headers: { cookie: ownerCookie },
        payload,
      });
    const premier = await patch({ status: "TERMINEE" });
    const pose = premier.json().completedAt as string;
    expect(pose).not.toBeNull();

    const second = await patch({ status: "TERMINEE", label: `Corrigé ${RUN}` });
    expect(second.json().completedAt).toBe(pose);
    const troisieme = await patch({ label: `Encore ${RUN}` });
    expect(troisieme.json().completedAt).toBe(pose);
  });

  it("`completedAt` n'est JAMAIS saisi par le client", async () => {
    /*
     * L'exposer en entrée rouvrirait exactement le défaut d'`actualEndDate` :
     * un champ libre posable sur une affaire jamais livrée, donc comptée à
     * 100 % du devis en acquis. Le schéma est `.strict()` côté création.
     */
    const res = await app.inject({
      method: "POST",
      url: "/affaires",
      headers: { cookie: ownerCookie },
      payload: {
        label: `Triche ${RUN}`,
        status: "PERDUE",
        quotedAmountCents: 60_000,
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    // Soit refusé, soit ignoré — jamais écrit.
    if (res.statusCode === 201) {
      const ligne = await withTenant(orgA, (tx) =>
        tx.affaire.findUniqueOrThrow({ where: { id: res.json().id as string } }),
      );
      expect(ligne.completedAt).toBeNull();
    } else {
      expect(res.statusCode).toBe(400);
    }
  });
});

describe("la troncature est DITE, et elle retire l'exactitude", () => {
  it("`exact` tombe dès qu'une affaire n'a pas été examinée", async () => {
    /*
     * `exact` était calculé par le moteur pur (qui ne connaît pas la borne),
     * si bien que la route pouvait rendre `{ exact: true, ignorees: 500 }` :
     * un consommateur autre que l'écran aurait lu « exact » sur un chiffre
     * amputé.
     */
    const { loadRevenusSplit } = await import("../src/affaires.js");
    const vue = await withTenant(orgA, (tx) => loadRevenusSplit(tx, 1));
    expect(vue.ignorees).toBeGreaterThan(0);
    // Prouve que c'est bien la TRONCATURE qui fait tomber `exact` : sans cette
    // ligne, une affaire sans devis dans le lot suffirait à expliquer le faux.
    expect(vue.sansDevis).toBe(0);
    expect(vue.exact).toBe(false);
  });
});
