import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, withTenant } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import type { PrismaClient } from "@prisma/client";
import { PENDING_ACTION_GROUPS } from "@nodaq/shared";
import { RETENTION_PAGE_SIZE, sweepTenantRetention } from "../src/retention.js";
import { defaultExecutors } from "../src/executors.js";

/*
 * Rétention de la file de validation (art. 5.1.e).
 *
 * Le trou que ce ticket ferme : une proposition JAMAIS décidée, dont la source
 * n'est jamais effacée, gardait son payload indéfiniment — un brouillon de
 * relance nomme un client et son montant dû, une dictée en porte le verbatim.
 *
 * Ce qui est testé, dans l'ordre d'importance : qu'on ne détruise pas ce qu'on
 * ne devrait pas, avant de vérifier qu'on détruit ce qu'on doit.
 */

let admin: PrismaClient;
let tenantA: string;
let tenantB: string;
let tenantC: string;
let tenantD: string;
const RUN = Date.now().toString(36);
const JOUR = 86_400_000;

/** « Maintenant » FIXE : un test de rétention ne doit pas dépendre de l'heure. */
const NOW = new Date("2026-08-04T09:00:00Z");
const ilYA = (jours: number) => new Date(NOW.getTime() - jours * JOUR);

/**
 * Repositionne les DEUX horodatages. `updated_at` compte autant que
 * `created_at` : c'est lui qui porte l'âge (dernière activité humaine), et
 * Prisma le remet à `now()` à chaque écriture — d'où le SQL brut.
 */
async function ageTo(id: string, at: Date): Promise<void> {
  await admin.$executeRaw`UPDATE pending_actions SET created_at = ${at}, updated_at = ${at} WHERE id = ${id}::uuid`;
}

async function seed(
  tenantId: string,
  type: string,
  status: string,
  activityAt: Date,
  payload: Record<string, unknown> = { draft: "Relance — M. Bernard, 1 180 € dus" },
): Promise<string> {
  const created = await withTenant(tenantId, (tx) =>
    tx.pendingAction.create({ data: { tenantId, type, status, payload } }),
  );
  await ageTo(created.id, activityAt);
  return created.id;
}

async function read(tenantId: string, id: string) {
  return withTenant(tenantId, (tx) => tx.pendingAction.findUniqueOrThrow({ where: { id } }));
}

beforeAll(async () => {
  admin = createAdminClient();
  tenantA = (await admin.tenant.create({ data: { name: `Reten A ${RUN}` } })).id;
  tenantB = (await admin.tenant.create({ data: { name: `Reten B ${RUN}` } })).id;
  tenantC = (await admin.tenant.create({ data: { name: `Reten C ${RUN}` } })).id;
  tenantD = (await admin.tenant.create({ data: { name: `Reten D ${RUN}` } })).id;
}, 30_000);

afterAll(async () => {
  const ids = [tenantA, tenantB, tenantC, tenantD];
  await admin.pendingAction.deleteMany({ where: { tenantId: { in: ids } } });
  await admin.tenant.deleteMany({ where: { id: { in: ids } } });
  await admin.user.deleteMany({ where: { email: `reten-${RUN}@nodaq.test` } });
  await admin.$disconnect();
  await prisma.$disconnect();
});

describe("le catalogue couvre ce qui existe VRAIMENT", () => {
  it("aucun type exécutable n'échappe au catalogue de rétention", () => {
    /*
     * L'inverse de la règle « un type inconnu n'est jamais détruit » :
     * « signaler » protège l'inconnu, ce n'est pas une excuse pour livrer un
     * type sans horizon. Ses propositions dormiraient alors indéfiniment, et
     * personne ne lit les logs.
     *
     * La liste est DÉRIVÉE du registre d'exécuteurs, jamais recopiée ici. Une
     * version précédente de ce test vivait dans `@nodaq/shared` et comparait
     * le catalogue à une liste écrite dans le test lui-même : ajouter un
     * exécuteur sans sa ligne de catalogue ne pouvait pas le faire échouer,
     * ce qui est exactement la dérive qu'il prétendait détecter.
     */
    const catalogued = new Set(PENDING_ACTION_GROUPS.flatMap((group) => group.types));
    const orphans = Object.keys(defaultExecutors).filter((type) => !catalogued.has(type));
    expect(orphans).toEqual([]);
  });
});

