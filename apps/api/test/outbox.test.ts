import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, withTenant } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import type { PrismaClient } from "@prisma/client";
import { assertNoBusinessData, emitOutbox, OutboxContentError } from "../src/outbox.js";
import type { buildApp } from "../src/app.js";

type TestApp = ReturnType<typeof buildApp>;

/*
 * Bus d'événements (4.4, PR A) — l'ATOMICITÉ et la MINIMISATION.
 *
 * Les deux propriétés sont indissociables du choix de l'outbox, et toutes deux
 * échouent en silence si on les perd : un événement manquant laisse les écrans
 * mentir jusqu'au rechargement suivant, un événement de trop déclenche une
 * relance pour un travail qui n'a jamais été enregistré.
 */

let admin: PrismaClient;
let tenantA: string;
let tenantB: string;
const RUN = Date.now().toString(36);

beforeAll(async () => {
  admin = createAdminClient();
  const a = await admin.tenant.create({ data: { name: `Outbox A ${RUN}`, slug: `ob-a-${RUN}` } });
  const b = await admin.tenant.create({ data: { name: `Outbox B ${RUN}`, slug: `ob-b-${RUN}` } });
  tenantA = a.id;
  tenantB = b.id;
}, 60_000);

afterAll(async () => {
  await admin.$disconnect();
  await prisma.$disconnect();
});

const count = (tenantId: string): Promise<number> =>
  withTenant(tenantId, (tx) => tx.outboxEvent.count());

describe("l'événement est atomique avec l'écriture métier", () => {
  it("une écriture réussie produit EXACTEMENT un événement", async () => {
    const avant = await count(tenantA);
    await withTenant(tenantA, async (tx) => {
      await tx.note.create({ data: { tenantId: tenantA, title: `note ${RUN}`, body: "x" } });
      await emitOutbox(tx, tenantA, { type: "affaire.modifiee", objectType: "note" });
    });
    expect(await count(tenantA)).toBe(avant + 1);
  });

  it("une transaction ANNULÉE ne produit AUCUN événement", async () => {
    /*
     * Le bug que l'outbox existe pour rendre impossible. Un `emit()` posé
     * avant le commit — ou une file appelée dans la foulée — déclencherait ici
     * une relance pour un travail qui n'a jamais été enregistré. L'événement
     * vit dans la MÊME transaction : le rollback l'emporte.
     */
    const avant = await count(tenantA);
    await expect(
      withTenant(tenantA, async (tx) => {
        await tx.note.create({ data: { tenantId: tenantA, title: `annulée ${RUN}`, body: "x" } });
        await emitOutbox(tx, tenantA, { type: "affaire.modifiee", objectType: "note" });
        throw new Error("échec métier après émission");
      }),
    ).rejects.toThrow("échec métier");
    expect(await count(tenantA)).toBe(avant);
  });

  it("un événement naît À RELAYER, jamais déjà transmis", async () => {
    // `deliveredAt` posé à la création ferait sauter l'événement au relais :
    // écrit, jamais transmis, et parfaitement invisible.
    await withTenant(tenantA, (tx) =>
      emitOutbox(tx, tenantA, { type: "contrat.modifie", objectType: "contrat" }),
    );
    const dernier = await withTenant(tenantA, (tx) =>
      tx.outboxEvent.findFirst({ orderBy: { occurredAt: "desc" } }),
    );
    expect(dernier?.deliveredAt).toBeNull();
  });
});

