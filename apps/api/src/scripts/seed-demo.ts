/*
 * Seed démo (`pnpm seed:demo`) — crée ou REMET À NEUF le tenant
 * « Élec Provence » (SARL, électricité générale, 6 salariés) : l'état de
 * départ de chaque démo. Rejouable à volonté — les validations faites en
 * rendez-vous « consomment » les données, le seed les restaure à l'identique.
 *
 * - Les chiffres bancaires/factures (creux à 8 900 €, 8 030 € d'impayés)
 *   viennent des fixtures du mode démo des connecteurs (statut "demo",
 *   @nodaq/mcp-connectors) : dates RELATIVES, zéro réseau — ce script ne
 *   stocke que le plan métier (pending_actions) et le plan auth.
 * - Toute écriture métier passe par withTenant (RLS) : par construction,
 *   AUCUN autre tenant ne peut être touché.
 * - Garde production : refuse NODE_ENV=production sans DEMO_SEED_ALLOWED=true
 *   (le staging se seed avec le flag explicite).
 */

import { hashPassword } from "better-auth/crypto";
import {
  DEMO_CONNECTOR_STATUS,
  DEMO_LATE_INVOICES,
  DEMO_LATE_TOTAL_CENTS,
  connectorSecretName,
} from "@nodaq/mcp-connectors";
import { prisma, withTenant } from "@nodaq/db";
import { createAdminClient } from "@nodaq/db/admin";
import { defaultWritableProvider } from "@nodaq/secrets";

export const DEMO_TENANT_NAME = "Élec Provence";
export const DEMO_TENANT_SLUG = "elec-provence-demo";
export const DEMO_USER_EMAIL = "demo@nodaq.fr";

function fail(message: string): never {
  console.error(`[seed:demo] ${message}`);
  process.exit(1);
}

/** Les 3 relances du kit — ton pro, vocabulaire chantier, art. L441-10. */
function dunningActions() {
  const drafts: Record<string, { risk: object; draft: string }> = {
    "2026-118": {
      risk: { daysOverdue: 18, score: 0.31, band: "medium", signals: ["overdue:18d"] },
      draft:
        "Objet : Relance — situation n°3, chantier Les Terrasses (facture 2026-118)\n\n" +
        "Madame, Monsieur,\n\nSauf erreur de notre part, la situation n°3 du chantier " +
        "Les Terrasses (facture 2026-118, 4 200,00 € TTC), échue depuis 18 jours, demeure " +
        "impayée. Les travaux correspondants ont été réceptionnés sans réserve.\n\n" +
        "Nous vous remercions de procéder au règlement sous 7 jours. À défaut, les " +
        "pénalités de retard prévues à l'article L441-10 du Code de commerce seront " +
        "appliquées de plein droit.\n\nCordialement,\nÉlec Provence",
    },
    "2026-121": {
      risk: { daysOverdue: 9, score: 0.19, band: "low", signals: ["overdue:9d"] },
      draft:
        "Objet : Relance — remise aux normes parties communes (facture 2026-121)\n\n" +
        "Madame, Monsieur,\n\nNotre facture 2026-121 (2 650,00 € TTC), relative à la " +
        "remise aux normes électriques des parties communes, est échue depuis 9 jours. " +
        "Le procès-verbal d'intervention vous a été remis à la fin des travaux.\n\n" +
        "Nous vous remercions de bien vouloir la régler sous 7 jours (pénalités de " +
        "retard : art. L441-10 du Code de commerce).\n\nCordialement,\nÉlec Provence",
    },
    "2026-124": {
      risk: { daysOverdue: 5, score: 0.11, band: "low", signals: ["overdue:5d"] },
      draft:
        "Objet : Relance — lot électricité, solde (facture 2026-124)\n\n" +
        "Madame, Monsieur,\n\nLe solde de notre lot électricité (facture 2026-124, " +
        "1 180,00 € TTC) est échu depuis 5 jours. Les levées de réserves ont été " +
        "validées par votre conducteur de travaux.\n\nMerci de procéder au règlement " +
        "sous 7 jours (pénalités de retard : art. L441-10 du Code de commerce).\n\n" +
        "Cordialement,\nÉlec Provence",
    },
  };
  return DEMO_LATE_INVOICES.map((invoice) => {
    const entry = drafts[invoice.number];
    if (!entry) throw new Error(`seed: missing draft for ${invoice.number}`);
    return {
      type: "send_dunning",
      employee: "compta",
      payload: {
        invoice: {
          id: invoice.id,
          number: invoice.number,
          customer: invoice.customer,
          label: invoice.label,
          amountCents: invoice.amountCents,
          currency: "EUR",
        },
        risk: entry.risk,
        draft: entry.draft,
      },
    };
  });
}