describe("ce qu'on NE détruit PAS", () => {
  it("une action récente est intacte", async () => {
    const id = await seed(tenantA, "send_dunning", "pending", ilYA(5));
    await sweepTenantRetention(tenantA, NOW);
    const after = await read(tenantA, id);
    expect(after.status).toBe("pending");
    expect((after.payload as Record<string, unknown>).draft).toContain("Bernard");
  });

  it("une action REPRISE hier survit, si vieille soit-elle", async () => {
    /*
     * LE cas que compter l'âge depuis la création aurait détruit.
     *
     * Deux routes réécrivent une action en la laissant `pending` : la reprise
     * du brouillon (`PATCH .../draft`) et le rattachement à un chantier
     * (`PATCH .../affaire`). Une proposition née il y a 200 jours mais
     * retravaillée hier est vivante — la rejeter « sans décision » aurait
     * effacé le texte que le dirigeant venait d'enregistrer, en l'accusant de
     * ne s'en être jamais occupé.
     */
    const id = await seed(tenantA, "send_dunning", "pending", ilYA(200));
    await admin.$executeRaw`UPDATE pending_actions SET updated_at = ${ilYA(1)} WHERE id = ${id}::uuid`;

    await sweepTenantRetention(tenantA, NOW);

    const after = await read(tenantA, id);
    expect(after.status).toBe("pending");
    expect((after.payload as Record<string, unknown>).draft).toContain("Bernard");
  });

  it("une reprise HUMAINE arrivée pendant le balayage gagne", async () => {
    /*
     * La course que la garde d'écriture conditionnelle existe pour perdre.
     *
     * La lecture d'une page ne pose aucun verrou : entre elle et l'écriture,
     * le dirigeant peut enregistrer un brouillon (`PATCH .../draft` laisse le
     * statut à `pending` et bouge `updated_at`). Sans `updatedAt` dans le
     * `where`, le balayage écrase ce texte tout juste enregistré et rejette
     * l'action « sans décision » — silencieusement, et de façon destructive.
     *
     * `onPageRead` n'existe que pour ce test. La course, elle, n'est PAS
     * simulée : l'écriture concurrente part d'une autre connexion et se valide
     * pour de bon avant que le balayage n'écrive.
     */
    const id = await seed(tenantB, "send_dunning", "pending", ilYA(90), {
      draft: "Relance — M. Bernard, 1 180 € dus",
    });

    const result = await sweepTenantRetention(tenantB, NOW, {
      onPageRead: async () => {
        await admin.$executeRaw`
          UPDATE pending_actions
             SET payload = ${{ draft: "Texte retravaillé à la main" }}::jsonb,
                 updated_at = now()
           WHERE id = ${id}::uuid`;
      },
    });

    const after = await read(tenantB, id);
    expect(after.status).toBe("pending");
    expect((after.payload as Record<string, unknown>).draft).toBe("Texte retravaillé à la main");
    // Et le compteur ne ment pas : rien n'a été rejeté.
    expect(result.rejected).toBe(0);

    /*
     * CONTRE-ÉPREUVE, sans laquelle tout ce qui précède passerait contre un
     * balayage qui ne fait rien du tout : la même ligne, sans écriture
     * concurrente, EST bien rejetée.
     *
     * Il faut d'abord la RE-VIEILLIR, et cette obligation dit quelque chose de
     * juste : la reprise humaine a remis l'horloge à zéro, donc le balayage
     * suivant la garde — non pas parce qu'il est inerte, mais parce que la
     * ligne est redevenue vivante. C'est le comportement voulu.
     */
    await ageTo(id, ilYA(90));
    const sansCourse = await sweepTenantRetention(tenantB, NOW);
    expect(sansCourse.rejected).toBeGreaterThanOrEqual(1);
    expect((await read(tenantB, id)).status).toBe("rejected");
  });

  it("un type HORS CATALOGUE n'est jamais réduit, même très vieux", async () => {
    // Même asymétrie qu'en F6 : un outil livré avant sa ligne de catalogue
    // verrait ses propositions effacées par une règle qui ne le connaît pas.
    const id = await seed(tenantA, "un_outil_de_demain", "pending", ilYA(5_000));
    const result = await sweepTenantRetention(tenantA, NOW);
    const after = await read(tenantA, id);
    expect(after.status).toBe("pending");
    expect((after.payload as Record<string, unknown>).reduced).toBeUndefined();
    // …mais il est SIGNALÉ, pour que quelqu'un le classe.
    expect(result.unclassified).toContain("un_outil_de_demain");
  });

  it("le balayage d'un tenant ne touche PAS les actions d'un autre", async () => {
    // La propriété qui compte : le balayage passe par `withTenant`, jamais par
    // un `updateMany` global qui contournerait la RLS.
    const chezB = await seed(tenantB, "send_dunning", "pending", ilYA(400));
    // Une cible chez A, pour que le balayage ait quelque chose à faire : sans
    // elle, « B est intact » serait vrai d'un balayage qui ne fait rien.
    const chezA = await seed(tenantA, "send_dunning", "pending", ilYA(400));

    const result = await sweepTenantRetention(tenantA, NOW);

    expect(result.scanned).toBeGreaterThan(0);
    expect((await read(tenantA, chezA)).status).toBe("rejected");
    const after = await read(tenantB, chezB);
    expect(after.status).toBe("pending");
    expect((after.payload as Record<string, unknown>).draft).toContain("Bernard");
  });
});