describe("un événement ne transporte AUCUNE donnée métier", () => {
  it("une paire nom/valeur glissée dans changedFields est REFUSÉE", () => {
    /*
     * Le piège n'est pas la malice, c'est la distraction : on pousse
     * `clientName: "Dupont"` en croyant décrire un champ. La donnée finirait
     * dans les files, les journaux et les rejeux — et serait périmée au moment
     * où quelqu'un la lit.
     */
    expect(() =>
      assertNoBusinessData({
        type: "affaire.modifiee",
        objectType: "affaire",
        changedFields: ["statut:TERMINEE"],
      }),
    ).toThrow(OutboxContentError);
  });

  it("un nom de champ qui trahit une donnée sensible est REFUSÉ", () => {
    // Le NOM seul suffit à faire du mal : « clientName » dans un journal dit
    // déjà qu'on parle de l'identité de quelqu'un.
    for (const champ of ["clientName", "quotedAmountCents", "email", "adresse"]) {
      expect(() =>
        assertNoBusinessData({
          type: "affaire.modifiee",
          objectType: "affaire",
          changedFields: [champ],
        }),
      ).toThrow(OutboxContentError);
    }
  });

  it("des noms de champs ANODINS passent — la garde n'interdit pas de décrire", () => {
    expect(() =>
      assertNoBusinessData({
        type: "affaire.modifiee",
        objectType: "affaire",
        changedFields: ["status", "startDate"],
      }),
    ).not.toThrow();
  });

  it("un type qui ne périme AUCUNE vue est refusé", () => {
    /*
     * Sans cette garde, l'événement serait écrit, relayé, et n'aurait aucun
     * effet : un silence, pas une erreur — donc impossible à remarquer. C'est
     * exactement la panne de fraîcheur, déplacée d'un cran.
     */
    expect(() =>
      assertNoBusinessData({
        type: "evenement.inconnu" as never,
        objectType: "affaire",
      }),
    ).toThrow(OutboxContentError);
  });

  it("la garde s'applique à l'ÉCRITURE, pas seulement au contrôle", async () => {
    // Une garde qu'on peut contourner en appelant `emitOutbox` directement
    // n'est pas une garde.
    await expect(
      withTenant(tenantA, (tx) =>
        emitOutbox(tx, tenantA, {
          type: "affaire.modifiee",
          objectType: "affaire",
          changedFields: ["clientName"],
        }),
      ),
    ).rejects.toThrow(OutboxContentError);
  });
});

