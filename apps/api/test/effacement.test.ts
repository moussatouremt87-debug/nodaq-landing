import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma, withTenant } from "@nodaq/db";
import { buildApp } from "../src/app.js";

/*
 * Droit à l'effacement (RGPD art. 17) — ce que les purges LAISSAIENT derrière.
 *
 * Le fil de ces tests n'est pas « la ligne est-elle partie » mais « le produit
 * tient-il ce qu'il affirme ». Trois routes se disaient effaçantes et ne
 * l'étaient qu'à moitié :
 *
 *   - la purge FEC effaçait le journal, pas les propositions qui en dérivent ;
 *   - effacer une pièce du classeur laissait une proposition portant le nom du
 *     fournisseur ;
 *   - effacer un prospect laissait son nom et son ADRESSE recopiés sur les
 *     affaires.
 *
 * Un effacement sans test est une promesse. Ces tests sont la promesse tenue.
 */

let app: FastifyInstance;
let ownerCookie: string;
let orgA: string;
/* Second tenant RÉEL. Un UUID inexistant ne prouve rien sur l'isolation : le
 * rejet serait identique avec ou sans RLS. Seule une fiche qui EXISTE ailleurs
 * distingue « invisible parce qu'un autre tenant la détient » de
 * « inexistante ». */
let autreCookie: string;
let prospectAutreTenant: string;

const RUN = Date.now().toString(36);

function cookiesOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.map((c) => String(c).split(";")[0]).join("; ");
}

beforeAll(async () => {
  app = buildApp();
  await app.ready();

  const signup = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: {
      email: `eff-owner-${RUN}@example.com`,
      password: "a-strong-password-123",
      name: "Eff Owner",
    },
  });
  ownerCookie = cookiesOf(signup);
  const org = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: ownerCookie },
    payload: { name: `Org Eff ${RUN}`, slug: `org-eff-${RUN}` },
  });
  orgA = org.json().id as string;

  const autreSignup = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: {
      email: `eff-autre-${RUN}@example.com`,
      password: "a-strong-password-123",
      name: "Eff Autre",
    },
  });
  autreCookie = cookiesOf(autreSignup);
  await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: autreCookie },
    payload: { name: `Org Autre ${RUN}`, slug: `org-autre-${RUN}` },
  });
  const fiche = await app.inject({
    method: "POST",
    url: "/prospects",
    headers: { cookie: autreCookie },
    payload: { name: `Fiche Voisine ${RUN}`, stage: "nouveau", source: "recommandation" },
  });
  prospectAutreTenant = fiche.json().id as string;
}, 60_000);

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/** Proposition d'immobilisation telle que l'import FEC ou le classeur la crée. */
async function seedProposal(sourceRef: string, status = "pending"): Promise<string> {
  const created = await withTenant(orgA, (tx) =>
    tx.pendingAction.create({
      data: {
        tenantId: orgA,
        type: "create_fixed_asset",
        status,
        employee: "compta",
        payload: {
          // Ce que la purge doit faire disparaître : un libellé de compte ou un
          // nom de fournisseur, et des montants tirés de la source.
          label: "Camionnette — SARL Dupont",
          category: "materiel_transport",
          baseCents: 1_800_000,
          sourceRef,
          source: "FEC",
          priorDepreciationCents: 300_000,
          warnings: ["durée proposée — à ajuster"],
        },
      },
    }),
  );
  return created.id;
}

async function payloadOf(id: string): Promise<Record<string, unknown>> {
  const row = await withTenant(orgA, (tx) =>
    tx.pendingAction.findUniqueOrThrow({ where: { id } }),
  );
  return row.payload as Record<string, unknown>;
}