describe("ce qu'on réduit, et comment", () => {
  it("une action en attente au-delà de son horizon est rejetée ET réduite", async () => {
    const id = await seed(tenantA, "send_dunning", "pending", ilYA(45));
    const result = await sweepTenantRetention(tenantA, NOW);
    const after = await read(tenantA, id);

    // Les deux ensemble : réduire sans rejeter laisserait dans la file une
    // proposition qu'on ne peut plus lire, donc plus décider.
    expect(after.status).toBe("rejected");
    const payload = after.payload as Record<string, unknown>;
    expect(payload.reduced).toBe(true);
    expect(payload.draft).toBeUndefined();
    // Le motif est écrit : une ligne vide sans explication passe pour un bug.
    expect(String(payload.reducedReason)).toContain("sans décision");
    expect(result.rejected).toBeGreaterThanOrEqual(1);

    /*
     * Rejet MACHINE : `validatedBy` reste nul. C'est ce que l'écran lit pour
     * afficher « Expirée » et non « Rejetée » — faire porter au dirigeant un
     * refus qu'il n'a jamais prononcé serait un mensonge de plus dans son
     * historique, pas une simplification.
     */
    expect(after.validatedBy).toBeNull();
    expect(after.validatedAt).toBeNull();
  });

  it("une DICTÉE jamais décidée perd son verbatim — et tout le reste", async () => {
    /*
     * Le cas qui a motivé le ticket. L'audio n'est pas conservé, mais la
     * transcription l'était : nom du client, adresse du chantier, et ce que le
     * micro a capté à côté. Aucune purge de l'article 17 ne l'atteignait.
     *
     * L'assertion porte sur la LISTE EXACTE des clés survivantes, pas sur
     * l'absence de tel ou tel mot : un `not.toContain("Martin")` passerait
     * contre un payload qui garderait l'adresse et le montant.
     */
    const id = await seed(tenantA, "create_quote", "pending", ilYA(70), {
      source: "dictee",
      transcript:
        "Alors pour madame Martin, 12 rue des Lilas à Cesson, deux cent cinquante mètres de clôture rigide",
      quote: {
        customer: "Mme Martin",
        lines: [{ label: "clôture rigide", quantity: 250, itemName: "Clôture rigide 1m50" }],
      },
    });

    await sweepTenantRetention(tenantA, NOW);

    const after = await read(tenantA, id);
    expect(after.status).toBe("rejected");
    const payload = after.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["reduced", "reducedAt", "reducedReason"]);
    expect(JSON.stringify(payload)).not.toMatch(/Martin|Lilas|Cesson|clôture/i);
  });

  it("chaque groupe a SON horizon — une immobilisation survit à une relance", async () => {
    // 45 jours : au-delà de l'horizon des relances (30), en deçà de celui des
    // immobilisations (180). Un horizon unique aurait détruit les deux.
    const relance = await seed(tenantA, "send_dunning", "pending", ilYA(45));
    const immo = await seed(tenantA, "create_fixed_asset", "pending", ilYA(45), {
      label: "Camionnette",
      baseCents: 1_800_000,
    });
    await sweepTenantRetention(tenantA, NOW);

    expect((await read(tenantA, relance)).status).toBe("rejected");
    const gardee = await read(tenantA, immo);
    expect(gardee.status).toBe("pending");
    expect((gardee.payload as Record<string, unknown>).label).toBe("Camionnette");
  });

  it("une action DÉCIDÉE perd son contenu mais garde sa décision", async () => {
    // Qui a validé quoi, et quand, est une trace définitive. Ce sur quoi la
    // décision portait ne l'est pas.
    const validateur = (await admin.user.create({
      data: { email: `reten-${RUN}@nodaq.test`, name: "Patron" },
    })).id;
    const id = await seed(tenantA, "send_dunning", "executed", ilYA(400));
    await admin.pendingAction.update({
      where: { id },
      data: { validatedBy: validateur, validatedAt: ilYA(400) },
    });
    await ageTo(id, ilYA(400));

    await sweepTenantRetention(tenantA, NOW);

    const after = await read(tenantA, id);
    expect(after.status).toBe("executed");
    expect((after.payload as Record<string, unknown>).draft).toBeUndefined();
    expect((after.payload as Record<string, unknown>).reduced).toBe(true);
    /*
     * L'ATTRIBUTION survit à la réduction, et ce n'est pas un détail : c'est
     * exactement ce que l'historique lit pour distinguer un refus humain d'un
     * rejet machine. Si la réduction effaçait `validatedBy`, une action que le
     * patron a bel et bien validée s'afficherait « rejetée automatiquement ».
     */
    expect(after.validatedBy).toBe(validateur);
    expect(after.validatedAt).not.toBeNull();
  });

  it("une réduction PARTIELLE d'un autre mécanisme finit par perdre son résidu", async () => {
    /*
     * `reduceFinishedPayload` réduit à la décision, mais pas jusqu'au bout :
     * il conserve `invoiceNumber`, `grossCents` et `label` sur un
     * `submit_einvoice`, `prospectId` et `stage` sur une relance prospect —
     * y compris après qu'un prospect s'est OPPOSÉ. La borne d'un an existe
     * précisément pour ces résidus.
     *
     * D'où le marqueur d'exclusion : `reducedAt`, écrit par ce seul balayage.
     * Filtrer sur `reduced` — que les trois mécanismes écrivent — aurait rendu
     * ces lignes structurellement inatteignables, et le doc aurait promis
     * « rien ne survit » sur un balayage qui ne les regardait plus jamais.
     */
    const id = await seed(tenantA, "submit_einvoice", "executed", ilYA(400), {
      reduced: true,
      invoiceNumber: "F-2025-0043",
      grossCents: 486_000,
      label: "Dépôt de la facture F-2025-0043",
    });

    await sweepTenantRetention(tenantA, NOW);

    const payload = (await read(tenantA, id)).payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["reduced", "reducedAt", "reducedReason"]);
    expect(JSON.stringify(payload)).not.toContain("F-2025-0043");
  });

  it("le balayage est IDEMPOTENT, et la ligne SORT de la lecture", async () => {
    /*
     * Tenant dédié, et une assertion sur `scanned` — pas seulement sur les
     * compteurs d'écriture.
     *
     * Une version précédente n'assertait que `rejected === 0` et
     * `reduced === 0` au second passage. Elle serait restée verte sans le
     * filtre `payload->'reducedAt' IS NULL` : `@updatedAt` remet `updated_at`
     * à maintenant lors de la réduction, donc au tour suivant l'âge vaut zéro
     * et la règle rend « garder » de toute façon. Le test aurait donc validé
     * l'idempotence tout en laissant tomber la propriété ANTI-FAMINE, qui est
     * la vraie raison d'être de ce filtre : la ligne doit disparaître de la
     * lecture, pas seulement échapper à l'écriture.
     */
    await seed(tenantD, "send_dunning", "pending", ilYA(45));

    const premier = await sweepTenantRetention(tenantD, NOW);
    const second = await sweepTenantRetention(tenantD, NOW);

    expect(premier.scanned).toBe(1);
    expect(premier.rejected).toBe(1);
    // La tête de file a RÉTRÉCI : plus rien à lire chez ce tenant.
    expect(second.scanned).toBe(0);
    expect(second.rejected).toBe(0);
    expect(second.reduced).toBe(0);
  });
});