describe("isolation", () => {
  it("un tenant ne voit jamais les événements d'un autre", async () => {
    await withTenant(tenantB, (tx) =>
      emitOutbox(tx, tenantB, { type: "stock.modifie", objectType: "stock_item" }),
    );
    const vusDeA = await withTenant(tenantA, (tx) =>
      tx.outboxEvent.findMany({ where: { type: "stock.modifie" } }),
    );
    expect(vusDeA).toHaveLength(0);
    const vusDeB = await withTenant(tenantB, (tx) =>
      tx.outboxEvent.findMany({ where: { type: "stock.modifie" } }),
    );
    expect(vusDeB.length).toBeGreaterThanOrEqual(1);
  });

  it("PREUVE : sans la policy, la fuite a bien lieu", async () => {
    /*
     * Le test d'isolation ci-dessus doit échouer si quelqu'un retire la
     * policy. On le prouve en la désactivant ici — sans quoi il pourrait être
     * vert pour une tout autre raison (un filtre applicatif, par exemple).
     */
    await admin.$executeRawUnsafe(`ALTER TABLE "outbox" DISABLE ROW LEVEL SECURITY`);
    try {
      const fuite = await withTenant(tenantA, (tx) =>
        tx.outboxEvent.findMany({ where: { type: "stock.modifie" } }),
      );
      expect(fuite.length).toBeGreaterThanOrEqual(1);
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "outbox" ENABLE ROW LEVEL SECURITY`);
    }
  });
});

describe("le relais transmet, et il transmet AU MOINS une fois", () => {
  it("un abonné reçoit l'événement de SON tenant, et rien d'autre", async () => {
    const { relayTenantOutbox, subscribeOutbox } = await import("../src/outboxRelay.js");
    const recusA: string[] = [];
    const recusB: string[] = [];
    const { unsubscribe: offA } = subscribeOutbox(tenantA, (d) => recusA.push(d.type), "owner");
    const { unsubscribe: offB } = subscribeOutbox(tenantB, (d) => recusB.push(d.type), "owner");
    try {
      await withTenant(tenantA, (tx) =>
        emitOutbox(tx, tenantA, { type: "rh.modifie", objectType: "employe" }),
      );
      await relayTenantOutbox(tenantA);
      expect(recusA).toContain("rh.modifie");
      // L'abonné de l'AUTRE tenant n'a rien vu : le registre est clé par
      // tenant, et le tenantId vient de la chaîne d'autorisation.
      expect(recusB).not.toContain("rh.modifie");
    } finally {
      offA();
      offB();
    }
  });

  it("un événement transmis ne l'est pas DEUX fois", async () => {
    /*
     * Sans marquage, chaque passage du relais rejouerait tout l'historique :
     * le cockpit clignoterait toutes les deux secondes et l'API servirait des
     * rechargements pour rien. Le rejeu ne doit avoir lieu qu'après un crash,
     * pas à chaque tour.
     */
    const { relayTenantOutbox, subscribeOutbox } = await import("../src/outboxRelay.js");
    const recus: string[] = [];
    const { unsubscribe: off } = subscribeOutbox(tenantA, (d) => recus.push(d.id));
    try {
      await withTenant(tenantA, (tx) =>
        emitOutbox(tx, tenantA, { type: "avis.modifie", objectType: "avis" }),
      );
      const premier = await relayTenantOutbox(tenantA);
      expect(premier.relayed).toBeGreaterThanOrEqual(1);
      const taille = recus.length;

      const second = await relayTenantOutbox(tenantA);
      expect(second.relayed).toBe(0);
      expect(recus).toHaveLength(taille);
    } finally {
      off();
    }
  });

  it("SANS abonné, l'événement est quand même marqué transmis", async () => {
    /*
     * Ne traiter que les tenants abonnés laisserait un arriéré grossir sans
     * fin chez les autres, et le premier abonné à se connecter recevrait trois
     * jours d'invalidations d'un coup. Un écran fermé n'a rien à périmer : il
     * relira en s'ouvrant. C'est la sémantique juste, pas un raccourci.
     */
    const { relayTenantOutbox } = await import("../src/outboxRelay.js");
    await withTenant(tenantB, (tx) =>
      emitOutbox(tx, tenantB, { type: "module.bascule", objectType: "module" }),
    );
    const res = await relayTenantOutbox(tenantB);
    expect(res.relayed).toBeGreaterThanOrEqual(1);
    const restants = await withTenant(tenantB, (tx) =>
      tx.outboxEvent.count({ where: { deliveredAt: null } }),
    );
    expect(restants).toBe(0);
  });

  it("un abonné qui JETTE n'empêche pas les autres d'être servis", async () => {
    const { relayTenantOutbox, subscribeOutbox } = await import("../src/outboxRelay.js");
    const recus: string[] = [];
    const { unsubscribe: offCasse } = subscribeOutbox(
      tenantA,
      () => {
        throw new Error("connexion morte");
      },
      "owner",
    );
    const { unsubscribe: offSain } = subscribeOutbox(tenantA, (d) => recus.push(d.type), "owner");
    try {
      await withTenant(tenantA, (tx) =>
        emitOutbox(tx, tenantA, { type: "echeance.modifiee", objectType: "echeance" }),
      );
      await relayTenantOutbox(tenantA);
      expect(recus).toContain("echeance.modifiee");
    } finally {
      offCasse();
      offSain();
    }
  });

  it("l'événement livré ne porte AUCUNE donnée métier", async () => {
    // La garde d'émission borne ce qui entre ; celle-ci borne ce qui SORT.
    // Une livraison enrichie « pour éviter une requête » au consommateur
    // rouvrirait le trou par l'autre bout.
    const { relayTenantOutbox, subscribeOutbox } = await import("../src/outboxRelay.js");
    const livraisons: Record<string, unknown>[] = [];
    const { unsubscribe: off } = subscribeOutbox(tenantA, (d) => livraisons.push({ ...d }), "owner");
    try {
      await withTenant(tenantA, (tx) =>
        emitOutbox(tx, tenantA, { type: "cout.modifie", objectType: "cost_entry" }),
      );
      await relayTenantOutbox(tenantA);
      const derniere = livraisons.at(-1) ?? {};
      expect(Object.keys(derniere).sort()).toEqual([
        "id",
        "objectId",
        "objectType",
        "occurredAt",
        "type",
      ]);
    } finally {
      off();
    }
  });

  it("un passage TRONQUÉ le dit, au lieu de se croire à jour", async () => {
    const { relayTenantOutbox } = await import("../src/outboxRelay.js");
    for (let i = 0; i < 3; i += 1) {
      await withTenant(tenantB, (tx) =>
        emitOutbox(tx, tenantB, { type: "stock.modifie", objectType: "stock_item" }),
      );
    }
    const res = await relayTenantOutbox(tenantB, { maxPages: 1, pageSize: 1 });
    expect(res.relayed).toBe(1);
    expect(res.truncated).toBe(true);
  });

  it("une dernière page PLEINE mais rien derrière ne crie PAS au loup", async () => {
    /*
     * Déduire la troncature de « la dernière page autorisée était pleine »
     * signale un arriéré inexistant dès que le nombre d'événements tombe pile
     * sur un multiple de la page — et un drapeau qui se lève pour rien est un
     * drapeau qu'on cesse de regarder. On SONDE ce qui reste.
     */
    const { relayTenantOutbox } = await import("../src/outboxRelay.js");
    // On vide d'abord : la troncature ne doit dépendre que de CE qu'on sème.
    await relayTenantOutbox(tenantB);
    await withTenant(tenantB, (tx) =>
      emitOutbox(tx, tenantB, { type: "document.ajoute", objectType: "classeur_document" }),
    );

    const res = await relayTenantOutbox(tenantB, { maxPages: 1, pageSize: 1 });

    expect(res.relayed).toBe(1);
    expect(res.truncated).toBe(false);
  });

  it("le désabonnement coupe vraiment la livraison", async () => {
    const { relayTenantOutbox, subscribeOutbox, outboxSubscriberCount } = await import(
      "../src/outboxRelay.js"
    );
    const recus: string[] = [];
    const { unsubscribe: off } = subscribeOutbox(tenantA, (d) => recus.push(d.type));
    off();
    expect(outboxSubscriberCount(tenantA)).toBe(0);
    await withTenant(tenantA, (tx) =>
      emitOutbox(tx, tenantA, { type: "profil.modifie", objectType: "profil" }),
    );
    await relayTenantOutbox(tenantA);
    expect(recus).toHaveLength(0);
  });
});

describe("le bout en bout : valider une action périme les écrans des AUTRES", () => {
  it("approuver émet un événement, et le relais le transmet", async () => {
    /*
     * LE CRITÈRE D'ACCEPTATION DU TICKET, et le bug d'origine du 2.21 :
     * l'écran qui valide se rafraîchit déjà tout seul ; c'est ailleurs — un
     * second onglet, le poste d'un collègue — que le produit affichait des
     * chiffres d'il y a dix minutes sans le dire.
     *
     * On éprouve la chaîne complète : écriture métier -> événement dans la
     * MÊME transaction -> relais -> abonné.
     */
    const { buildApp } = await import("../src/app.js");
    const { relayTenantOutbox, subscribeOutbox } = await import("../src/outboxRelay.js");
    const app = buildApp();
    await app.ready();
    try {
      const signup = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        payload: {
          email: `outbox-e2e-${RUN}@example.com`,
          password: "a-strong-password-123",
          name: "Outbox E2E",
        },
      });
      const raw = signup.headers["set-cookie"];
      const cookie = (Array.isArray(raw) ? raw : [raw])
        .map((c) => String(c).split(";")[0])
        .join("; ");
      const org = await app.inject({
        method: "POST",
        url: "/api/auth/organization/create",
        headers: { cookie },
        payload: { name: `Org Outbox ${RUN}`, slug: `org-outbox-${RUN}` },
      });
      const tenantId = org.json().id as string;

      const action = await withTenant(tenantId, (tx) =>
        tx.pendingAction.create({
          data: {
            tenantId,
            type: "record_prospect_contact",
            status: "pending",
            employee: "compta",
            payload: {},
          },
        }),
      );

      const recus: string[] = [];
      const { unsubscribe: off } = subscribeOutbox(tenantId, (d) => recus.push(d.type));
      try {
        const rejet = await app.inject({
          method: "POST",
          url: `/pending-actions/${action.id}/reject`,
          headers: { cookie },
        });
        expect(rejet.statusCode).toBe(200);

        // Rien n'est transmis TANT QUE le relais n'est pas passé : la
        // transaction dépose, elle ne pousse pas.
        expect(recus).toHaveLength(0);

        await relayTenantOutbox(tenantId);
        expect(recus).toContain("action.rejetee");
      } finally {
        off();
      }
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe("la route /events — la surface réellement exposée", () => {
  async function withApp<T>(
    run: (app: { inject: (opts: object) => Promise<{ statusCode: number }> }) => Promise<T>,
  ): Promise<T> {
    const { buildApp } = await import("../src/app.js");
    const app = buildApp();
    await app.ready();
    try {
      return await run(app as never);
    } finally {
      await app.close();
    }
  }

  it("sans session, le flux est REFUSÉ", async () => {
    /*
     * L'isolation était prouvée au niveau du registre en mémoire et de la RLS,
     * jamais au niveau HTTP — c'est pourtant la seule surface exposée. Un flux
     * ouvert sans session diffuserait les événements d'un tenant à qui n'a pas
     * de session du tout.
     */
    await withApp(async (app) => {
      const res = await app.inject({ method: "GET", url: "/events" });
      expect([401, 403]).toContain(res.statusCode);
    });
  }, 60_000);

  it("le flux est lié au tenant de la SESSION, pas à un paramètre", async () => {
    // Une route qui accepterait un tenant en query rejouerait la faute que
    // toute la chaîne d'autorisation existe pour empêcher.
    const { buildApp } = await import("../src/app.js");
    const app = buildApp();
    await app.ready();
    try {
      const signup = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        payload: {
          email: `events-${RUN}@example.com`,
          password: "a-strong-password-123",
          name: "Events",
        },
      });
      const raw = signup.headers["set-cookie"];
      const cookie = (Array.isArray(raw) ? raw : [raw])
        .map((c) => String(c).split(";")[0])
        .join("; ");
      // Sans organisation active, la chaîne refuse : le tenant ne peut pas
      // être suppléé par le client.
      const sansOrg = await app.inject({
        method: "GET",
        url: `/events?tenantId=${tenantA}`,
        headers: { cookie },
      });
      expect([400, 403]).toContain(sansOrg.statusCode);
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe("l'autorisation est revérifiée pendant la vie du flux", () => {
  it("une appartenance RÉVOQUÉE ferme le flux, sans attendre l'onglet", async () => {
    /*
     * LE BLOQUANT DU PREMIER AUDIT, éprouvé POUR DE VRAI cette fois.
     *
     * La garde précédente lisait le source de `app.ts` par expression
     * régulière : elle prouvait que le code était écrit, pas qu'il
     * s'exécutait. Le second audit a montré qu'un mutant remplaçant le
     * `fermer()` de la branche `!membership` par un `return` la laissait
     * VERTE — parce que `fermer()` réapparaît plus bas dans le fichier.
     *
     * Ici on ouvre une vraie connexion, on révoque l'appartenance en base, et
     * on vérifie que l'abonné DISPARAÎT du registre. Le battement est injecté
     * par en-tête pour ne pas attendre 25 secondes.
     */
    const { buildApp } = await import("../src/app.js");
    const { outboxSubscriberCount } = await import("../src/outboxRelay.js");
    const app = buildApp();
    await app.ready();
    try {
      const signup = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        payload: {
          email: `revoke-${RUN}@example.com`,
          password: "a-strong-password-123",
          name: "Revoke",
        },
      });
      const raw = signup.headers["set-cookie"];
      const cookie = (Array.isArray(raw) ? raw : [raw])
        .map((c) => String(c).split(";")[0])
        .join("; ");
      const org = await app.inject({
        method: "POST",
        url: "/api/auth/organization/create",
        headers: { cookie },
        payload: { name: `Org Revoke ${RUN}`, slug: `org-revoke-${RUN}` },
      });
      const tenantId = org.json().id as string;

      /*
       * Connexion réelle, battement au plancher (1 s). On SONDE au lieu
       * d'attendre une durée fixe : deux `setTimeout` nus autour d'un
       * battement qui fait deux lectures en base par tour, c'est un faux
       * rouge garanti sur une CI chargée.
       */
      const stream = app.inject({
        method: "GET",
        url: "/events",
        headers: { cookie, "x-test-heartbeat-ms": "1000" },
      });
      const jusqua = async (predicat: () => boolean, limiteMs: number): Promise<boolean> => {
        const fin = Date.now() + limiteMs;
        while (Date.now() < fin) {
          if (predicat()) return true;
          await new Promise((r) => setTimeout(r, 50));
        }
        return predicat();
      };
      expect(await jusqua(() => outboxSubscriberCount(tenantId) > 0, 5_000)).toBe(true);

      // On révoque l'appartenance : le prochain battement doit couper.
      await admin.membership.deleteMany({ where: { tenantId } });
      expect(await jusqua(() => outboxSubscriberCount(tenantId) === 0, 10_000)).toBe(true);
      await stream.catch(() => undefined);
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe("le passage COMPLET du relais — découverte comprise", () => {
  it("un tour complet transmet, sans qu'on lui donne le tenant", async () => {
    /*
     * LA RÉGRESSION LA PLUS GRAVE DE CE TICKET, et elle venait d'un correctif.
     *
     * Pour éviter une transaction par tenant toutes les 2 s, la découverte
     * avait été réécrite en `SELECT DISTINCT tenant_id FROM outbox` HORS
     * `withTenant`. Or `outbox` est scellée (ENABLE + FORCE) et `app_user` est
     * NOBYPASSRLS : sans le GUC, la policy compare `tenant_id = NULL`, donc
     * AUCUNE ligne. Mesuré : 0 vue là où 35 existaient. Le relais ne
     * transmettait plus rien en déployé, et `onRelay` ne se déclenchant qu'à
     * partir d'un événement relayé, pas un journal ne l'aurait dit.
     *
     * Tous les tests appelaient `relayTenantOutbox(tenantId)` avec un tenant
     * DÉJÀ connu : aucun ne passait par la découverte. Celui-ci le fait.
     */
    const { runOutboxRelayOnce, subscribeOutbox } = await import("../src/outboxRelay.js");
    const recus: string[] = [];
    const { unsubscribe } = subscribeOutbox(tenantA, (d) => recus.push(d.type), "owner");
    try {
      await withTenant(tenantA, (tx) =>
        emitOutbox(tx, tenantA, { type: "avis.modifie", objectType: "avis" }),
      );
      const res = await runOutboxRelayOnce();
      expect(res.tenants).toBeGreaterThan(0);
      expect(res.relayed).toBeGreaterThanOrEqual(1);
      expect(recus).toContain("avis.modifie");
    } finally {
      unsubscribe();
    }
  }, 60_000);
});

describe("le filtre de rôle — une fuite par canal auxiliaire", () => {
  it("un MEMBRE ne reçoit pas les événements owner-only", async () => {
    /*
     * Le bus était clé par tenant seulement : tout membre recevait tout. Sans
     * conséquence tant que seul `pending_action` est émis — la file est
     * ouverte aux membres — mais le registre accepte déjà `rh.modifie`, et les
     * routes `/rh/*` sont owner-only parce qu'elles portent des données de
     * salariés. Le jour où le moteur de règles émet, un membre apprendrait
     * l'identifiant d'un salarié modifié et la chronologie des changements RH,
     * sans qu'aucune route n'ait été ouverte.
     */
    const { relayTenantOutbox, subscribeOutbox } = await import("../src/outboxRelay.js");
    const vusParMembre: string[] = [];
    const vusParOwner: string[] = [];
    const membre = subscribeOutbox(tenantA, (d) => vusParMembre.push(d.type), "member");
    const owner = subscribeOutbox(tenantA, (d) => vusParOwner.push(d.type), "owner");
    try {
      await withTenant(tenantA, (tx) =>
        emitOutbox(tx, tenantA, { type: "rh.modifie", objectType: "employe" }),
      );
      await relayTenantOutbox(tenantA);
      expect(vusParOwner).toContain("rh.modifie");
      expect(vusParMembre).not.toContain("rh.modifie");
    } finally {
      membre.unsubscribe();
      owner.unsubscribe();
    }
  });

  it("une RÉTROGRADATION coupe les événements sans attendre une reconnexion", async () => {
    // Le rôle figé à la connexion rejouerait, sur un canal long, le défaut que
    // `requireMembership` corrige à chaque requête ailleurs.
    const { relayTenantOutbox, subscribeOutbox } = await import("../src/outboxRelay.js");
    const recus: string[] = [];
    const abonne = subscribeOutbox(tenantA, (d) => recus.push(d.type), "owner");
    try {
      abonne.setRole("member");
      await withTenant(tenantA, (tx) =>
        emitOutbox(tx, tenantA, { type: "cout.modifie", objectType: "cost_entry" }),
      );
      await relayTenantOutbox(tenantA);
      expect(recus).not.toContain("cout.modifie");
    } finally {
      abonne.unsubscribe();
    }
  });

  it("un MEMBRE reçoit bien ce qui le concerne — le filtre ne coupe pas tout", async () => {
    // Une garde qui couperait tout serait « sûre » et inutile : la file de
    // validation est ouverte aux membres, et c'est elle qui portait le bug.
    const { relayTenantOutbox, subscribeOutbox } = await import("../src/outboxRelay.js");
    const recus: string[] = [];
    const membre = subscribeOutbox(tenantA, (d) => recus.push(d.type), "member");
    try {
      await withTenant(tenantA, (tx) =>
        emitOutbox(tx, tenantA, {
          type: "action.validee",
          objectType: "pending_action",
        }),
      );
      await relayTenantOutbox(tenantA);
      expect(recus).toContain("action.validee");
    } finally {
      membre.unsubscribe();
    }
  });
});

describe("les chaînes libres du format sont bornées", () => {
  it("un objectType hors registre est REFUSÉ", () => {
    expect(() =>
      assertNoBusinessData({ type: "affaire.modifiee", objectType: "SARL Dupont" }),
    ).toThrow(OutboxContentError);
  });

  it("un objectId qui ressemble à un LIBELLÉ est refusé", () => {
    /*
     * `objectId` et `objectType` sont les deux seules chaînes libres, et ce
     * sont précisément celles qui partent vers tous les abonnés du tenant sur
     * un canal long. Le commentaire d'origine affirmait « identifiant opaque »
     * sans rien vérifier.
     */
    expect(() =>
      assertNoBusinessData({
        type: "affaire.modifiee",
        objectType: "affaire",
        objectId: "Jean Dupont <jean@example.com>",
      }),
    ).toThrow(OutboxContentError);
  });

  it("un UUID passe", () => {
    expect(() =>
      assertNoBusinessData({
        type: "affaire.modifiee",
        objectType: "affaire",
        objectId: "0f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
      }),
    ).not.toThrow();
  });
});

/*
 * LES BRANCHES QUE LE QUATRIÈME PASSAGE DU GATE A TROUVÉES NUES.
 *
 * Trois gardes du flux étaient écrites, commentées, et supprimables sans
 * qu'un seul test rougisse : la relecture de SESSION (jamais atteinte, le
 * membership étant contrôlé d'abord), le plafond de flux par utilisateur, et
 * la durée de vie absolue. Une branche non testée est une branche dont on
 * ignore si elle marche — et celles-ci portent de l'autorisation.
 */

/** Ouvre un compte + une organisation, et rend le cookie de session. */
async function compte(
  app: TestApp,
  suffixe: string,
): Promise<{ cookie: string; tenantId: string; userId: string }> {
  const signup = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: {
      email: `${suffixe}-${RUN}@example.com`,
      password: "a-strong-password-123",
      name: suffixe,
    },
  });
  const raw = signup.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw : [raw]).map((c) => String(c).split(";")[0]).join("; ");
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie },
    payload: { name: `Org ${suffixe} ${RUN}`, slug: `org-${suffixe}-${RUN}` },
  });
  const user = await admin.user.findFirstOrThrow({
    where: { email: `${suffixe}-${RUN}@example.com` },
    select: { id: true },
  });
  return { cookie, tenantId: org.json().id as string, userId: user.id };
}