async function main(): Promise<void> {
  // Garde FAIL-CLOSED (audit RGPD) : liste blanche — un environnement non
  // identifié (NODE_ENV absent, DATABASE_URL pointant n'importe où) est
  // refusé ; seuls dev/test passent sans flag, tout le reste exige
  // DEMO_SEED_ALLOWED=true explicite (staging).
  const nodeEnv = process.env.NODE_ENV ?? "";
  const allowed =
    process.env.DEMO_SEED_ALLOWED === "true" || nodeEnv === "development" || nodeEnv === "test";
  if (!allowed) {
    fail(
      `refus : NODE_ENV="${nodeEnv}" hors {development, test} sans DEMO_SEED_ALLOWED=true ` +
        "(le script détruit et recrée les données du tenant démo)",
    );
  }
  const password = process.env.DEMO_USER_PASSWORD;
  if (!password || password.length < 8) {
    fail("DEMO_USER_PASSWORD manquant ou < 8 caractères (jamais de mot de passe en dur)");
  }

  const admin = createAdminClient();
  try {
    // ── Tenant : création ou adoption — assertion dure sur l'identité ────────
    let tenant = await admin.tenant.findUnique({ where: { slug: DEMO_TENANT_SLUG } });
    if (tenant && tenant.name !== DEMO_TENANT_NAME) {
      fail(
        `abort : le slug "${DEMO_TENANT_SLUG}" appartient à "${tenant.name}" — ` +
          `ce script ne touche QUE "${DEMO_TENANT_NAME}"`,
      );
    }
    tenant ??= await admin.tenant.create({
      data: { name: DEMO_TENANT_NAME, slug: DEMO_TENANT_SLUG },
    });
    const tenantId = tenant.id;

    // ── User démo + compte credential (hash better-auth) + membership owner ──
    // Assertion d'identité symétrique à celle du tenant (audit RGPD) : si un
    // user demo@nodaq.fr existe déjà avec des memberships vers d'AUTRES
    // organisations, réécrire son mot de passe serait une primitive de reset —
    // on refuse.
    const existingUser = await admin.user.findUnique({
      where: { email: DEMO_USER_EMAIL },
      include: { memberships: { where: { tenantId: { not: tenantId } }, select: { tenantId: true } } },
    });
    if (existingUser && existingUser.memberships.length > 0) {
      fail(
        `abort : "${DEMO_USER_EMAIL}" appartient à ${existingUser.memberships.length} autre(s) ` +
          "organisation(s) — ce script ne réécrit pas le mot de passe d'un compte non-démo",
      );
    }
    const user = await admin.user.upsert({
      where: { email: DEMO_USER_EMAIL },
      update: { name: "Démo NODAQ", emailVerified: true },
      create: { email: DEMO_USER_EMAIL, name: "Démo NODAQ", emailVerified: true },
    });
    const passwordHash = await hashPassword(password);
    const account = await admin.account.findFirst({
      where: { userId: user.id, providerId: "credential" },
    });
    if (account) {
      await admin.account.update({ where: { id: account.id }, data: { password: passwordHash } });
    } else {
      await admin.account.create({
        data: { userId: user.id, providerId: "credential", accountId: user.id, password: passwordHash },
      });
    }
    await admin.membership.upsert({
      where: { tenantId_userId: { tenantId, userId: user.id } },
      update: { role: "owner" },
      create: { tenantId, userId: user.id, role: "owner" },
    });

    // ── RESTAURATION du plan métier — withTenant UNIQUEMENT (RLS) ────────────
    const actions = [
      ...dunningActions(),
      {
        type: "create_quote",
        employee: "compta",
        payload: {
          quote: {
            number: "DV-0455",
            customer: "M. Bernard",
            label: "Rénovation tableau électrique + mise aux normes",
            amountCents: 1_280_000,
          },
          draft:
            "Devis DV-0455 — M. Bernard\nRénovation du tableau électrique et mise aux " +
            "normes NF C 15-100 : dépose de l'existant, tableau 3 rangées, 8 circuits, " +
            "différentiels 30 mA, mise à la terre, Consuel. Total : 12 800,00 € TTC.",
        },
      },
      {
        type: "submit_reconciliation",
        employee: "compta",
        payload: {
          reconciliation: {
            entries: 3,
            totalCents: 641_000,
            items: [
              { label: "Situation travaux — chantier A (acompte)", amountCents: 385_000 },
              { label: "Comptoir Élec Distribution — avoir", amountCents: 46_000 },
              { label: "Virement client — facture 2026-112 (part)", amountCents: 210_000 },
            ],
          },
        },
      },
    ];

    // Purge du coffre (audit RGPD) : si le tenant démo a déjà servi à montrer
    // l'onboarding avec de VRAIS identifiants (statut "active"), la bascule en
    // "demo" doit supprimer le secret — l'UI affichera « données fictives,
    // zéro secret » et ce doit être vrai. Hors transaction (IO externe), et
    // uniquement des refs du namespace du tenant démo.
    const previousConnectors = await withTenant(tenantId, (tx) => tx.connector.findMany({}));
    const toPurge = previousConnectors.filter(
      (row) =>
        row.status !== DEMO_CONNECTOR_STATUS &&
        row.credentialsRef.startsWith(`connector/${tenantId}/`),
    );
    if (toPurge.length > 0) {
      const vault = defaultWritableProvider();
      for (const row of toPurge) {
        await vault.delete(row.credentialsRef);
        console.log(`[seed:demo] secret purgé du coffre : ${row.credentialsRef}`);
      }
    }

    const summary = await withTenant(tenantId, async (tx) => {
      await tx.pendingAction.deleteMany({});
      await tx.agentConversation.deleteMany({});
      await tx.note.deleteMany({});
      await tx.documentChunk.deleteMany({});
      await tx.document.deleteMany({});
      await tx.classification.deleteMany({});

      for (const action of actions) {
        await tx.pendingAction.create({
          data: {
            tenantId,
            type: action.type,
            employee: action.employee,
            status: "pending",
            payload: action.payload,
          },
        });
      }

      // Connecteurs en statut "demo" : les clients-fixtures alimentent la
      // trésorerie/les factures — JAMAIS le statut "active" d'une vraie
      // connexion. Aucun secret n'est écrit dans le coffre.
      for (const type of ["qonto", "pennylane"] as const) {
        await tx.connector.upsert({
          where: { tenantId_type: { tenantId, type } },
          update: { status: DEMO_CONNECTOR_STATUS, credentialsRef: connectorSecretName(tenantId, type) },
          create: {
            tenantId,
            type,
            status: DEMO_CONNECTOR_STATUS,
            credentialsRef: connectorSecretName(tenantId, type),
          },
        });
      }

      await tx.tenantPolicy.upsert({
        where: { tenantId },
        update: { frontierEnabled: false },
        create: { tenantId, frontierEnabled: false },
      });

      return {
        pendingActions: await tx.pendingAction.count(),
        connectors: await tx.connector.count(),
      };
    });

    // La trésorerie n'est pas stockée : le cockpit la recalcule à la demande
    // via le connecteur démo (creux à 8 900 € à J+30, garanti par les fixtures).
    console.log(
      `[seed:demo] OK — tenant "${DEMO_TENANT_NAME}" restauré : ` +
        `${summary.pendingActions} pending_actions, ${summary.connectors} connecteurs (statut demo), ` +
        `impayés du kit = ${(DEMO_LATE_TOTAL_CENTS / 100).toFixed(2)} €. ` +
        `Connexion : ${DEMO_USER_EMAIL} (mot de passe : env DEMO_USER_PASSWORD).`,
    );
  } finally {
    await admin.$disconnect();
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // Nom + message seulement : jamais de contenu sensible dans les logs.
  console.error(`[seed:demo] échec : ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