describe("le balayage AVANCE", () => {
  /*
   * LA propriété que la première version n'avait pas, et le défaut le plus
   * grave qu'elle portait.
   *
   * `pending_actions` ne perd jamais de ligne : réduire ne supprime pas. Une
   * lecture « les N plus anciennes » se fige donc sur une tête de file faite
   * de lignes déjà réduites et de types hors catalogue — ces derniers gardant
   * leur place À VIE, puisqu'on refuse de les détruire. Passé N, plus rien de
   * neuf n'était jamais examiné : la rétention s'arrêtait pour toujours, sans
   * une erreur ni un compteur pour le dire.
   */
  const TETE = RETENTION_PAGE_SIZE + 10;

  /*
   * La tête est semée ICI, pas dans le premier `it`.
   *
   * Elle l'était, et le test de troncature en dépendait sans le dire : sous
   * `--shuffle`, en `.only`, ou si le premier test disparaissait, le seul test
   * qui couvre la borne de pages serait devenu faux — `scanned` à 1 et
   * `truncated` à false — sans que rien ne signale qu'il ne testait plus rien.
   */
  beforeAll(async () => {
    await admin.pendingAction.createMany({
      data: Array.from({ length: TETE }, () => ({
        tenantId: tenantC,
        type: "un_outil_de_demain",
        status: "pending",
        payload: {},
      })),
    });
    // Toute la tête est TRÈS vieille : elle passe donc en premier dans l'ordre
    // de lecture, et aucune règle ne peut la faire disparaître.
    await admin.$executeRaw`UPDATE pending_actions SET created_at = ${ilYA(1_000)}, updated_at = ${ilYA(1_000)} WHERE tenant_id = ${tenantC}::uuid`;
  }, 60_000);

  it("une tête de file INTOUCHABLE plus longue qu'une page ne bloque pas la suite", async () => {
    // La cible arrive APRÈS la tête : elle n'est atteignable qu'en paginant.
    const cible = await seed(tenantC, "send_dunning", "pending", ilYA(45));

    const result = await sweepTenantRetention(tenantC, NOW);

    expect(result.scanned).toBe(TETE + 1);
    expect(result.truncated).toBe(false);
    expect((await read(tenantC, cible)).status).toBe("rejected");
  }, 60_000);

  it("un passage TRONQUÉ le dit, au lieu de se faire passer pour complet", async () => {
    // Une seule page autorisée : la cible, qui est en deuxième page (la tête
    // du `beforeAll` en occupe une entière), doit survivre — et le résultat
    // doit ANNONCER qu'il reste du travail. Un balayage tronqué muet
    // laisserait croire que le tenant est à jour.
    const cible = await seed(tenantC, "send_dunning", "pending", ilYA(45));

    const result = await sweepTenantRetention(tenantC, NOW, { maxPages: 1 });

    expect(result.truncated).toBe(true);
    expect(result.scanned).toBe(RETENTION_PAGE_SIZE);
    expect((await read(tenantC, cible)).status).toBe("pending");
  }, 60_000);
});