describe("purge FEC — les dérivés partent avec la source", () => {
  it("une proposition EN ATTENTE est rejetée ET réduite", async () => {
    // Approuver une proposition dont le journal a disparu créerait une
    // immobilisation que plus personne ne peut vérifier.
    await withTenant(orgA, (tx) =>
      tx.fecImport.create({
        data: {
          tenantId: orgA,
          fileHash: `hash-purge-${RUN}`,
          entryCount: 1,
          customerCount: 0,
          invoiceCount: 0,
          overdueCount: 0,
          overdueCents: 0,
          warnings: [],
        },
      }),
    );
    const proposalId = await seedProposal(`fec:2182-${RUN}`);

    const res = await app.inject({
      method: "DELETE",
      url: "/connectors/fec",
      headers: { cookie: ownerCookie },
    });
    // La purge DIT ce qu'elle a fait : rejeter 200 propositions en silence
    // contredirait le principe même de ce ticket.
    expect(res.statusCode).toBe(200);
    expect(res.json().propositionsRejetees).toBeGreaterThanOrEqual(1);

    const row = await withTenant(orgA, (tx) =>
      tx.pendingAction.findUniqueOrThrow({ where: { id: proposalId } }),
    );
    expect(row.status).toBe("rejected");
    const payload = row.payload as Record<string, unknown>;
    expect(payload.reduced).toBe(true);
    // Le test qui compte : plus AUCUN dérivé du journal.
    expect(payload.label).toBeUndefined();
    expect(payload.baseCents).toBeUndefined();
    expect(payload.priorDepreciationCents).toBeUndefined();
    expect(payload.warnings).toBeUndefined();
  });

  it("une proposition DÉJÀ REJETÉE perd ses dérivés — le cas majoritaire", async () => {
    /*
     * Le trou que la revue a trouvé. Filtrer « tout sauf rejected » pour ne pas
     * repasser sur ce qu'on vient de rejeter excluait aussi les propositions
     * rejetées AVANT la purge — c'est-à-dire l'état décidé le plus fréquent,
     * puisque l'écran de validation dit lui-même « Catégorie ou durée à
     * ajuster ? Rejetez, puis saisissez manuellement ». Le cas le plus courant
     * échappait entièrement à l'effacement.
     */
    await withTenant(orgA, (tx) =>
      tx.fecImport.create({
        data: {
          tenantId: orgA,
          fileHash: `hash-rejete-${RUN}`,
          entryCount: 1,
          customerCount: 0,
          invoiceCount: 0,
          overdueCount: 0,
          overdueCents: 0,
          warnings: [],
        },
      }),
    );
    const proposalId = await seedProposal(`fec:2184-${RUN}`, "rejected");

    await app.inject({
      method: "DELETE",
      url: "/connectors/fec",
      headers: { cookie: ownerCookie },
    });

    const payload = await payloadOf(proposalId);
    expect(payload.reduced).toBe(true);
    expect(payload.label).toBeUndefined();
    expect(payload.sourceRef).toBeUndefined();
  });

  it("une proposition DÉJÀ DÉCIDÉE garde sa trace, mais perd ses dérivés", async () => {
    // Qui a décidé quoi, et quand, n'est pas une donnée dérivée du journal :
    // c'est la trace d'une décision humaine. L'effacement d'une source ne
    // réécrit pas l'histoire — il retire ce qui venait de la source.
    await withTenant(orgA, (tx) =>
      tx.fecImport.create({
        data: {
          tenantId: orgA,
          fileHash: `hash-purge2-${RUN}`,
          entryCount: 1,
          customerCount: 0,
          invoiceCount: 0,
          overdueCount: 0,
          overdueCents: 0,
          warnings: [],
        },
      }),
    );
    const proposalId = await seedProposal(`fec:2183-${RUN}`, "executed");

    await app.inject({
      method: "DELETE",
      url: "/connectors/fec",
      headers: { cookie: ownerCookie },
    });

    const row = await withTenant(orgA, (tx) =>
      tx.pendingAction.findUniqueOrThrow({ where: { id: proposalId } }),
    );
    expect(row.status).toBe("executed");
    const payload = row.payload as Record<string, unknown>;
    expect(payload.reduced).toBe(true);
    expect(payload.label).toBeUndefined();
  });
});

