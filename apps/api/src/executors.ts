import { createHash } from "node:crypto";
import { z } from "zod";
import { Prisma, withTenant } from "@nodaq/db";
import {
  auditInvoice,
  buildCiiXml,
  buildFacturXPdf,
  FacturXInvoice,
  normalizeStatus,
} from "@nodaq/facturx";
import { getPdpClient } from "@nodaq/mcp-connectors";
import type { RegistryOptions } from "@nodaq/mcp-connectors";
import { ASSET_CATEGORIES } from "@nodaq/shared";
import { appendHistory, REDEPOSITABLE_STATUSES } from "./einvoice.js";

/*
 * Executors of validated pending actions (ticket 1.6). Runs ONLY after a human
 * approved (validatedBy set) — never from the agent loop. MVP executors are
 * SIMULATED (no real SMTP / accounting write yet): they mark the action done
 * and return metadata-only results. Real side effects will land behind this
 * exact interface. adjust_stock (3.2) is the first REAL executor: the
 * movement is applied atomically, quantity floor at 0.
 */

export type ActionExecutor = (
  payload: unknown,
  context: {
    tenantId: string;
    userId?: string;
    /** Résolution des connecteurs (coffre, URLs) — dépôt PDP 2.4. */
    connectors?: RegistryOptions;
  },
) => Promise<unknown>;

export type ExecutorRegistry = Record<string, ActionExecutor>;

// Mêmes bornes que l'outil MCP et la route HTTP : le payload est relu depuis
// la DB, la défense en profondeur veut la borne des deux côtés.
const AdjustStockPayload = z.object({
  itemId: z.string().uuid(),
  delta: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((value) => value !== 0),
  reason: z.string().nullish(),
});

const MAX_STOCK_QUANTITY = 1_000_000_000;

/** Dépôt e-invoicing (2.4) : la facture normalisée, jamais le PDF. */
const SubmitEInvoicePayload = z.object({
  invoice: FacturXInvoice,
  profile: z.enum(["BASIC", "EN16931"]).default("EN16931"),
});

/** E-reporting (2.4) : agrégats de la période, jamais un détail nominatif. */
const ReportTransactionsPayload = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  totalCents: z.number().int().min(0).max(1_000_000_000_00),
  vatCents: z.number().int().min(0).max(1_000_000_000_00),
  transactionCount: z.number().int().min(0).max(1_000_000),
});

/** Réponse à un avis client (3.8) — le brouillon validé est ENREGISTRÉ sur
 * l'avis ; la publication sur la plateforme reste manuelle en V1 (aucune API
 * d'écriture). Strip : le payload transporte aussi rating/source pour la file. */
const RecordReviewReplyPayload = z.object({
  review: z.object({ id: z.string().uuid() }),
  draft: z.string().min(1).max(4_000),
});

/** Relance prospect (2.12) — le brouillon validé est consigné au journal des
 * contacts. Ce que le produit enregistre est la VALIDATION humaine, pas une
 * preuve d'envoi : il n'a aucune API de messagerie en V1, et la note le dit. */
const RecordProspectContactPayload = z.object({
  prospect: z.object({ id: z.string().uuid() }),
  draft: z.string().min(1).max(4_000),
});

/** Proposition d'immobilisation (2.19) — FEC, classeur ou saisie assistée.
 * Bornes larges mais réelles : base <= 100 M€, durée 1 mois..50 ans. */
const CreateFixedAssetPayload = z
  .object({
    label: z.string().min(1).max(200),
    category: z.enum(["informatique", "logiciel", "vehicule", "materiel", "mobilier", "agencement"]),
    inServiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    baseCents: z.number().int().min(1).max(10_000_000_000),
    durationMonths: z.number().int().min(1).max(600),
    method: z.enum(["LINEAIRE", "DEGRESSIF"]).default("LINEAIRE"),
    source: z.enum(["FEC", "DOCUMENT", "MANUEL"]).default("MANUEL"),
    sourceRef: z.string().max(200).nullish(),
    priorDepreciationCents: z.number().int().min(0).default(0),
  })
  // CGI 39 A : le dégressif n'est pas ouvert à toutes les catégories
  // (véhicules de tourisme exclus…) — la config sourcée fait foi.
  .refine(
    (data) => data.method !== "DEGRESSIF" || ASSET_CATEGORIES[data.category].decliningAllowed,
    { message: "declining balance not allowed for this category" },
  );
// (strip, pas strict : le payload transporte aussi des champs d'AFFICHAGE
// pour la file — warnings de dérivation — que l'exécuteur ignore.)

/**
 * Prend la place dans le registre AVANT tout appel réseau (2.4). L'unicité
 * (tenant, numéro, direction) est la seule garantie qui tienne face à deux
 * approbations concurrentes ; une lecture préalable n'en est pas une.
 */