/*
 * TRANSCRIPTIONS D'AGENT (art. 5.1.e).
 *
 * `agent_conversations.messages` porte le fil complet, résultats d'outils
 * compris — la donnée la plus concentrée du produit, dans sa forme la moins
 * structurée. Et rien ne l'effaçait : son seul usage est de REPRENDRE la
 * conversation, or l'identifiant ne vit que dans un `useRef` de l'écran de
 * chat. Un rechargement de page rendait la ligne illisible à vie.
 */
describe("transcriptions d'agent — une conversation dormante n'est plus une conversation", () => {
  async function seedConversation(tenantId: string, at: Date): Promise<string> {
    const created = await withTenant(tenantId, (tx) =>
      tx.agentConversation.create({
        data: {
          tenantId,
          employee: "compta",
          messages: [
            { role: "user", content: "mes impayés ?" },
            { role: "tool", content: '{"client":"SARL Dupont","dueCents":450000}' },
          ],
        },
      }),
    );
    await admin.$executeRaw`UPDATE agent_conversations SET updated_at = ${at} WHERE id = ${created.id}::uuid`;
    return created.id;
  }

  const vit = async (tenantId: string, id: string): Promise<boolean> =>
    (await withTenant(tenantId, (tx) => tx.agentConversation.findUnique({ where: { id } }))) !==
    null;

  it("une conversation dormante est SUPPRIMÉE, et le passage le compte", async () => {
    const vieille = await seedConversation(tenantD, ilYA(40));

    const result = await sweepTenantRetention(tenantD, NOW);

    expect(result.conversationsSupprimees).toBeGreaterThanOrEqual(1);
    expect(await vit(tenantD, vieille)).toBe(false);
  }, 60_000);

  it("une conversation ACTIVE survit — l'âge se compte sur la dernière activité", async () => {
    /*
     * La dater de sa création la supprimerait sous les doigts de
     * l'utilisateur : le runtime réécrit la ligne à chaque tour, donc une
     * conversation entretenue depuis des mois est ACTIVE, pas ancienne.
     */
    const recente = await seedConversation(tenantD, ilYA(2));

    await sweepTenantRetention(tenantD, NOW);

    expect(await vit(tenantD, recente)).toBe(true);
  }, 60_000);

  it("le balayage ne franchit JAMAIS la frontière de tenant", async () => {
    /*
     * La suppression est un `DELETE` sans clause de tenant : elle ne tient
     * QUE par la RLS de `withTenant`. Si ce balayage passait un jour par le
     * client admin — la tentation d'un job « global » —, il viderait les
     * conversations de tous les tenants en une nuit, sans un mot.
     */
    const voisine = await seedConversation(tenantC, ilYA(40));
    const cible = await seedConversation(tenantD, ilYA(40));

    await sweepTenantRetention(tenantD, NOW);

    expect(await vit(tenantD, cible)).toBe(false);
    expect(await vit(tenantC, voisine)).toBe(true);
  }, 60_000);

  it("l'horizon est celui de la règle partagée, pas un nombre écrit ici", async () => {
    // Un seuil recopié dans la route dériverait du seuil documenté sans que
    // personne ne le voie : le passage prend le sien de `@nodaq/shared`.
    const { CONVERSATION_RETENTION_DAYS } = await import("@nodaq/shared");
    const juste = await seedConversation(tenantD, ilYA(CONVERSATION_RETENTION_DAYS - 1));
    const juste2 = await seedConversation(tenantD, ilYA(CONVERSATION_RETENTION_DAYS + 1));

    await sweepTenantRetention(tenantD, NOW);

    expect(await vit(tenantD, juste)).toBe(true);
    expect(await vit(tenantD, juste2)).toBe(false);
  }, 60_000);
});