const jusqua = async (predicat: () => boolean, limiteMs: number): Promise<boolean> => {
  const fin = Date.now() + limiteMs;
  while (Date.now() < fin) {
    if (predicat()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicat();
};

describe("les gardes du flux s'exécutent, elles ne sont pas seulement écrites", () => {
  it("une SESSION révoquée ferme le flux, appartenance intacte", async () => {
    /*
     * Mutation qui restait verte avant ce test : supprimer entièrement la
     * relecture de session du battement. Le membership est contrôlé D'ABORD,
     * donc le seul test existant (révocation d'appartenance) n'atteignait
     * jamais cette branche — c'est-à-dire jamais le cas le plus banal :
     * déconnexion, session expirée, session révoquée depuis un autre poste.
     */
    const { buildApp } = await import("../src/app.js");
    const { outboxSubscriberCount } = await import("../src/outboxRelay.js");
    const app = buildApp();
    await app.ready();
    try {
      const { cookie, tenantId, userId } = await compte(app, "sess-revoke");
      const stream = app.inject({
        method: "GET",
        url: "/events",
        headers: { cookie, "x-test-heartbeat-ms": "1000" },
      });
      expect(await jusqua(() => outboxSubscriberCount(tenantId) > 0, 5_000)).toBe(true);

      // L'appartenance reste INTACTE : seule la session disparaît.
      await admin.session.deleteMany({ where: { userId } });
      expect(
        await admin.membership.count({ where: { tenantId, userId } }),
        "l'appartenance doit rester : sinon c'est l'autre garde qu'on teste",
      ).toBe(1);
      expect(await jusqua(() => outboxSubscriberCount(tenantId) === 0, 10_000)).toBe(true);
      await stream.catch(() => undefined);
    } finally {
      await app.close();
    }
  }, 60_000);

  it("le battement NE PROLONGE PAS la session — relire n'est pas renouveler", async () => {
    /*
     * Sans `disableRefresh`, better-auth repousse l'expiration à chaque
     * lecture passé `updateAge` (24 h). Un onglet ouvert relit toutes les
     * 25 s : la session serait repoussée à +7 jours, indéfiniment, sans la
     * moindre action de l'utilisateur. Le contrôle censé DURCIR la route
     * aurait supprimé l'expiration par inactivité pour tout poste non
     * verrouillé.
     *
     * ON ISOLE LE BATTEMENT. La REQUÊTE d'ouverture passe par `requireAuth`,
     * qui relit la session sans `disableRefresh` — et c'est voulu : une
     * requête est une action de l'utilisateur, la fenêtre glissante est là
     * pour ça. Positionner l'expiration AVANT la connexion mesurait donc ce
     * rafraîchissement-là, pas celui qu'on veut interdire (mesuré : +2 jours,
     * dus à `requireAuth`). On ouvre d'abord, on repositionne ensuite.
     *
     * L'expiration est placée DANS la fenêtre de renouvellement (moins de 6
     * jours restants) : sans la garde, le premier battement la déplace.
     */
    const { buildApp } = await import("../src/app.js");
    const { outboxSubscriberCount } = await import("../src/outboxRelay.js");
    const app = buildApp();
    await app.ready();
    try {
      const { cookie, tenantId, userId } = await compte(app, "sess-renew");
      const stream = app.inject({
        method: "GET",
        url: "/events",
        headers: { cookie, "x-test-heartbeat-ms": "1000" },
      });
      expect(await jusqua(() => outboxSubscriberCount(tenantId) > 0, 5_000)).toBe(true);

      const cible = new Date(Date.now() + 5 * 86_400_000);
      await admin.session.updateMany({ where: { userId }, data: { expiresAt: cible } });
      // Laisser passer plusieurs battements : c'est leur répétition qui rend
      // le renouvellement pernicieux — l'utilisateur, lui, ne fait rien.
      await new Promise((r) => setTimeout(r, 3_500));

      const session = await admin.session.findFirstOrThrow({
        where: { userId },
        select: { expiresAt: true },
      });
      expect(
        session.expiresAt.getTime(),
        "le battement a repoussé l'expiration : un onglet ouvert rendrait la session éternelle",
      ).toBe(cible.getTime());
      // NE PAS attendre le flux : rien ne le coupe ici — session valide,
      // appartenance valide, durée de vie à trente minutes. C'est `app.close()`
      // qui le draine, dans le `finally` ; l'attendre avant le bloquerait.
      void stream.catch(() => undefined);
    } finally {
      await app.close();
    }
  }, 60_000);

  it("le PLAFOND de flux par utilisateur refuse le cinquième", async () => {
    /*
     * Mutation qui restait verte : remplacer `>= MAX_STREAMS_PER_USER` par
     * `>= 10_000`. Chaque flux retient un socket, une minuterie et une entrée
     * de registre : sans plafond, un onglet qui recharge en boucle épuise le
     * processus sans jamais franchir une garde d'authentification.
     */
    const { buildApp } = await import("../src/app.js");
    const { outboxSubscriberCount } = await import("../src/outboxRelay.js");
    const app = buildApp();
    await app.ready();
    try {
      const { cookie, tenantId } = await compte(app, "plafond");
      const flux = [0, 1, 2, 3].map(() =>
        app.inject({ method: "GET", url: "/events", headers: { cookie } }),
      );
      expect(await jusqua(() => outboxSubscriberCount(tenantId) >= 4, 10_000)).toBe(true);

      const refuse = await app.inject({ method: "GET", url: "/events", headers: { cookie } });
      expect(refuse.statusCode).toBe(429);
      for (const f of flux) void f.catch(() => undefined);
    } finally {
      await app.close();
    }
  }, 60_000);

  it("la DURÉE DE VIE absolue coupe le flux, même parfaitement autorisé", async () => {
    /*
     * Mutation qui restait verte : supprimer le `setTimeout(fermer, …)`. La
     * coupure périodique est ce qui empêche un flux de vivre des jours avec
     * un état que rien ne remet à zéro — et c'est aussi elle qui impose au
     * client de tout recharger à la reconnexion.
     */
    const { buildApp } = await import("../src/app.js");
    const { outboxSubscriberCount } = await import("../src/outboxRelay.js");
    const app = buildApp();
    await app.ready();
    try {
      const { cookie, tenantId } = await compte(app, "duree-vie");
      const stream = app.inject({
        method: "GET",
        url: "/events",
        headers: { cookie, "x-test-lifetime-ms": "300" },
      });
      expect(await jusqua(() => outboxSubscriberCount(tenantId) > 0, 5_000)).toBe(true);
      // Rien n'est révoqué : c'est la seule garde qui puisse couper ici.
      expect(await jusqua(() => outboxSubscriberCount(tenantId) === 0, 10_000)).toBe(true);
      await stream.catch(() => undefined);
    } finally {
      await app.close();
    }
  }, 60_000);
});