describe("classeur — effacer la pièce efface ce qui en dérive", () => {
  it("la proposition née de la photo perd le nom du fournisseur", async () => {
    const document = await withTenant(orgA, (tx) =>
      tx.classeurDocument.create({
        data: {
          tenantId: orgA,
          fileName: "facture.jpg",
          mimeType: "image/jpeg",
          byteSize: 1024,
          photo: Buffer.from("photo"),
          sha256: `sha-${RUN}-principal`,
          status: "a_verifier",
        },
      }),
    );
    const proposalId = await seedProposal(`classeur:${document.id}`);

    const res = await app.inject({
      method: "DELETE",
      url: `/classeur/documents/${document.id}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(204);

    const payload = await payloadOf(proposalId);
    expect(payload.reduced).toBe(true);
    expect(payload.label).toBeUndefined();
  });

  it("effacer une pièce ne touche PAS la proposition d'une AUTRE pièce", async () => {
    // Le préfixe `classeur:<id>` doit viser une pièce, pas toutes. Sans cette
    // garde, effacer un document réduirait la file entière.
    const [gardee, effacee] = await Promise.all([
      withTenant(orgA, (tx) =>
        tx.classeurDocument.create({
          data: {
            tenantId: orgA,
            fileName: "gardee.jpg",
            mimeType: "image/jpeg",
            byteSize: 10,
            photo: Buffer.from("a"),
            sha256: `sha-${RUN}-gardee`,
            status: "a_verifier",
          },
        }),
      ),
      withTenant(orgA, (tx) =>
        tx.classeurDocument.create({
          data: {
            tenantId: orgA,
            fileName: "effacee.jpg",
            mimeType: "image/jpeg",
            byteSize: 10,
            photo: Buffer.from("b"),
            sha256: `sha-${RUN}-effacee`,
            status: "a_verifier",
          },
        }),
      ),
    ]);
    const survivante = await seedProposal(`classeur:${gardee.id}`);
    const condamnee = await seedProposal(`classeur:${effacee.id}`);

    await app.inject({
      method: "DELETE",
      url: `/classeur/documents/${effacee.id}`,
      headers: { cookie: ownerCookie },
    });

    expect((await payloadOf(condamnee)).reduced).toBe(true);
    // L'assertion DISCRIMINANTE : sans le préfixe par pièce, celle-ci tombait
    // aussi. Vérifier seulement que la condamnée est réduite passerait contre
    // un no-op comme contre un effacement trop large.
    expect((await payloadOf(survivante)).label).toBe("Camionnette — SARL Dupont");
    expect((await payloadOf(survivante)).reduced).toBeUndefined();
  });

  it("les deux sources ne se marchent pas dessus", async () => {
    // `fec:` et `classeur:<id>` doivent se borner l'un l'autre : une purge FEC
    // qui réduirait les propositions du classeur (ou l'inverse) effacerait des
    // données que personne n'a demandé d'effacer.
    const document = await withTenant(orgA, (tx) =>
      tx.classeurDocument.create({
        data: {
          tenantId: orgA,
          fileName: "croisee.jpg",
          mimeType: "image/jpeg",
          byteSize: 10,
          photo: Buffer.from("c"),
          sha256: `sha-${RUN}-croisee`,
          status: "a_verifier",
        },
      }),
    );
    const duClasseur = await seedProposal(`classeur:${document.id}`);
    await withTenant(orgA, (tx) =>
      tx.fecImport.create({
        data: {
          tenantId: orgA,
          fileHash: `hash-croise-${RUN}`,
          entryCount: 1,
          customerCount: 0,
          invoiceCount: 0,
          overdueCount: 0,
          overdueCents: 0,
          warnings: [],
        },
      }),
    );
    const duFec = await seedProposal(`fec:2185-${RUN}`);

    // Purge FEC : elle ne doit toucher QUE la proposition du journal.
    await app.inject({
      method: "DELETE",
      url: "/connectors/fec",
      headers: { cookie: ownerCookie },
    });
    expect((await payloadOf(duFec)).reduced).toBe(true);
    expect((await payloadOf(duClasseur)).label).toBe("Camionnette — SARL Dupont");
  });
});

describe("les préfixes viennent des VRAIS producteurs", () => {
  it("le code qui crée les propositions et celui qui les efface s'accordent", () => {
    /*
     * Les tests ci-dessus fabriquent leurs payloads à la main. Si un
     * producteur renommait son préfixe (`fec:` -> `journal:`), l'effacement
     * cesserait de mordre et toute la suite resterait verte.
     *
     * Cette garde lit le CODE SOURCE : les préfixes passés à
     * `reduceDerivedProposals` doivent être exactement ceux que les
     * producteurs écrivent dans `sourceRef`.
     */
    const source = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    // Producteurs (import FEC, extraction classeur).
    expect(source).toContain("const sourceRef = `fec:${proposal.accountNum}`");
    expect(source).toContain("sourceRef: `classeur:${document.id}`");
    // Effaceurs.
    expect(source).toContain('sourceRefPrefix: "fec:"');
    expect(source).toContain("sourceRefPrefix: `classeur:${id}`");
  });
});

describe("prospect — l'identité recopiée sur les affaires", () => {
  async function seedProspect(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/prospects",
      headers: { cookie: ownerCookie },
      payload: { name: `Jean Dupont ${RUN}`, stage: "nouveau", source: "recommandation" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function seedAffaire(prospectId: string, status: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/affaires",
      headers: { cookie: ownerCookie },
      payload: {
        label: `Chantier ${status}`,
        prospectId,
        status,
        clientName: "Jean Dupont",
        address: "12 rue des Lilas, Aix-en-Provence",
        latitude: 43.53,
        longitude: 5.45,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it("une affaire JAMAIS contractée est anonymisée : nom, adresse et GPS", async () => {
    // Un devis perdu ne fonde RIEN. Garder l'adresse — souvent le domicile —
    // d'une personne qui demande son effacement n'a aucune base.
    const prospectId = await seedProspect();
    const perdue = await seedAffaire(prospectId, "PERDUE");

    const res = await app.inject({
      method: "DELETE",
      url: `/prospects/${prospectId}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().affairesAnonymisees).toBe(1);

    const after = await withTenant(orgA, (tx) =>
      tx.affaire.findUniqueOrThrow({ where: { id: perdue } }),
    );
    expect(after.clientName).toBeNull();
    expect(after.address).toBeNull();
    expect(after.latitude).toBeNull();
    expect(after.longitude).toBeNull();
    // L'affaire SURVIT : c'est un effacement de données personnelles, pas la
    // destruction d'un historique de chantiers.
    expect(after.label).toBe("Chantier PERDUE");
  });

  it("PERDUE avec des TRACES d'exécution est conservée — le statut ne suffit pas", async () => {
    /*
     * `EN_COURS -> PERDUE` est un chemin banal : chantier commencé puis
     * abandonné, client défaillant. Anonymiser sur le seul mot « PERDUE »
     * détruisait la preuve d'un travail réellement effectué — l'erreur exacte
     * pour laquelle ARCHIVEE était déjà épargnée, appliquée à une famille et
     * pas à l'autre.
     */
    const prospectId = await seedProspect();
    const perdue = await seedAffaire(prospectId, "PERDUE");
    // Un fait, pas un libellé : des heures ont été pointées.
    await app.inject({
      method: "PATCH",
      url: `/affaires/${perdue}`,
      headers: { cookie: ownerCookie },
      payload: { hoursWorked: 12 },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/prospects/${prospectId}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.json().affairesAnonymisees).toBe(0);
    expect(res.json().affairesConservees[0].motif).toContain("heures");

    const after = await withTenant(orgA, (tx) =>
      tx.affaire.findUniqueOrThrow({ where: { id: perdue } }),
    );
    expect(after.clientName).toBe("Jean Dupont");
  });

  it("une affaire EN COURS garde ses données — l'exécution du contrat les fonde", async () => {
    const prospectId = await seedProspect();
    const enCours = await seedAffaire(prospectId, "EN_COURS");

    const res = await app.inject({
      method: "DELETE",
      url: `/prospects/${prospectId}`,
      headers: { cookie: ownerCookie },
    });
    expect(res.json().affairesAnonymisees).toBe(0);
    const conservees = res.json().affairesConservees;
    expect(conservees).toHaveLength(1);
    expect(conservees[0].motif).toContain("contrat");

    const after = await withTenant(orgA, (tx) =>
      tx.affaire.findUniqueOrThrow({ where: { id: enCours } }),
    );
    expect(after.clientName).toBe("Jean Dupont");
  });

  it("une affaire ARCHIVÉE est conservée et SIGNALÉE — ce qui reste est dit", async () => {
    // L'archivage est la sortie commune des affaires gagnées ET perdues : le
    // statut ne dit plus si un contrat a existé. Trancher au hasard détruirait
    // de la donnée contractuelle une fois sur deux. On rapporte, et l'owner
    // termine à la main.
    const prospectId = await seedProspect();
    await seedAffaire(prospectId, "ARCHIVEE");
    await seedAffaire(prospectId, "PROSPECT");

    const res = await app.inject({
      method: "DELETE",
      url: `/prospects/${prospectId}`,
      headers: { cookie: ownerCookie },
    });
    const body = res.json();
    expect(body.affairesAnonymisees).toBe(1);
    expect(body.affairesConservees).toHaveLength(1);
    expect(body.affairesConservees[0].status).toBe("ARCHIVEE");
    // Le motif rend le reste ACTIONNABLE : sans lui, l'owner ne saurait pas
    // qu'il lui reste quelque chose à décider.
    expect(body.affairesConservees[0].motif).toContain("à vérifier");
    expect(body.affairesConservees[0].reference).toMatch(/^\d{4}-\d{3}$/);
  });
});

/*
 * L'EFFACEMENT QUI SE DÉFAIT TOUT SEUL.
 *
 * Le bloc précédent anonymise les affaires qui portent l'identité recopiée.
 * Il ne suffit pas : le bloc 2 (contrats récurrents) a introduit une SOURCE DE
 * RECOPIE. Matérialiser une échéance écrit `contrat.clientName` sur l'affaire
 * générée. Un contrat d'entretien mensuel effacé aujourd'hui réécrit donc le
 * nom sur une affaire neuve au prochain clic — et l'effacement, techniquement
 * exécuté, n'a rien effacé du tout un mois plus tard.
 *
 * Tarir la source est la seule correction : un chiffre supprimé qui revient
 * n'est pas un effacement, c'est un délai.
 */
describe("contrat — la source qui RÉÉCRIT le nom effacé", () => {
  async function seedProspect(nom: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/prospects",
      headers: { cookie: ownerCookie },
      payload: { name: nom, stage: "nouveau", source: "recommandation" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  /** `status` n'existe pas à la création (le contrat naît ACTIF) : on le pose ensuite. */
  async function seedContrat({
    status,
    ...payload
  }: Record<string, unknown> & { status?: string }): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/contrats",
      headers: { cookie: ownerCookie },
      payload: {
        label: `Entretien ${RUN}`,
        cadence: "mensuel",
        amountCents: 20_000,
        // Départ dans le passé : au moins une échéance est due tout de suite.
        startDate: "2026-01-15",
        ...payload,
      },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    if (status !== undefined && status !== "ACTIF") {
      const patched = await app.inject({
        method: "PATCH",
        url: `/contrats/${id}`,
        headers: { cookie: ownerCookie },
        payload: { status },
      });
      expect(patched.statusCode).toBe(200);
    }
    return id;
  }

  async function materialiser(contratId: string): Promise<string[]> {
    const res = await app.inject({
      method: "POST",
      url: `/contrats/${contratId}/occurrences`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode).toBe(200);
    return (res.json().created as { id: string }[]).map((row) => row.id);
  }

  it("après effacement, une NOUVELLE matérialisation ne réécrit plus le nom", async () => {
    /*
     * LE TEST QUI PORTE CE TICKET. Sans lui, tout le reste est cosmétique :
     * on peut anonymiser douze affaires et voir le nom revenir au treizième
     * clic. La chaîne testée est complète — fiche effacée, puis un geste
     * ORDINAIRE du dirigeant un mois plus tard.
     */
    const prospectId = await seedProspect(`Marc Renard ${RUN}`);
    const contratId = await seedContrat({
      prospectId,
      clientName: "Marc Renard",
      // Terminé : rien ne fonde de le conserver.
      status: "TERMINE",
    });

    const del = await app.inject({
      method: "DELETE",
      url: `/prospects/${prospectId}`,
      headers: { cookie: ownerCookie },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().contratsAnonymises).toBe(1);

    // Le contrat SURVIT — c'est un effacement de données personnelles, pas la
    // destruction d'un engagement commercial.
    const apres = await withTenant(orgA, (tx) =>
      tx.contrat.findUniqueOrThrow({ where: { id: contratId } }),
    );
    expect(apres.clientName).toBeNull();
    expect(apres.prospectId).toBeNull();
    expect(apres.label).toBe(`Entretien ${RUN}`);

    // Et le geste qui défaisait tout : on réactive et on matérialise.
    await app.inject({
      method: "PATCH",
      url: `/contrats/${contratId}`,
      headers: { cookie: ownerCookie },
      payload: { status: "ACTIF" },
    });
    const [affaireId] = await materialiser(contratId);
    const affaire = await withTenant(orgA, (tx) =>
      tx.affaire.findUniqueOrThrow({ where: { id: affaireId as string } }),
    );
    expect(affaire.clientName).toBeNull();
  });

  it("un contrat ACTIF est CONSERVÉ et signalé — l'exécution le fonde", async () => {
    /*
     * Art. 17.3.b : la donnée nécessaire à l'exécution d'un contrat en cours
     * n'est pas effaçable sur simple demande. Mais une conservation MUETTE
     * serait un effacement qui ment : l'owner doit voir ce qui reste, et
     * pourquoi, pour finir le travail à la main.
     */
    const prospectId = await seedProspect(`Claire Vasseur ${RUN}`);
    await seedContrat({ prospectId, clientName: "Claire Vasseur", status: "ACTIF" });

    const del = await app.inject({
      method: "DELETE",
      url: `/prospects/${prospectId}`,
      headers: { cookie: ownerCookie },
    });
    expect(del.statusCode).toBe(200);
    const body = del.json();
    expect(body.contratsAnonymises).toBe(0);
    expect(body.contratsConserves).toHaveLength(1);
    expect(body.contratsConserves[0].motif).toContain("en cours");
    expect(body.contratsConserves[0].motif).toContain("à vérifier");
  });

  it("les affaires DÉJÀ générées par le contrat sont atteintes par la chaîne", async () => {
    /*
     * Une affaire matérialisée avant ce ticket ne porte AUCUN `prospectId` :
     * la matérialisation ne copiait que le nom. La recherche par fiche seule
     * ne la voyait donc pas — le nom restait, et l'effacement se déclarait
     * complet. Le chemin fiche -> contrat -> affaires ferme ce trou sans rien
     * deviner : ce sont deux liens explicites, pas une correspondance de noms.
     */
    const prospectId = await seedProspect(`Hugo Berger ${RUN}`);
    const contratId = await seedContrat({
      prospectId,
      clientName: "Hugo Berger",
      status: "ACTIF",
    });
    const [affaireId] = await materialiser(contratId);
    // Le chemin AVANT : matérialiser copie le lien en même temps que le nom.
    // Copier l'identité sans copier le moyen de l'effacer fabriquerait de la
    // donnée orpheline à chaque clic.
    const generee = await withTenant(orgA, (tx) =>
      tx.affaire.findUniqueOrThrow({ where: { id: affaireId as string } }),
    );
    expect(generee.prospectId).toBe(prospectId);

    // On simule l'existant : l'affaire ne connaît que son contrat.
    await withTenant(orgA, (tx) =>
      tx.affaire.update({
        where: { id: affaireId as string },
        data: { prospectId: null, status: "PERDUE" },
      }),
    );

    const del = await app.inject({
      method: "DELETE",
      url: `/prospects/${prospectId}`,
      headers: { cookie: ownerCookie },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().affairesAnonymisees).toBe(1);
    const affaire = await withTenant(orgA, (tx) =>
      tx.affaire.findUniqueOrThrow({ where: { id: affaireId as string } }),
    );
    expect(affaire.clientName).toBeNull();
  });

  it("un contrat SANS lien de fiche n'est jamais touché — pas de correspondance de noms", async () => {
    /*
     * Deux clients peuvent porter le même nom, et un homonyme effacé ne doit
     * pas emporter le contrat de l'autre. Rapprocher par le nom serait
     * exactement l'inférence que la doctrine interdit : le coût des deux
     * erreurs est asymétrique — ne pas atteindre un contrat laisse un problème
     * VISIBLE (il est compté et dit), en effacer un de trop détruit
     * silencieusement la donnée d'un tiers.
     */
    /*
     * Le nom du contrat est EXACTEMENT celui de la fiche : c'est la seule
     * forme de ce test qui prouve quelque chose. Un contrat nommé
     * différemment survivrait à n'importe quelle implémentation, y compris
     * une qui rapproche par le nom — le test serait vert sans rien garantir.
     */
    const nom = `Sophie Marchand ${RUN}`;
    const prospectId = await seedProspect(nom);
    const homonyme = await seedContrat({ clientName: nom, status: "TERMINE" });

    const del = await app.inject({
      method: "DELETE",
      url: `/prospects/${prospectId}`,
      headers: { cookie: ownerCookie },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().contratsAnonymises).toBe(0);
    const apres = await withTenant(orgA, (tx) =>
      tx.contrat.findUniqueOrThrow({ where: { id: homonyme } }),
    );
    expect(apres.clientName).toBe(nom);
  });

  it("l'angle mort est COMPTÉ à la valeur EXACTE, après détachement", async () => {
    /*
     * Tenant dédié : un `> 0` resterait vert pour presque n'importe quelle
     * implémentation — un `count()` de tous les contrats, un compte ignorant
     * `clientName` — et ne serait vrai que grâce aux contrats semés par les
     * tests précédents, donc rouge si ce test était joué seul.
     *
     * Quatre contrats, une seule réponse juste : les DEUX nominatifs sans
     * fiche, PLUS celui que la suppression vient de détacher (conservé, donc
     * encore nominatif et désormais sans fiche). Celui sans nom ne compte pas.
     * Compter AVANT le `deleteMany` rendrait 2 — un angle mort annoncé trop
     * petit, sous un libellé qui promet le total à relire.
     */
    /*
     * Fiche PROPRE à ce test. Réutiliser `prospectAutreTenant` la supprimerait,
     * et le test d'isolation qui suit se retrouverait à viser une fiche
     * inexistante — c'est-à-dire creux, exactement le défaut qu'il vient de
     * corriger. Un test qui détruit la donnée d'un autre test le rend faux
     * sans jamais le faire rougir.
     */
    const fiche = await app.inject({
      method: "POST",
      url: "/prospects",
      headers: { cookie: autreCookie },
      payload: { name: `Fiche Angle ${RUN}`, stage: "nouveau", source: "recommandation" },
    });
    expect(fiche.statusCode).toBe(201);
    const ficheId = fiche.json().id as string;

    const contrat = async (payload: Record<string, unknown>): Promise<void> => {
      const res = await app.inject({
        method: "POST",
        url: "/contrats",
        headers: { cookie: autreCookie },
        payload: { label: `Angle ${RUN}`, cadence: "mensuel", ...payload },
      });
      expect(res.statusCode).toBe(201);
    };
    await contrat({ clientName: "Sans fiche A" });
    await contrat({ clientName: "Sans fiche B" });
    await contrat({});
    await contrat({ clientName: `Fiche Angle ${RUN}`, prospectId: ficheId });

    const del = await app.inject({
      method: "DELETE",
      url: `/prospects/${ficheId}`,
      headers: { cookie: autreCookie },
    });
    expect(del.statusCode).toBe(200);
    // Le contrat lié était ACTIF : conservé, donc toujours nominatif — et
    // détaché par le SET NULL, donc désormais hors de portée lui aussi.
    expect(del.json().contratsConserves).toHaveLength(1);
    expect(del.json().contratsSansFiche).toBe(3);
  });

  it("une fiche EXISTANTE d'un autre tenant est refusée — à la création ET à la mise à jour", async () => {
    /*
     * La fiche visée EXISTE, dans une autre organisation. C'est la seule forme
     * de ce test qui prouve l'isolation : avec un UUID inexistant, le refus
     * serait identique que `prospectExists` lise sous RLS ou hors RLS — donc
     * vert précisément dans le cas où la fuite existerait.
     *
     * La FK composite (tenant_id, prospect_id) ferme la voie en base ; la
     * route doit rendre un 400 MOTIVÉ plutôt qu'un 500 de violation de
     * contrainte. Un refus est une réponse.
     */
    const cree = await app.inject({
      method: "POST",
      url: "/contrats",
      headers: { cookie: ownerCookie },
      payload: {
        label: `Fantôme ${RUN}`,
        cadence: "mensuel",
        prospectId: prospectAutreTenant,
      },
    });
    expect(cree.statusCode).toBe(400);
    expect(cree.json().error).toContain("prospect");

    // Le PATCH porte la MÊME garde, et sans ce test une régression sur cette
    // ligne-là passerait inaperçue.
    const contratId = await seedContrat({ clientName: `Legit ${RUN}` });
    const patch = await app.inject({
      method: "PATCH",
      url: `/contrats/${contratId}`,
      headers: { cookie: ownerCookie },
      payload: { prospectId: prospectAutreTenant },
    });
    expect(patch.statusCode).toBe(400);
    expect(patch.json().error).toContain("prospect");
    const inchange = await withTenant(orgA, (tx) =>
      tx.contrat.findUniqueOrThrow({ where: { id: contratId } }),
    );
    expect(inchange.prospectId).toBeNull();
  });

  it("les NOTES du contrat partent avec le nom", async () => {
    /*
     * Champ libre de 2 000 caractères sur un contrat dont le code vient de
     * juger que rien ne fonde de le garder. Le lien vers la fiche disparaît la
     * ligne suivante par `SET NULL` : ce qui survit ici devient définitivement
     * inatteignable. L'opposition efface déjà `notes` côté fiche, et
     * l'anonymisation des affaires emporte déjà l'adresse — laisser celui-ci
     * serait une asymétrie sans raison.
     */
    const prospectId = await seedProspect(`Yann Colas ${RUN}`);
    const contratId = await seedContrat({
      prospectId,
      clientName: "Yann Colas",
      notes: "Ne pas appeler avant 9 h — litige sur la facture de mars",
      status: "TERMINE",
    });

    const del = await app.inject({
      method: "DELETE",
      url: `/prospects/${prospectId}`,
      headers: { cookie: ownerCookie },
    });
    expect(del.statusCode).toBe(200);
    const apres = await withTenant(orgA, (tx) =>
      tx.contrat.findUniqueOrThrow({ where: { id: contratId } }),
    );
    expect(apres.notes).toBeNull();
  });

  it("une affaire rattachée à QUELQU'UN D'AUTRE n'est pas anonymisée au passage", async () => {
    /*
     * Le chemin fiche -> contrat -> affaires ne vaut que pour les affaires
     * ORPHELINES de fiche. Un contrat d'entretien peut servir plusieurs
     * interlocuteurs, et `PATCH /affaires` accepte un `prospectId` : anonymiser
     * une affaire explicitement rattachée à un tiers serait le symétrique exact
     * de l'erreur que le refus de la correspondance de noms cherche à éviter —
     * détruire la donnée d'une personne au nom de l'effacement d'une autre.
     */
    const efface = await seedProspect(`Léa Fournier ${RUN}`);
    const tiers = await seedProspect(`Paul Tiers ${RUN}`);
    const contratId = await seedContrat({ prospectId: efface, clientName: "Léa Fournier" });
    const [affaireId] = await materialiser(contratId);
    await withTenant(orgA, (tx) =>
      tx.affaire.update({
        where: { id: affaireId as string },
        data: { prospectId: tiers, clientName: "Paul Tiers", status: "PERDUE" },
      }),
    );

    const del = await app.inject({
      method: "DELETE",
      url: `/prospects/${efface}`,
      headers: { cookie: ownerCookie },
    });
    expect(del.statusCode).toBe(200);
    const apres = await withTenant(orgA, (tx) =>
      tx.affaire.findUniqueOrThrow({ where: { id: affaireId as string } }),
    );
    expect(apres.clientName).toBe("Paul Tiers");
  });
});