async function reserveSubmission(
  tenantId: string,
  input: {
    invoiceNumber: string;
    profile: string;
    direction: "emission" | "ereporting";
    documentHash: string;
    amountCents: number;
    currency: string;
  },
): Promise<{ id: string }> {
  return withTenant(tenantId, async (tx) => {
    try {
      return await tx.eInvoiceSubmission.create({
        data: { tenantId, status: "prete", ...input },
        select: { id: true },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
        throw error;
      }
      const existing = await tx.eInvoiceSubmission.findFirstOrThrow({
        where: { invoiceNumber: input.invoiceNumber, direction: input.direction },
        select: { id: true, status: true },
      });
      // Déjà chez la plateforme : on REFUSE, sans rien déposer.
      if (!REDEPOSITABLE_STATUSES.has(existing.status)) throw new Error("already submitted");
      // Reprise après échec de transport : on réutilise la ligne (l'historique
      // des statuts est conservé, il est opposable).
      await tx.eInvoiceSubmission.update({
        where: { id: existing.id },
        data: { documentHash: input.documentHash, lastError: null },
      });
      return { id: existing.id };
    }
  });
}

/** Journalise l'échec de transport : NOM d'erreur seulement. */
async function markSubmissionFailed(
  tenantId: string,
  submissionId: string,
  error: unknown,
): Promise<void> {
  const name = error instanceof Error ? error.name : "Error";
  await withTenant(tenantId, async (tx) => {
    const row = await tx.eInvoiceSubmission.findUnique({
      where: { id: submissionId },
      select: { statusHistory: true },
    });
    await tx.eInvoiceSubmission.update({
      where: { id: submissionId },
      data: {
        status: "erreur",
        lastError: name,
        statusHistory: appendHistory(row?.statusHistory ?? [], {
          status: "erreur",
          at: new Date().toISOString(),
        }),
      },
    });
  }).catch(() => undefined);
}

/** Enregistre le dépôt accepté — l'historique est APPEND-ONLY (opposable). */
async function recordDeposit(
  tenantId: string,
  submissionId: string,
  deposit: { reference: string; status: string | null },
): Promise<{ submissionId: string; reference: string; status: string }> {
  const status = deposit.status ? (normalizeStatus(deposit.status) ?? "deposee") : "deposee";
  const now = new Date();
  return withTenant(tenantId, async (tx) => {
    const row = await tx.eInvoiceSubmission.findUnique({
      where: { id: submissionId },
      select: { statusHistory: true },
    });
    await tx.eInvoiceSubmission.update({
      where: { id: submissionId },
      data: {
        status,
        pdpReference: deposit.reference,
        lastError: null,
        submittedAt: now,
        statusHistory: appendHistory(row?.statusHistory ?? [], {
          status,
          at: now.toISOString(),
          reference: deposit.reference,
        }),
      },
    });
    return { submissionId, reference: deposit.reference, status };
  });
}

export const defaultExecutors: ExecutorRegistry = {
  send_dunning: () => Promise.resolve({ sent: true, simulated: true }),
  book_invoice: () => Promise.resolve({ booked: true, simulated: true }),
  // EXÉCUTEUR RÉEL (2.19) : crée l'immobilisation UNIQUEMENT après validation
  // humaine — la frontière charge/immobilisation est une décision de gestion.
  create_fixed_asset: async (payload, { tenantId }) => {
    const parsed = CreateFixedAssetPayload.safeParse(payload);
    if (!parsed.success) throw new Error("invalid create_fixed_asset payload");
    const data = parsed.data;
    return withTenant(tenantId, async (tx) => {
      if (data.sourceRef) {
        // Idempotence par référence source (compte FEC, document classeur) :
        // re-valider une proposition déjà exécutée ne duplique jamais.
        const existing = await tx.fixedAsset.findFirst({
          where: { source: data.source, sourceRef: data.sourceRef },
          select: { id: true },
        });
        if (existing) return { fixedAssetId: existing.id, alreadyExisted: true };
      }
      const asset = await tx.fixedAsset.create({
        data: {
          tenantId,
          label: data.label,
          category: data.category,
          inServiceDate: new Date(`${data.inServiceDate}T00:00:00Z`),
          baseCents: BigInt(data.baseCents),
          durationMonths: data.durationMonths,
          method: data.method,
          source: data.source,
          sourceRef: data.sourceRef ?? null,
          priorDepreciationCents: BigInt(data.priorDepreciationCents),
        },
        select: { id: true },
      });
      return { fixedAssetId: asset.id, alreadyExisted: false };
    });
  },
  // Le devis est PRÉPARÉ, pas émis : il n'existe aucune API d'écriture vers
  // un facturier en V1. Annoncer « créé » ferait croire à une émission qui
  // n'a pas eu lieu — même honnêteté que record_review_reply (3.8), qui dit
  // que la publication reste manuelle.
  create_quote: () =>
    Promise.resolve({
      prepared: true,
      emitted: false,
      next: "reprenez la proposition dans votre facturier pour l'émettre",
    }),
  // EXÉCUTEUR RÉEL (2.4) : dépose la facture sur la plateforme APRÈS
  // validation humaine — déposer engage l'entreprise sur le réseau national.
  //
  // Le payload porte la FACTURE NORMALISÉE, jamais le PDF : le générateur
  // étant pur, le document est reconstruit à l'identique ici, et l'audit de
  // conformité est REJOUÉ juste avant le dépôt (l'état des règles a pu
  // changer entre la préparation et la validation).
  submit_einvoice: async (payload, { tenantId, connectors }) => {
    const parsed = SubmitEInvoicePayload.safeParse(payload);
    if (!parsed.success) throw new Error("invalid submit_einvoice payload");
    const { invoice, profile } = parsed.data;

    const audit = auditInvoice(invoice);
    if (!audit.issuable) {
      // Jamais de dépôt d'une facture non conforme : elle serait rejetée par
      // la plateforme, avec une trace publique d'émission fautive.
      throw new Error("invoice no longer compliant");
    }

    const xml = buildCiiXml(invoice, profile);
    const pdf = await buildFacturXPdf(invoice, xml, profile);
    const documentHash = createHash("sha256").update(pdf).digest("hex");

    // RÉSERVATION AVANT LE RÉSEAU. Le dépôt est irréversible : la place doit
    // être prise dans le registre AVANT l'appel, sinon deux propositions de
    // la même facture (deux entrées en file, chacune valide) déposeraient
    // deux fois — la seconde écrasant la référence de la première, qui
    // deviendrait introuvable. L'index unique (tenant, numéro, direction)
    // est ce qui tranche, pas une lecture préalable.
    const reserved = await reserveSubmission(tenantId, {
      invoiceNumber: invoice.number,
      profile,
      direction: "emission",
      documentHash,
      amountCents: invoice.totals.grossCents,
      currency: invoice.currency,
    });

    let deposit;
    try {
      const client = await getPdpClient(tenantId, connectors ?? {});
      deposit = await client.deposit({
        invoiceNumber: invoice.number,
        documentBase64: Buffer.from(pdf).toString("base64"),
        profile,
      });
    } catch (error) {
      // Échec de transport : la ligne reste, en `erreur`, et rouvre un
      // nouveau dépôt (transition `erreur → deposee`). NOM d'erreur
      // seulement — un message fournisseur citerait la facture.
      await markSubmissionFailed(tenantId, reserved.id, error);
      throw error;
    }

    return recordDeposit(tenantId, reserved.id, deposit);
  },
  // EXÉCUTEUR RÉEL (2.4) : transmet l'agrégat e-reporting de la période.
  // Ce qui part est un TOTAL — jamais le détail nominatif des clients ; la
  // minimisation est portée par le contrat `reportTransactions`.
  report_einvoice_transactions: async (payload, { tenantId, connectors }) => {
    const parsed = ReportTransactionsPayload.safeParse(payload);
    if (!parsed.success) throw new Error("invalid report_einvoice_transactions payload");
    const data = parsed.data;
    const periodKey = `${data.periodStart}..${data.periodEnd}`;

    // Hash de l'agrégat transmis : preuve de ce qui est parti, sans stocker
    // une seconde fois la donnée (elle vit déjà dans les colonnes).
    const documentHash = createHash("sha256")
      .update(`${periodKey}|${data.totalCents}|${data.vatCents}|${data.transactionCount}`)
      .digest("hex");

    // Même réservation préalable que le dépôt de facture : une période
    // déclarée deux fois est une déclaration fautive.
    const reserved = await reserveSubmission(tenantId, {
      invoiceNumber: periodKey,
      profile: "EREPORTING",
      direction: "ereporting",
      documentHash,
      amountCents: data.totalCents,
      currency: "EUR",
    });

    let deposit;
    try {
      const client = await getPdpClient(tenantId, connectors ?? {});
      deposit = await client.reportTransactions(data);
    } catch (error) {
      await markSubmissionFailed(tenantId, reserved.id, error);
      throw error;
    }

    return recordDeposit(tenantId, reserved.id, deposit);
  },
  // EXÉCUTEUR RÉEL (3.8) : enregistre la réponse validée sur l'avis. Jamais
  // d'écrasement (idempotent) : un avis déjà répondu reste tel quel.
  record_review_reply: async (payload, { tenantId }) => {
    const parsed = RecordReviewReplyPayload.safeParse(payload);
    // Message générique : une ZodError citerait le brouillon dans `result`.
    if (!parsed.success) throw new Error("invalid record_review_reply payload");
    const { review, draft } = parsed.data;
    return withTenant(tenantId, async (tx) => {
      const { count } = await tx.customerReview.updateMany({
        where: { id: review.id, replyText: null },
        data: { replyText: draft, repliedAt: new Date() },
      });
      if (count === 0) {
        const exists = await tx.customerReview.findUnique({
          where: { id: review.id },
          select: { id: true },
        });
        if (!exists) throw new Error("review not found");
        return { recorded: false, alreadyReplied: true };
      }
      // La réponse est stockée : l'owner la copie sur la plateforme (V1).
      return { recorded: true, publishManually: true };
    });
  },
  // Relance prospect (2.12) : consigne le contact au journal APPEND-ONLY, qui
  // est la seule source du « dernier contact ». Le produit n'a aucune API de
  // messagerie : il enregistre la VALIDATION, pas une preuve d'envoi — et la
  // note le dit, pour que personne ne lise cette ligne comme un accusé de
  // réception. Le garde d'opposition est REJOUÉ ici : la personne a pu s'y
  // opposer entre la préparation et l'approbation.
  record_prospect_contact: async (payload, { tenantId, userId }) => {
    const parsed = RecordProspectContactPayload.safeParse(payload);
    // Message générique : une ZodError citerait le brouillon dans `result`.
    if (!parsed.success) throw new Error("invalid record_prospect_contact payload");
    const { prospect, draft } = parsed.data;
    return withTenant(tenantId, async (tx) => {
      const target = await tx.prospect.findUnique({
        where: { id: prospect.id },
        select: { id: true, optedOut: true, stage: true },
      });
      if (!target) throw new Error("prospect not found");
      if (target.optedOut) {
        // On LÈVE au lieu de renvoyer un refus : un retour normal ferait
        // afficher « Exécutée » dans la file pour une relance qui a été
        // refusée, et l'information ne vivrait que dans `result`.
        throw new Error("prospect opposé à la prospection");
      }
      await tx.prospectInteraction.create({
        data: {
          tenantId,
          prospectId: target.id,
          kind: "email",
          occurredAt: new Date(),
          // Le texte validé vit ICI, pas indéfiniment dans la file : c'est
          // l'historique du dossier (et il suit donc la vie de la fiche —
          // supprimer le prospect efface aussi ses messages). Borne alignée
          // sur le CHECK de la colonne.
          note: `Brouillon validé (envoi manuel) : ${draft}`.slice(0, 1_000),
          createdBy: userId ?? null,
        },
      });
      // Le prospect entre en étape « contacté » s'il était encore « nouveau ».
      if (target.stage === "nouveau") {
        await tx.prospect.update({ where: { id: target.id }, data: { stage: "contacte" } });
      }
      return {
        recorded: true,
        sent: false,
        next: "envoyez le message depuis votre messagerie",
      };
    });
  },
  submit_reconciliation: () => Promise.resolve({ submitted: true, simulated: true }),
  adjust_stock: async (payload, { tenantId, userId }) => {
    const parsed = AdjustStockPayload.safeParse(payload);
    // Generic message: a ZodError could quote payload fields into `result`.
    if (!parsed.success) throw new Error("invalid adjust_stock payload");
    const { itemId, delta, reason } = parsed.data;
    return withTenant(tenantId, async (tx) => {
      const exists = await tx.stockItem.findUnique({
        where: { id: itemId },
        select: { id: true },
      });
      if (!exists) throw new Error("stock item not found");
      // Plancher/plafond ATOMIQUES (même update conditionnel que la route) :
      // une approbation concurrente d'un autre mouvement ne peut pas faire
      // franchir le zéro.
      const { count } = await tx.stockItem.updateMany({
        where: {
          id: itemId,
          quantity: {
            gte: delta < 0 ? -delta : 0,
            lte: MAX_STOCK_QUANTITY - Math.max(0, delta),
          },
        },
        data: { quantity: { increment: delta } },
      });
      if (count === 0) throw new Error("insufficient stock");
      await tx.stockMovement.create({
        data: {
          tenantId,
          itemId,
          delta,
          reason: reason ?? "validé depuis la file",
          // L'approbateur est journalisé — l'attribution ne vit pas que dans
          // pending_actions.validatedBy.
          createdBy: userId ?? null,
        },
      });
      const item = await tx.stockItem.findUnique({
        where: { id: itemId },
        select: { quantity: true },
      });
      return { adjusted: true, quantity: item?.quantity ?? null };
    });
  },
};
