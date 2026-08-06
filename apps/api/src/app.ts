import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { buildToolset, ComptaAgent } from "@nodaq/agent-runtime";
import type { ToolsetContext } from "@nodaq/agent-runtime";
import {
  ContratCreateInput,
  ContratUpdateInput,
  serializeContrat,
  toCivilDate,
  summarizeDueContracts,
  todayCivilIso,
  toContratData,
  toDbDateRequired,
} from "./contrats.js";
import {
  nextAffaireReference,
  prisma,
  Prisma,
  resolveWebhookEndpoint,
  withOps,
  withTenant,
} from "@nodaq/db";
import {
  BRIEF_LATE_LOOKBACK_DAYS,
  BRIEF_RULES_VERSION,
  composeMorningBrief,
  earliestDeadline,
  ECHEANCE_HORIZON_DAYS,
  lateDaysOf,
  splitDeadlines,
} from "./briefMatin.js";
import type { BriefEcheance, BriefWorstMargin } from "./briefMatin.js";
import {
  AFFAIRE_SUGGESTION_RULES_VERSION,
  buildSupplierHistory,
  suggestAffaires,
} from "./affaireSuggestion.js";
import {
  AFFAIRE_STATUSES,
  AFFAIRES_MARGIN_SCAN_LIMIT,
  AffaireCreateInput,
  AffaireImputeInput,
  AffaireUpdateInput,
  comparableMargin,
  imputationAmountIsCoherent,
  loadAffaireMargin,
  loadAffairesMargins,
  loadRevenusSplit,
  nextCompletedAt,
  serializeAffaire,
  toPrismaData,
} from "./affaires.js";
import { emitOutbox } from "./outbox.js";
import { subscribeOutbox } from "./outboxRelay.js";
import { sniffAudioFormat, transcribe, TRANSCRIPTION_MAX_BYTES } from "@nodaq/llm";
// Importée, JAMAIS recopiée : la borne de la route doit être exactement celle
// du schéma de l'outil, sinon la troncature « propre » de l'une devient la
// ZodError de l'autre.
import { DICTATION_MAX } from "@nodaq/mcp-actions";
import { deriveCharges, deriveFixedAssets, deriveReceivables, parseFec } from "@nodaq/fec";
import {
  aggregateEReporting,
  auditInvoice,
  buildCiiXml,
  buildFacturXPdf,
  extractFacturXXml,
  FacturXInvoice,
  LIFECYCLE_RULES_VERSION,
  STATUS_LABELS,
} from "@nodaq/facturx";
import {
  BridgeClient,
  connectorSecretName,
  ConnectorNotConfiguredError,
  ConnectorType,
  FEC_CONNECTOR_STATUS,
  FEC_CONNECTOR_TYPE,
  getBankClient,
  getSilaeClient,
  HttpPdpClient,
  PdpCredentials,
  PennylaneClient,
  QontoClient,
  SilaeClient,
  SilaeCredentials,
} from "@nodaq/mcp-connectors";
import type { BankClient } from "@nodaq/mcp-connectors";
import { defaultWritableProvider } from "@nodaq/secrets";
import type { WritableSecretProvider } from "@nodaq/secrets";
import {
  applyTaxOverrides,
  ASSET_CATEGORIES,
  buildTaxSchedule,
  CAPITALIZATION_THRESHOLD_CENTS,
  CreateNoteInput,
  resolveTaxProfile,
  estimateIsImpact,
  buildDepreciationPlan,
  DATA_CATEGORIES,
  LEGAL_BASES,
  MODULE_CATALOG_VERSION,
  MODULES,
  PAYROLL_PERIODICITIES,
  PROCESSING_TEMPLATES,
  resolveModules,
  renewalWall,
  TAX_CALENDAR_VERSION,
  TAX_OBLIGATIONS,
  TenantId,
  Uuid,
  VAT_REGIMES,
  VERTICALS,
} from "@nodaq/shared";
import type { RegistryAsset, TaxDeadlineOverride } from "@nodaq/shared";
import {
  COST_CATEGORY_IDS,
  INTERACTION_KINDS,
  STORABLE_CATEGORY_IDS,
  PROSPECT_SOURCES,
  PROSPECT_STAGES,
} from "@nodaq/shared";
import { auth } from "./auth.js";
import { DocExtraction, DOC_TYPES, extractDocumentFields, matchTransactions } from "./classeur.js";
import {
  applySupplierMemory,
  buildSupplierMemory,
  humanFieldsOf,
  MEMORY_WINDOW,
  MIN_EVIDENCE,
} from "./classeurMemory.js";
import type { MemoryApplication, SupplierMemory } from "./classeurMemory.js";
import { defaultExecutors } from "./executors.js";
import { contactHashes } from "./prospectExclusion.js";
import type { ExecutorRegistry } from "./executors.js";
import {
  isAllowedPushEndpoint,
  markPushSeen,
  MAX_PUSH_DEVICES_PER_USER,
  PushCategorySchema,
  PushChannelSchema,
  recordPushEvent,
  tenantOwnerIds,
} from "./push.js";
import {
  createPdpWebhookHandler,
  REDEPOSITABLE_STATUSES,
  reduceFinishedPayload,
} from "./einvoice.js";
import { createSupportStorage } from "./support/storage.js";
import type { SupportStorage } from "./support/storage.js";
import { createTemMailer } from "./support/tem.js";
import type { SupportMailer } from "./support/tem.js";
import { assertAnonymized, SupportOrigin } from "./support/triage.js";
import {
  generateWebhookSecret,
  parseWebhookEnvelope,
  verifyWebhookSignature,
  WEBHOOK_EVENT_RETENTION_DAYS,
  WEBHOOK_PROVIDERS,
  WebhookRateLimiter,
  WebhookSecretCache,
} from "./webhooks.js";
import type { WebhookHandlerRegistry } from "./webhooks.js";

export interface BuildAppOptions {
  /** Executors for approved pending actions (injectable in tests). */
  executors?: ExecutorRegistry;
  /** Extra agent context (fake service URLs in tests). */
  agentContext?: Partial<Omit<ToolsetContext, "tenantId">>;
  /** Writable vault for connector credentials (injectable in tests). */
  vault?: WritableSecretProvider;
  /** Object Storage du support (2.18) — factice en test, S3 sinon. */
  supportStorage?: SupportStorage | null;
  /** Envoi des réponses support (2.18) — factice en test, Scaleway TEM sinon. */
  supportMailer?: SupportMailer | null;
  /** Handlers métier par provider de webhook (2.13) — PDP 2.4, Bridge… */
  webhookHandlers?: WebhookHandlerRegistry;
  /** Limiteur de la route webhook publique (injectable en test). */
  webhookRateLimiter?: WebhookRateLimiter;
}

type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

declare module "fastify" {
  interface FastifyRequest {
    authSession: AuthSession;
    tenantId: string;
    membershipRole: string;
  }
}

/** Convert Fastify headers to Web Headers (expected by better-auth). */
function toWebHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.append(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

/*
 * Authorization chain (CLAUDE.md) — every business route runs, in order:
 *   requireAuth        -> validates the better-auth session, else 401
 *   resolveTenant      -> target tenant = active organization of the session
 *   requireMembership  -> checks IN DB that the user belongs to that tenant, else 403
 *   withTenant(id, …)  -> opens data access (RLS as the last rampart)
 * The tenantId NEVER comes from client input: switching tenants goes through
 * POST /api/auth/organization/set-active (which itself checks membership).
 */

async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const session = await auth.api.getSession({ headers: toWebHeaders(request) });
  if (!session) {
    await reply.code(401).send({ error: "authentication required" });
    return;
  }
  request.authSession = session;
}

async function resolveTenant(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const active = TenantId.safeParse(request.authSession.session.activeOrganizationId);
  if (!active.success) {
    await reply.code(400).send({
      error: "no active organization",
      hint: "create one (POST /api/auth/organization/create) or select one (POST /api/auth/organization/set-active)",
    });
    return;
  }
  request.tenantId = active.data;
}

async function requireMembership(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Session ≠ authorization: re-check membership in DB even though set-active
  // already did — a stale or tampered session must never open another tenant.
  const membership = await prisma.membership.findUnique({
    where: { tenantId_userId: { tenantId: request.tenantId, userId: request.authSession.user.id } },
    select: { id: true, role: true },
  });
  if (!membership) {
    await reply.code(403).send({ error: "not a member of the active organization" });
    return;
  }
  request.membershipRole = membership.role;
}

/** Bornes de lecture de la suggestion F2 — même doctrine que `MEMORY_WINDOW`
 *  du classeur : une dérivation à la lecture doit avoir un coût borné. */
const AFFAIRE_SUGGESTION_HISTORY_WINDOW = 300;
const AFFAIRE_SUGGESTION_MAX_AFFAIRES = 200;

/** Champ texte d'une extraction JSON — `null` dès que ce n'est pas exploitable. */
function extractionField(extraction: unknown, field: "supplierName" | "docDate"): string | null {
  if (extraction === null || typeof extraction !== "object" || Array.isArray(extraction)) {
    return null;
  }
  const value = (extraction as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const businessRoute = [requireAuth, resolveTenant, requireMembership];

/** Sensitive actions gate (CLAUDE.md): role checked from the DB membership. */
function requireRole(roles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!roles.includes(request.membershipRole)) {
      await reply.code(403).send({ error: `requires role: ${roles.join(" | ")}` });
    }
  };
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const executors = options.executors ?? defaultExecutors;
  // ONE vault for the app: connector credentials are WRITTEN here (onboarding)
  // and READ back by the agent toolset — unless a test injects fakes.
  const vault = options.vault ?? defaultWritableProvider();
  const agentContext = { secretProvider: vault, ...options.agentContext };
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  // Push doorbell (2.17): one more pending action -> the tenant's OWNERS (the
  // validators) get an "actions" event, grouped by the dispatch window.
  const notifyPendingAction = async (tenantId: string): Promise<void> => {
    await recordPushEvent(tenantId, await tenantOwnerIds(tenantId), "actions");
  };

  // Last rampart against detail leaks: an unhandled error must never echo its
  // message (internal URLs, secret refs) to the client — name only, log full.
  app.setErrorHandler((error: unknown, request, reply) => {
    request.log.error(error);
    const statusCode =
      error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : NaN;
    void reply
      .code(Number.isInteger(statusCode) && statusCode >= 400 ? statusCode : 500)
      .send({ error: error instanceof Error ? error.name : "InternalServerError" });
  });

  // better-auth handler: /api/auth/* (sign-up/sign-in email, session, sign-out,
  // organization/create, organization/set-active, invitations...)
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (request, reply) => {
      const url = new URL(request.url, auth.options.baseURL);
      const webRequest = new Request(url.toString(), {
        method: request.method,
        headers: toWebHeaders(request),
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });
      const response = await auth.handler(webRequest);
      reply.status(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      await reply.send(response.body ? await response.text() : null);
    },
  });

  app.get("/health", async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "ok", db: "ok" };
  });

  /** Current session: user, active organization and memberships. */
  /** Plafond de flux simultanés par utilisateur et par tenant. */
  const MAX_STREAMS_PER_USER = 4;
  /**
   * Battement, et revalidation de l'appartenance.
   *
   * Injectable par en-tête EN TEST uniquement : sans cela, éprouver la
   * revalidation demandait d'attendre 25 s, donc personne ne l'éprouvait — et
   * la seule « garde » écrite était une lecture du source par expression
   * régulière, qui prouve que le code est écrit, pas qu'il s'exécute.
   */
  const STREAM_HEARTBEAT_MS = 25_000;
  const heartbeatMsFor = (request: FastifyRequest): number => {
    if (process.env.NODE_ENV === "production") return STREAM_HEARTBEAT_MS;
    const raw = Number(request.headers["x-test-heartbeat-ms"]);
    return Number.isFinite(raw) && raw > 0 ? raw : STREAM_HEARTBEAT_MS;
  };
  const openStreams = new Map<string, number>();
  /** Au-delà, on coupe : `EventSource` reconnecte et refait toute la chaîne. */
  const STREAM_MAX_LIFETIME_MS = 30 * 60_000;
  /*
   * Registre des flux ouverts, pour l'ARRÊT PROPRE. Une requête SSE n'est
   * jamais « idle » : avec le défaut Fastify, `app.close()` attendait
   * indéfiniment tant qu'un flux vivait — et le battement les maintient
   * vivants. Sans ce registre, un redéploiement ne se terminait pas.
   */
  const openConnections = new Set<() => void>();
  app.addHook("onClose", async () => {
    for (const fermer of [...openConnections]) fermer();
  });

  /*
   * FLUX D'INVALIDATION (4.4, PR A) — le consommateur du bus.
   *
   * CE QUE ÇA CORRIGE. Chaque écran se rafraîchit déjà après SA propre
   * mutation ; ce qui manquait, c'est l'écriture venue d'AILLEURS — l'agent
   * dans le chat, un autre onglet, un webhook, un collègue. Le patron voyait
   * alors des chiffres d'il y a dix minutes sans que rien ne le dise.
   *
   * AUCUNE DONNÉE MÉTIER NE TRAVERSE. Le flux ne porte que le TYPE de
   * l'événement et l'objet visé : l'écran relit par ses routes habituelles,
   * qui repassent toutes par la chaîne d'autorisation. Un flux qui
   * transporterait les valeurs ferait fuir sur un canal long, ouvert en
   * permanence, et bien plus difficile à auditer qu'une requête.
   *
   * LE TENANT VIENT DE LA SESSION. `businessRoute` a déjà tranché
   * l'appartenance quand on arrive ici ; l'abonnement est clé par
   * `request.tenantId`, jamais par un paramètre.
   */
  app.get("/events", { preHandler: businessRoute }, async (request, reply) => {
    /*
     * PLAFOND PAR UTILISATEUR. Chaque flux retient un socket, une minuterie et
     * une entrée de registre pour une durée non bornée : sans plafond, un
     * script ou un onglet qui recharge en boucle épuise le processus sans
     * jamais franchir une garde d'authentification.
     */
    const streamKey = `${request.tenantId}:${request.authSession.user.id}`;
    const ouverts = openStreams.get(streamKey) ?? 0;
    if (ouverts >= MAX_STREAMS_PER_USER) {
      return reply.code(429).send({ error: "trop de flux ouverts" });
    }
    openStreams.set(streamKey, ouverts + 1);

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      // Un proxy qui bufferise transformerait un flux temps réel en flux
      // livré par paquets de 4 ko — donc en rien du tout.
      "x-accel-buffering": "no",
    });

    let closed = false;
    /*
     * CONTRE-PRESSION. `write` rend `false` quand le tampon du noyau est
     * plein : l'ignorer laisse la mémoire du processus grossir sans borne
     * derrière un client lent. Une invalidation est périssable — mieux vaut
     * couper que gonfler.
     */
    const push = (frame: string): void => {
      if (closed) return;
      try {
        if (!reply.raw.write(frame)) fermer();
      } catch {
        fermer();
      }
    };

    const registration = subscribeOutbox(
      request.tenantId,
      (delivery) => push(`data: ${JSON.stringify(delivery)}\n\n`),
      request.membershipRole,
    );
    openConnections.add(fermerRef);

    /*
     * BATTEMENT DE CŒUR — ET REVALIDATION DE L'APPARTENANCE.
     *
     * Sans octet sur le fil, un proxy ou un mobile en veille ferme une
     * connexion inactive, et l'écran cesse d'être averti sans jamais
     * l'apprendre. Mais le battement sert surtout à corriger le défaut le plus
     * grave de la première version : l'autorisation n'était vérifiée QU'À la
     * connexion. Un utilisateur exclu de l'organisation, déconnecté ou dont la
     * session avait expiré continuait de recevoir les événements de ses
     * anciens collègues jusqu'à fermer l'onglet. Toutes les autres routes du
     * produit recontrôlent l'appartenance à chaque requête ; celle-ci ne le
     * faisait jamais.
     *
     * On relit donc le membership à chaque battement — et on relit aussi le
     * RÔLE, pour qu'une rétrogradation coupe les événements owner-only sans
     * attendre une reconnexion.
     */
    const heartbeat = setInterval(() => {
      void (async () => {
        const membership = await prisma.membership
          .findUnique({
            where: {
              tenantId_userId: {
                tenantId: request.tenantId,
                userId: request.authSession.user.id,
              },
            },
            select: { role: true },
          })
          .catch(() => null);
        if (!membership) {
          fermer();
          return;
        }
        /*
         * LA SESSION AUSSI. Relire l'appartenance seule ne couvrait qu'un
         * tiers du défaut annoncé corrigé : une déconnexion, une session
         * expirée ou révoquée laissaient le flux vivant tant que
         * l'appartenance existait — c'est-à-dire dans le cas le plus banal.
         */
        const session = await auth.api
          .getSession({ headers: toWebHeaders(request) })
          .catch(() => null);
        if (!session) {
          fermer();
          return;
        }
        registration.setRole(membership.role);
        push(": ping\n\n");
      })();
    }, heartbeatMsFor(request));

    function fermer(): void {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(maxLife);
      registration.unsubscribe();
      openConnections.delete(fermerRef);
      const restants = (openStreams.get(streamKey) ?? 1) - 1;
      if (restants <= 0) openStreams.delete(streamKey);
      else openStreams.set(streamKey, restants);
      try {
        reply.raw.end();
      } catch {
        /* socket déjà partie */
      }
    }
    function fermerRef(): void {
      fermer();
    }

    /*
     * DURÉE DE VIE ABSOLUE. Même revalidé, un flux qui vit des jours accumule
     * un état que rien ne remet à zéro. `EventSource` reconnecte tout seul :
     * couper périodiquement ne coûte qu'une reconnexion et rejoue toute la
     * chaîne d'autorisation depuis le début.
     */
    const maxLife = setTimeout(fermer, STREAM_MAX_LIFETIME_MS);
    maxLife.unref();

    request.raw.on("close", fermer);
    // Une erreur de socket ne remonte PAS en exception synchrone : sans cet
    // écouteur, le `try/catch` autour de `write` ne couvrait qu'une partie du
    // cas qu'il prétendait traiter.
    reply.raw.on("error", fermer);
  });

  app.get("/me", { preHandler: [requireAuth] }, async (request) => {
    const memberships = await prisma.membership.findMany({
      where: { userId: request.authSession.user.id },
      select: { tenantId: true, role: true, tenant: { select: { name: true, slug: true } } },
    });
    return {
      userId: request.authSession.user.id,
      // Display name only (greeting in the cockpit) — never an identifier.
      name: request.authSession.user.name ?? null,
      activeOrganizationId: request.authSession.session.activeOrganizationId ?? null,
      memberships,
    };
  });

  /*
   * 1-click validation queue (CLAUDE.md rule #4). Agents PREPARE pending
   * actions; only a HUMAN approves or rejects here — validatedBy records who,
   * for legal attribution. State machine: pending -> approved | rejected.
   * Approval/rejection = sensitive action => OWNER only.
   */

  // List = metadata ONLY: payloads carry confidential drafts/invoice data,
  // reserved to the owner-gated detail endpoint (RGPD audit 1.5 — the
  // `accountant` role is a delegated third party).
  /**
   * Budget de lecture des actions EN ATTENTE, indépendant de l'historique.
   *
   * Large à dessein : une file de validation qui tronque, c'est une décision
   * qui n'est jamais prise. Une TPE de 3 à 15 salariés n'approchera pas cette
   * borne — et si elle l'approchait, c'est la file qu'il faudrait repenser,
   * pas la borne qu'il faudrait monter.
   */
  const PENDING_QUEUE_LIMIT = 500;
  /** Historique décidé : borné, lui, parce qu'il ne fait que grandir. */
  const DECIDED_HISTORY_LIMIT = 50;
  /** Aperçu des actions sur une fiche affaire — le TOTAL est compté à part. */
  const AFFAIRE_ACTIONS_LIMIT = 20;

  app.get("/pending-actions", { preHandler: businessRoute }, async (request) => {
    const isOwner = request.membershipRole === "owner";
    // Opening the validation queue = the "actions" push events are SEEN:
    // counter resets, re-notification unlocked (anti-spam rule of 2.17).
    // AWAITED : en fire-and-forget, le marquage pouvait s'exécuter APRÈS un
    // événement arrivé juste ensuite et l'effacer (course constatée en CI).
    await markPushSeen(request.tenantId, request.authSession.user.id, "actions").catch(
      () => undefined,
    );
    const select = {
      id: true,
      type: true,
      status: true,
      requestedBy: true,
      validatedBy: true,
      validatedAt: true,
      createdAt: true,
      // F6 — l'affaire concernée, OWNER SEULEMENT.
      //
      // La référence et le libellé d'un chantier ne sont pas secrets (tout
      // membre lit déjà /affaires). Ce qui l'est, c'est l'ASSOCIATION : « une
      // relance dort sur le chantier Bardin » se lit « Bardin ne paie pas ».
      // Le lien porte donc la même sensibilité que le payload qu'il décrit —
      // et il aurait été incohérent de réserver l'écriture au dirigeant tout
      // en ouvrant la lecture à tous, dans le même diff.
      ...(isOwner
        ? {
            affaireId: true,
            affaire: { select: { reference: true, label: true, status: true } },
          }
        : {}),
      // `payload` n'est JAMAIS sélectionné ici : voir `reducedReasons`.
    } as const;

    /**
     * Motif de réduction des lignes DÉCIDÉES, projeté en SQL.
     *
     * POURQUOI PAS `payload: true` DANS LE SELECT. Une première version le
     * faisait, et rapatriait jusqu'à 550 payloads complets — brouillons
     * nominatifs, factures clients, verbatims de dictée — à chaque
     * chargement de la file, pour n'en lire qu'une phrase. C'est mot pour mot
     * ce que le balayage de rétention refuse de faire (`retention.ts`), et
     * l'argument ne vaut pas moins sur le chemin chaud de l'API : du contenu
     * sensible manipulé sans finalité reste du contenu sensible manipulé sans
     * finalité. Postgres extrait donc le seul champ utile, et le payload ne
     * quitte jamais la base.
     *
     * Les motifs sont FIGÉS côté serveur (« source effacée (purge FEC) »,
     * « sans décision ni reprise depuis N jours… ») : aucun contenu client ne
     * transite par ce champ. `rejectProspectDrafts` (2.12) n'en écrit pas — la
     * ligne est alors réduite sans motif, plutôt que de lui en inventer un.
     *
     * Owner seulement, et sur l'historique seulement : c'est le seul endroit
     * qui l'affiche, une action en attente ouvrant son détail complet.
     */
    const reducedReasons = async (
      tx: Prisma.TransactionClient,
      ids: readonly string[],
    ): Promise<Map<string, string>> => {
      if (!isOwner || ids.length === 0) return new Map();
      const rows = await tx.$queryRaw<{ id: string; reason: string | null }[]>`
        SELECT id, payload->>'reducedReason' AS reason
          FROM pending_actions
         WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
           AND (payload->'reduced') = 'true'::jsonb`;
      return new Map(
        rows.filter((row) => typeof row.reason === "string").map((row) => [row.id, row.reason!]),
      );
    };

    return withTenant(request.tenantId, async (tx) => {
      /*
       * DEUX requêtes, et c'est la règle du ticket qui l'impose.
       *
       * Une seule requête bornée à 100 toutes statuts confondus faisait sortir
       * une VIEILLE action en attente dès que 100 actions plus récentes —
       * décidées comprises — existaient. Elle disparaissait aussi du badge de
       * navigation, qui dérive de la même requête : indécidable, et en
       * silence. Exactement ce que ce ticket dit interdire.
       *
       * Les actions en attente ont donc leur propre budget, indépendant de
       * l'historique. Au-delà de PENDING_QUEUE_LIMIT la file tronquerait
       * encore — un TPE n'y arrivera pas, mais la borne est écrite ici plutôt
       * que promise absente.
       */
      const pending = await tx.pendingAction.findMany({
        where: { status: "pending" },
        orderBy: { createdAt: "desc" },
        take: PENDING_QUEUE_LIMIT,
        select,
      });
      const decided = await tx.pendingAction.findMany({
        where: { status: { not: "pending" } },
        orderBy: { createdAt: "desc" },
        take: DECIDED_HISTORY_LIMIT,
        select,
      });
      // L'historique est le seul endroit qui rend le motif : une action en
      // attente ouvre son détail complet, elle n'en a pas besoin.
      if (!isOwner) return [...pending, ...decided];
      /*
       * Le champ est ABSENT pour un non-owner, pas nul. `reducedReason: null`
       * se lit « aucun motif, donc rien n'a été retiré » — une affirmation
       * fausse là où la vraie réponse est « pas de votre ressort ». Un champ
       * absent ne dit rien ; un champ nul dit quelque chose d'inexact.
       */
      const reasons = await reducedReasons(
        tx,
        decided.map((action) => action.id),
      );
      return [
        ...pending,
        ...decided.map((action) => ({
          ...action,
          reducedReason: reasons.get(action.id) ?? null,
        })),
      ];
    });
  });

  /*
   * Rattacher (ou détacher) une action à une affaire — F6.
   *
   * OWNER-ONLY, et pas par frilosité : le payload d'une action est owner-gated
   * (1.5), donc un membre ne peut pas VOIR ce que l'action contient. Lui
   * demander de la classer serait lui demander de classer à l'aveugle. C'est
   * l'inverse de l'imputation d'une pièce (4.1), ouverte à tous parce que
   * l'employé de terrain, lui, a la facture sous les yeux.
   *
   * `null` DÉTACHE : un rattachement se corrige, il ne se subit pas. Et le
   * rattachement reste FACULTATIF de bout en bout — une action de frais
   * généraux n'a pas de chantier.
   *
   * Modifiable tant que l'action est `pending` seulement, comme le brouillon :
   * après décision, la ligne est une trace, et une trace ne se réécrit pas.
   */
  app.patch(
    "/pending-actions/:id/affaire",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const params = z.object({ id: Uuid }).safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "invalid pending action id" });
      }
      const body = z.object({ affaireId: Uuid.nullable() }).strict().safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "invalid affaire id" });

      const outcome = await withTenant(request.tenantId, async (tx) => {
        const action = await tx.pendingAction.findUnique({
          where: { id: params.data.id },
          select: { status: true },
        });
        if (!action) return { code: 404 as const, error: "pending action not found" };
        if (action.status !== "pending") {
          return { code: 409 as const, error: `already ${action.status}` };
        }
        if (body.data.affaireId !== null) {
          // La clé composite refuserait déjà le croisement de tenants en base
          // (deuxième couche). On vérifie d'abord pour rendre un 404 motivé
          // plutôt qu'une erreur Prisma remontée en 500 — un refus est une
          // RÉPONSE, pas un plantage.
          const affaire = await tx.affaire.findUnique({
            where: { id: body.data.affaireId },
            select: { id: true },
          });
          if (!affaire) return { code: 404 as const, error: "affaire not found" };
        }
        const { count } = await tx.pendingAction.updateMany({
          where: { id: params.data.id, status: "pending" },
          data: { affaireId: body.data.affaireId },
        });
        if (count === 0) return { code: 409 as const, error: "already decided" };
        return { code: 200 as const };
      });
      if (outcome.code !== 200) {
        return reply.code(outcome.code).send({ error: outcome.error });
      }
      return reply.send({ id: params.data.id, affaireId: body.data.affaireId });
    },
  );

  app.get(
    "/pending-actions/:id",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const params = z.object({ id: Uuid }).safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "invalid pending action id" });
      }
      const action = await withTenant(request.tenantId, (tx) =>
        tx.pendingAction.findUnique({ where: { id: params.data.id } }),
      );
      if (!action) return reply.code(404).send({ error: "pending action not found" });
      return reply.send(action);
    },
  );

  // Draft edit BEFORE decision (owner-only, still pending). The human can
  // rework the prepared text; ONLY `payload.draft` is writable — invoice
  // facts, risk score and extraction stay exactly as the agent produced
  // them, and the edit is attributed (draftEditedBy) for the audit trail.
  app.patch(
    "/pending-actions/:id/draft",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const params = z.object({ id: Uuid }).safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "invalid pending action id" });
      }
      const body = z
        .object({ draft: z.string().trim().min(1).max(20_000) })
        .strict()
        .safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "invalid draft" });
      }
      // The reply is sent AFTER withTenant returns: a 200 must mean the
      // edit is COMMITTED (the human then approves what is really stored).
      const outcome = await withTenant(request.tenantId, async (tx) => {
        const action = await tx.pendingAction.findUnique({
          where: { id: params.data.id },
          select: { status: true, payload: true },
        });
        if (!action) return { code: 404 as const, error: "pending action not found" };
        if (action.status !== "pending") {
          return { code: 409 as const, error: `already ${action.status}` };
        }
        const payload = action.payload as Record<string, unknown> | null;
        if (typeof payload?.draft !== "string") {
          return { code: 422 as const, error: "this action has no editable draft" };
        }
        // Append-only audit trail: the agent's original text is kept once
        // (machine vs human attribution must stay provable), every edit adds
        // a {by, at} entry — nothing is ever erased.
        const originalDraft =
          typeof payload.originalDraft === "string" ? payload.originalDraft : payload.draft;
        const draftEdits = Array.isArray(payload.draftEdits) ? payload.draftEdits : [];
        // Conditional update: if a decision slipped in since the read, the
        // status filter makes this a no-op and the conflict surfaces.
        const { count } = await tx.pendingAction.updateMany({
          where: { id: params.data.id, status: "pending" },
          data: {
            payload: {
              ...payload,
              draft: body.data.draft,
              originalDraft,
              draftEdits: [
                ...draftEdits,
                { by: request.authSession.user.id, at: new Date().toISOString() },
              ],
            },
          },
        });
        if (count === 0) return { code: 409 as const, error: "already decided" };
        return { code: 200 as const };
      });
      if (outcome.code !== 200) {
        return reply.code(outcome.code).send({ error: outcome.error });
      }
      return reply.send({ id: params.data.id, status: "pending", draft: body.data.draft });
    },
  );

  const decide =
    (decision: "approved" | "rejected") => async (request: FastifyRequest, reply: FastifyReply) => {
      const params = z.object({ id: Uuid }).safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "invalid pending action id" });
      }
      /*
       * L'ÉVÉNEMENT DANS LA TRANSACTION QUI ÉCRIT LE STATUT.
       *
       * La première version émettait plus bas, dans la transaction qui réduit
       * le payload — donc une SECONDE transaction. Un crash entre les deux
       * laissait l'action décidée sans événement : exactement la panne que ce
       * module affirme rendre impossible par construction, et le commentaire
       * qui l'accompagnait prétendait le contraire.
       */
      const { count } = await withTenant(request.tenantId, async (tx) => {
        const claimed = await tx.pendingAction.updateMany({
          where: { id: params.data.id, status: "pending" },
          data: {
            status: decision,
            validatedBy: request.authSession.user.id,
            validatedAt: new Date(),
          },
        });
        if (claimed.count > 0) {
          await emitOutbox(tx, request.tenantId, {
            // `decide` n'a qu'un appelant, `/reject` : la branche « approved »
            // était du code mort qui laissait croire à un chemin d'émission
            // inexistant. `/approve` a son propre handler, plus bas.
            type: "action.rejetee",
            objectType: "pending_action",
            objectId: params.data.id,
            changedFields: ["status"],
            correlationId: request.id,
          });
        }
        return claimed;
      });
      if (count === 0) {
        // RLS-scoped: an id from another tenant is indistinguishable from a
        // missing one (404); an already-processed one is a conflict (409).
        const exists = await withTenant(request.tenantId, (tx) =>
          tx.pendingAction.findUnique({ where: { id: params.data.id }, select: { status: true } }),
        );
        if (!exists) return reply.code(404).send({ error: "pending action not found" });
        return reply.code(409).send({ error: `already ${exists.status}` });
      }
      const updated = await withTenant(request.tenantId, async (tx) => {
        const row = await tx.pendingAction.findUniqueOrThrow({
          where: { id: params.data.id },
        });
        // Rejetée aussi : la facture du client n'a plus de raison de rester
        // en file (art. 5.1.c) — seul le résumé de lecture survit.
        const reduced = reduceFinishedPayload(row.type, row.payload);
        if (reduced) {
          await tx.pendingAction.update({
            where: { id: params.data.id },
            data: { payload: reduced },
          });
        }
        return {
          id: row.id,
          type: row.type,
          status: row.status,
          validatedBy: row.validatedBy,
          validatedAt: row.validatedAt,
        };
      });
      return reply.send(updated);
    };

  app.post(
    "/pending-actions/:id/approve",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const params = z.object({ id: Uuid }).safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "invalid pending action id" });
      }
      // Atomic claim pending -> approved: exactly ONE approval wins, so the
      // execution below runs exactly once (double-approve => 409, no re-run).
      /*
       * L'ÉVÉNEMENT DÈS LA REVENDICATION, pas seulement à la fin.
       *
       * La version précédente n'émettait que dans la transaction finale : un
       * crash entre la revendication et l'exécution laissait une action
       * `approved` sortie du compteur « à valider » SANS aucun événement, et un
       * crash après une écriture d'exécuteur laissait un mouvement de stock ou
       * une immobilisation écrits sans que rien ne périme les écrans. Le
       * message de commit affirmait l'atomicité pour ce chemin ; elle n'était
       * vraie que du dernier tiers.
       *
       * Deux événements pour une approbation, donc — et c'est correct : le
       * consommateur d'invalidation est idempotent, recharger deux fois rend
       * la même chose.
       */
      const { count } = await withTenant(request.tenantId, async (tx) => {
        const claimed = await tx.pendingAction.updateMany({
          where: { id: params.data.id, status: "pending" },
          data: {
            status: "approved",
            validatedBy: request.authSession.user.id,
            validatedAt: new Date(),
          },
        });
        if (claimed.count > 0) {
          await emitOutbox(tx, request.tenantId, {
            type: "action.validee",
            objectType: "pending_action",
            objectId: params.data.id,
            changedFields: ["status"],
            correlationId: request.id,
          });
        }
        return claimed;
      });
      if (count === 0) {
        const exists = await withTenant(request.tenantId, (tx) =>
          tx.pendingAction.findUnique({ where: { id: params.data.id }, select: { status: true } }),
        );
        if (!exists) return reply.code(404).send({ error: "pending action not found" });
        return reply.code(409).send({ error: `already ${exists.status}` });
      }

      // Execute AFTER human approval — the only place a prepared action runs.
      const action = await withTenant(request.tenantId, (tx) =>
        tx.pendingAction.findUniqueOrThrow({ where: { id: params.data.id } }),
      );
      const executor = executors[action.type];
      let outcome: { status: "executed" | "failed"; result: object };
      if (!executor) {
        outcome = { status: "failed", result: { error: "no-executor" } };
      } else {
        try {
          const result = await executor(action.payload, {
            tenantId: request.tenantId,
            userId: request.authSession.user.id,
            connectors: agentContext,
          });
          outcome = { status: "executed", result: (result ?? {}) as object };
        } catch (error) {
          // Error NAME only — an executor error must never echo payload content.
          outcome = {
            status: "failed",
            result: { error: error instanceof Error ? error.name : "Error" },
          };
        }
      }
      // Minimisation : une action terminée n'a plus besoin de porter la
      // facture complète du client (elle a servi à reconstruire le document).
      const reduced = reduceFinishedPayload(action.type, action.payload);
      const updated = await withTenant(request.tenantId, async (tx) => {
        const row = await tx.pendingAction.update({
          where: { id: params.data.id },
          data: {
            status: outcome.status,
            executedAt: new Date(),
            result: outcome.result,
            ...(reduced ? { payload: reduced } : {}),
          },
          select: {
            id: true,
            type: true,
            status: true,
            validatedBy: true,
            validatedAt: true,
            executedAt: true,
            result: true,
          },
        });
        /*
         * L'ÉVÉNEMENT D'ORIGINE DU 2.21, émis DANS la transaction.
         *
         * C'est ici que le bug se voyait : le patron validait une action, la
         * base changeait, et tous les AUTRES écrans — un second onglet, le
         * poste d'un collègue — continuaient d'afficher les anciens chiffres
         * jusqu'à un rechargement manuel. L'écran qui valide se rafraîchit
         * déjà tout seul ; c'est ailleurs que le produit mentait.
         *
         * Une action ÉCHOUÉE émet aussi : son statut a changé, donc la file
         * et le compteur du cockpit sont périmés. Ne pas émettre laisserait
         * l'échec invisible partout sauf sur l'écran qui l'a déclenché.
         */
        await emitOutbox(tx, request.tenantId, {
          type: outcome.status === "executed" ? "action.validee" : "action.echouee",
          objectType: "pending_action",
          objectId: row.id,
          changedFields: ["status", "executedAt"],
          correlationId: request.id,
        });
        return row;
      });
      return reply.send(updated);
    },
  );

  app.post(
    "/pending-actions/:id/reject",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    decide("rejected"),
  );

  /**
   * Conversation with the Compta/Direction virtual employee — SSE stream.
   * The agent runtime is constructed HERE, from the session's active
   * organization, AFTER the full auth chain: the tenant provenance follow-up
   * from tickets 1.2/1.3 is closed at this exact line.
   */
  app.post("/employees/compta/chat", { preHandler: businessRoute }, async (request, reply) => {
    const body = z
      .object({ message: z.string().min(1).max(10_000), conversationId: Uuid.optional() })
      .safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid payload" });
    }
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (event: object): void => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const agentRuntime = new ComptaAgent({
      ...agentContext,
      tenantId: request.tenantId,
      requestedBy: request.authSession.user.id,
      // The toolset filters owner-only tools (treasury) on this role.
      role: request.membershipRole,
      // Push doorbell (2.17): a prepared pending_action notifies the OWNERS
      // (the validators). Fire-and-forget — a push failure must never break
      // the chat; and no data crosses this callback by design.
      onPendingAction: () => {
        void notifyPendingAction(request.tenantId).catch((error: unknown) => {
          request.log.warn(
            { err: error instanceof Error ? error.name : "Error" },
            "push record failed",
          );
        });
      },
    });
    try {
      await agentRuntime.run(body.data.message, {
        ...(body.data.conversationId ? { conversationId: body.data.conversationId } : {}),
        onEvent: send,
      });
    } catch (error) {
      // Error NAME only in the stream — never content.
      send({ type: "error", name: error instanceof Error ? error.name : "Error" });
    } finally {
      reply.raw.end();
    }
    return reply;
  });

  // Débit du cockpit conversationnel (2.5) : 20 questions par minute et par
  // utilisateur. Réutilise le limiteur en process du socle webhooks — un
  // limiteur partagé (Redis) viendra avec le multi-réplique.
  const askLimiter = new WebhookRateLimiter(20, 60_000);

  /*
   * Cockpit conversationnel (2.5) — une question en français, une réponse
   * chiffrée sur les données du tenant.
   *
   * MÊME boucle que le chat (donc mêmes gardes : toolset lié au tenant de
   * session, outils owner-gated, écritures en file de validation) ; seule la
   * restitution change — pas de flux, une réponse et la liste des outils
   * réellement utilisés, pour que l'utilisateur voie D'OÙ vient le chiffre.
   */
  app.post("/cockpit/ask", { preHandler: businessRoute }, async (request, reply) => {
    const body = z
      .object({ question: z.string().min(3).max(500) })
      .strict()
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid payload" });

    // Débit borné : une question déclenche jusqu'à 6 tours de modèle. Sans
    // plafond, un onglet en boucle consommerait du token sans fin — même
    // raison que le limiteur de la route webhook, autre surface pilotée de
    // l'extérieur. Par UTILISATEUR (pas par IP) : la session est authentifiée.
    if (!askLimiter.take(`${request.tenantId}:${request.authSession.user.id}`)) {
      return reply.code(429).send({ error: "trop de questions — patientez une minute" });
    }

    const agentRuntime = new ComptaAgent({
      ...agentContext,
      tenantId: request.tenantId,
      requestedBy: request.authSession.user.id,
      // Le rôle vient de la SESSION : c'est lui qui ferme les jeux de données
      // réservés au dirigeant, à l'intérieur même de l'outil de requête.
      role: request.membershipRole,
    });

    let answer = "";
    const tools: string[] = [];
    try {
      await agentRuntime.run(body.data.question, {
        onEvent: (event) => {
          if (event.type === "assistant") answer = event.content;
          // Métadonnées seulement : le NOM de l'outil, jamais son résultat.
          if (event.type === "tool_call" && !tools.includes(event.name)) tools.push(event.name);
        },
      });
    } catch (error) {
      request.log.warn(
        { err: error instanceof Error ? error.name : "Error" },
        "cockpit ask failed",
      );
      return reply.code(503).send({ error: "réponse indisponible" });
    }
    // Réponse construite sur des données d'entreprise : jamais mise en cache.
    void reply.header("cache-control", "private, no-store");
    return { answer, tools };
  });

  /*
   * Connector onboarding (ticket 1.8). Rule of the house: credentials go IN,
   * never OUT — stored in the vault under `connector/<tenantId>/<type>`,
   * referenced by name in the connector row, absent from every response.
   * OWNER only: connecting a tool grants the agent read access to the
   * company's books. Credentials are TESTED against the provider before
   * being stored (fail-closed on typos); failures are generic client-side.
   */

  const ConnectorCredentials = {
    pennylane: z.object({ apiKey: z.string().min(8).max(200) }).strict(),
    qonto: z
      .object({
        organizationSlug: z.string().min(1).max(100),
        secretKey: z.string().min(8).max(200),
      })
      .strict(),
    // Agrégateur DSP2 (2.15) : le userUuid est l'utilisateur Bridge dont la
    // banque est déjà reliée (le flux Bridge Connect hébergé viendra après).
    bridge: z
      .object({
        clientId: z.string().min(1).max(200),
        clientSecret: z.string().min(8).max(200),
        userUuid: z.string().min(1).max(100),
      })
      .strict(),
    // SIRH/paie (3.10) : accès via middleware partenaire Silae.
    silae: SilaeCredentials,
    // Plateforme de dématérialisation (2.4) : aucun opérateur en dur.
    pdp: PdpCredentials,
  } as const;

  /**
   * Live credential check before vaulting. The provider response is DISCARDED
   * entirely — it only proves the key works; nothing from it is stored,
   * logged or returned. On failure the caller gets a constant 422; only the
   * error NAME reaches the server log (ops visibility without leaking).
   */
  async function testConnectorCredentials(
    type: ConnectorType,
    credentials: unknown,
    log: FastifyRequest["log"],
  ): Promise<boolean> {
    try {
      if (type === "pennylane") {
        const client = new PennylaneClient(
          ConnectorCredentials.pennylane.parse(credentials),
          agentContext.pennylaneBaseUrl,
        );
        await client.listCustomerInvoices({ limit: 1 });
      } else if (type === "bridge") {
        const client = new BridgeClient(
          ConnectorCredentials.bridge.parse(credentials),
          agentContext.bridgeBaseUrl,
        );
        await client.testConnection();
      } else if (type === "pdp") {
        const client = new HttpPdpClient(
          PdpCredentials.parse(credentials),
          agentContext.pdpBaseUrl,
        );
        await client.testConnection();
      } else if (type === "silae") {
        const client = new SilaeClient(
          SilaeCredentials.parse(credentials),
          agentContext.silaeBaseUrl,
        );
        await client.testConnection();
      } else {
        const client = new QontoClient(
          ConnectorCredentials.qonto.parse(credentials),
          agentContext.qontoBaseUrl,
        );
        await client.getOrganization();
      }
      return true;
    } catch (error) {
      log.warn(
        { type, err: error instanceof Error ? error.name : "Error" },
        "connector credential test failed",
      );
      return false;
    }
  }

  // Metadata only — the credentialsRef itself stays server-side.
  app.get("/connectors", { preHandler: businessRoute }, async (request) => {
    const rows = await withTenant(request.tenantId, (tx) =>
      tx.connector.findMany({
        orderBy: { createdAt: "asc" },
        select: { type: true, status: true, createdAt: true, updatedAt: true },
      }),
    );
    return { connectors: rows };
  });

  app.post(
    "/connectors",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const body = z
        .object({ type: ConnectorType, credentials: z.record(z.unknown()) })
        .safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "invalid payload" });
      const parsed = ConnectorCredentials[body.data.type].safeParse(body.data.credentials);
      if (!parsed.success) return reply.code(400).send({ error: "invalid credentials format" });

      if (!(await testConnectorCredentials(body.data.type, parsed.data, request.log))) {
        // Generic on purpose: no provider status code, no detail.
        return reply.code(422).send({ error: "connection test failed" });
      }

      const secretName = connectorSecretName(request.tenantId, body.data.type);
      await vault.set(secretName, JSON.stringify(parsed.data));
      let row;
      try {
        row = await withTenant(request.tenantId, async (tx) => {
          // One connector per type: replacing = rotating the credentials.
          await tx.connector.deleteMany({ where: { type: body.data.type } });
          return tx.connector.create({
            data: { tenantId: request.tenantId, type: body.data.type, credentialsRef: secretName },
            select: { type: true, status: true, createdAt: true },
          });
        });
      } catch (error) {
        // No orphan credentials: if the row cannot be written, the secret
        // (unreachable by any future DELETE) is purged before failing.
        await vault.delete(secretName).catch(() => undefined);
        throw error;
      }
      return reply.code(201).send(row);
    },
  );

  app.delete(
    "/connectors/:type",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const params = z.object({ type: ConnectorType }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "unknown connector type" });
      // Secret FIRST (droit à l'effacement) : if the vault delete fails the
      // row survives, so a retry purges again — never the other way around,
      // which would strand credentials in the vault with no row to reach them.
      await vault.delete(connectorSecretName(request.tenantId, params.data.type));
      const { count } = await withTenant(request.tenantId, (tx) =>
        tx.connector.deleteMany({ where: { type: params.data.type } }),
      );
      if (count === 0) return reply.code(404).send({ error: "connector not configured" });
      return reply.code(204).send();
    },
  );

  /*
   * Import FEC (ticket 2.14) — le « connecteur fichier » universel (art.
   * A47 A-1 du LPF). Le FEC est une donnée CONFIDENTIELLE par nature (journal
   * comptable complet) : parsé en mémoire, JAMAIS loggé, jamais renvoyé au
   * client ; seuls des compteurs et avertissements sortent. Le fichier brut
   * n'est PAS conservé (minimisation — V1) : seule l'empreinte SHA-256 sert
   * l'idempotence ; un nouvel import remplace intégralement le précédent
   * (jamais d'ingestion partielle : le parseur rejette en bloc).
   */

  // Métadonnées du dernier import — visibles de tout membre (compteurs only).
  // Les avertissements sont stockés en Json : une forme inattendue dégrade en
  // liste vide, jamais en 500 sur l'écran Connecteurs.
  const FecWarnings = z.array(z.string()).catch([]);
  app.get("/connectors/fec", { preHandler: businessRoute }, async (request) => {
    // Métadonnées et retenues LUES ENSEMBLE, dans la MÊME transaction : deux
    // lectures séparées peuvent encadrer un import concurrent et afficher les
    // compteurs d'un import avec les retenues d'un autre.
    const { lastImport } = await withTenant(request.tenantId, async (tx) => {
      const last = await tx.fecImport.findFirst({
        orderBy: { importedAt: "desc" },
        select: {
          id: true,
          importedAt: true,
          fileName: true,
          entryCount: true,
          invoiceCount: true,
          overdueCount: true,
          // Les avertissements portent les LIMITES de la dérivation (retenue
          // non rattachable, par exemple : elle reste comptée en impayé). Ne
          // les rendre qu'au moment de l'import les ferait disparaître au
          // premier rechargement, juste là où ils changent le chiffre lu.
          // Compteurs uniquement — jamais une ligne du journal (2.14).
          warnings: true,
          // Retenues EN COURS (US-8) : le SOLDE du compte 4117, calculé à
          // l'import. Ré-agréger les retenues par facture raterait les
          // libérations comptabilisées sous leur propre pièce et annoncerait
          // « en cours » des sommes déjà encaissées.
          retainedCents: true,
        },
      });
      return { lastImport: last };
    });
    const { id: _importId, retainedCents, warnings, ...lastImportPublic } = lastImport ?? {};
    return {
      imported: lastImport !== null,
      lastImport: lastImport
        ? { ...lastImportPublic, warnings: FecWarnings.parse(warnings) }
        : null,
      retention: {
        // PAS de nombre de factures : une libération comptabilisée sous une
        // autre pièce n'est rattachable à aucune facture, donc « 1 000 € en
        // cours (2 factures concernées) » peut compter une facture dont la
        // retenue est déjà encaissée. Le solde du compte, lui, est juste — il
        // reste la seule vérité affichée.
        // Le MONTANT est une créance en euros : owner-only, comme
        // `overdueCents` (volontairement absent de cette route), la marge et
        // le rapport mensuel. Le FAIT, lui, est dit à tout membre — le taire
        // le ramènerait au geste qu'on veut éviter : relancer ces lignes.
        totalCents: request.membershipRole === "owner" ? Number(retainedCents ?? 0n) : null,
        inProgress: (retainedCents ?? 0n) > 0n,
        // La date de libération est CONTRACTUELLE : elle n'est nulle part
        // dans un FEC. On ne l'invente pas — la saisir est un ticket à part.
        releaseDateKnown: false,
      },
    };
  });

  // Le parser binaire est CANTONNÉ à cette route (plugin encapsulé) : le
  // reste de l'API n'accepte pas de corps octet-stream.
  void app.register(async (fec) => {
    fec.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );

    fec.post(
      "/connectors/fec/import",
      {
        preHandler: [...businessRoute, requireRole(["owner"])],
        bodyLimit: 50 * 1024 * 1024,
      },
      async (request, reply) => {
        const body = request.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          return reply
            .code(400)
            .send({ error: "fichier FEC attendu (corps application/octet-stream)" });
        }

        const fileHash = createHash("sha256").update(body).digest("hex");
        // Parse + dérivation AVANT la transaction (aucun IO DB pendant).
        const parsed = parseFec(new Uint8Array(body));
        if (!parsed.ok) {
          // Numéros de ligne et messages génériques UNIQUEMENT — jamais le contenu.
          return reply.code(422).send({ error: "FEC invalide", details: parsed.errors });
        }
        const derivation = deriveReceivables(parsed.entries);
        // Charges (2.8) : le FEC porte les charges RÉELLES. Sans cette
        // dérivation, la marge reposerait sur une saisie mensuelle que
        // personne ne tient — et l'oubli fait justement paraître la marge
        // meilleure qu'elle n'est. Agrégats SEULEMENT (mois, poste, montant).
        const chargeDerivation = deriveCharges(parsed.entries);
        // Lignes de charge écartées à l'écriture : comptées, jamais tues.
        let rejectedCharges = 0;

        // Métadonnée d'affichage : nom de fichier assaini, optionnel.
        let fileName: string | null = null;
        const rawName = request.headers["x-fec-filename"];
        if (typeof rawName === "string") {
          try {
            fileName =
              decodeURIComponent(rawName)
                .replace(/[^\p{L}\p{N} ._()-]/gu, "")
                .slice(0, 120) || null;
          } catch {
            fileName = null;
          }
        }

        // Charges (2.8) : ce qui n'a pas pu être rattaché ou stocké est DIT.
        // Une charge avalée en silence embellit la marge sans laisser de trace.
        const chargeWarnings: string[] = [];
        if (chargeDerivation.unmappedCount > 0) {
          chargeWarnings.push(
            `${chargeDerivation.unmappedCount} écriture(s) de charge sans poste de marge ` +
              "(variation de stocks, comptes hors catalogue) : la marge restera un plafond",
          );
        }
        const warnings = [...parsed.warnings, ...derivation.warnings, ...chargeWarnings];
        type Outcome =
          | {
              kind: "already";
              existing: {
                entryCount: number;
                customerCount: number;
                invoiceCount: number;
                overdueCount: number;
                overdueCents: bigint;
                warnings: unknown;
              };
            }
          | { kind: "created" };
        let outcome: Outcome;
        try {
          outcome = await withTenant(
            request.tenantId,
            async (tx) => {
              // Sérialise les imports du tenant (verrou transactionnel) :
              // contrôle d'empreinte et écriture dans la MÊME transaction,
              // jamais deux imports vivants (audit RGPD 2.14).
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${request.tenantId} || ':fec-import'))`;
              const existing = await tx.fecImport.findUnique({
                where: { tenantId_fileHash: { tenantId: request.tenantId, fileHash } },
              });
              if (existing) return { kind: "already", existing } satisfies Outcome;
              // deleteMany SCOPÉ tenant : la RLS reste le dernier rempart,
              // pas la seule barrière (défense en profondeur).
              await tx.fecImport.deleteMany({ where: { tenantId: request.tenantId } });
              const imported = await tx.fecImport.create({
                data: {
                  tenantId: request.tenantId,
                  fileHash,
                  fileName,
                  entryCount: parsed.entries.length,
                  customerCount: derivation.customers.length,
                  invoiceCount: derivation.invoices.length,
                  overdueCount: derivation.overdueCount,
                  overdueCents: BigInt(derivation.overdueCents),
                  // Solde du compte 4117 (US-8) — jamais la somme des
                  // retenues par facture : une libération sous sa propre
                  // pièce n'est rattachable à aucune facture.
                  retainedCents: BigInt(derivation.retainedCents),
                  warnings,
                },
              });
              // Écriture par lots : borne la taille de chaque requête.
              for (let i = 0; i < derivation.invoices.length; i += 5000) {
                await tx.fecInvoice.createMany({
                  data: derivation.invoices.slice(i, i + 5000).map((invoice) => ({
                    tenantId: request.tenantId,
                    importId: imported.id,
                    customerRef: invoice.customerRef,
                    customerName: invoice.customerName,
                    number: invoice.number,
                    issuedDate: new Date(`${invoice.issuedDate}T00:00:00Z`),
                    dueDate: new Date(`${invoice.dueDate}T00:00:00Z`),
                    amountCents: BigInt(invoice.amountCents),
                    residualCents: BigInt(invoice.residualCents),
                    // Retenue de garantie (US-8) : conservée à part, jamais
                    // fondue dans le solde exigible.
                    retainedCents: BigInt(invoice.retainedCents),
                    settled: invoice.settled,
                  })),
                });
              }
              // Charges dérivées (2.8) : on remplace les lignes de source
              // `fec` du tenant — un nouvel import fait foi sur les précédents
              // — SANS toucher aux saisies humaines (source `saisi`), que
              // l'unicité (tenant, mois, poste, source) garde distinctes.
              await tx.costEntry.deleteMany({
                where: { tenantId: request.tenantId, source: "fec" },
              });
              // Validation AVANT écriture : un poste hors catalogue ou un
              // agrégat hors bornes violerait le CHECK et ferait échouer TOUT
              // l'import (500) au lieu de rejeter une ligne. Le CHECK reste le
              // dernier rempart, il n'est pas le premier.
              const storable = chargeDerivation.charges.filter(
                (charge) =>
                  STORABLE_CATEGORY_IDS.includes(charge.category) &&
                  Number.isSafeInteger(charge.amountCents) &&
                  Math.abs(charge.amountCents) <= 2_000_000_000,
              );
              rejectedCharges = chargeDerivation.charges.length - storable.length;
              for (let i = 0; i < storable.length; i += 5000) {
                await tx.costEntry.createMany({
                  data: storable.slice(i, i + 5000).map((charge) => ({
                    tenantId: request.tenantId,
                    month: charge.month,
                    category: charge.category,
                    amountCents: charge.amountCents,
                    source: "fec",
                  })),
                });
              }
              // Le « connecteur fichier » : statut "file" (jamais "active" —
              // rien n'est connecté), posé UNIQUEMENT ici. Aucun secret associé.
              await tx.connector.upsert({
                where: {
                  tenantId_type: { tenantId: request.tenantId, type: FEC_CONNECTOR_TYPE },
                },
                update: { status: FEC_CONNECTOR_STATUS },
                create: {
                  tenantId: request.tenantId,
                  type: FEC_CONNECTOR_TYPE,
                  status: FEC_CONNECTOR_STATUS,
                  credentialsRef: connectorSecretName(request.tenantId, FEC_CONNECTOR_TYPE),
                },
              });
              return { kind: "created" } satisfies Outcome;
            },
            { timeoutMs: 30_000 },
          );
        } catch (error) {
          // Une erreur Prisma peut citer ses arguments (valeurs du FEC) : on
          // logue le NOM et des compteurs, jamais l'objet d'erreur complet.
          request.log.error(
            {
              err: error instanceof Error ? error.name : "Error",
              invoices: derivation.invoices.length,
            },
            "fec import failed",
          );
          return reply.code(500).send({ error: "import failed" });
        }

        if (outcome.kind === "already") {
          return reply.send({
            alreadyImported: true,
            entryCount: outcome.existing.entryCount,
            customerCount: outcome.existing.customerCount,
            invoiceCount: outcome.existing.invoiceCount,
            overdueCount: outcome.existing.overdueCount,
            overdueCents: Number(outcome.existing.overdueCents),
            warnings: z.array(z.string()).catch([]).parse(outcome.existing.warnings),
          });
        }
        // Immobilisations (2.19) : les comptes 2x/28x deviennent des
        // PROPOSITIONS en file de validation — jamais une insertion
        // silencieuse ; incohérences signalées dans le payload.
        let assetProposals = 0;
        const allProposals = deriveFixedAssets(parsed.entries);
        const proposals = allProposals.slice(0, 200);
        if (allProposals.length > 200) {
          warnings.push("propositions d'immobilisations tronquées à 200");
        }
        if (rejectedCharges > 0) {
          warnings.push(
            `${rejectedCharges} agrégat(s) de charges non enregistré(s) (hors bornes) : ` +
              "la marge de ces mois restera un plafond",
          );
        }
        try {
          if (proposals.length > 0) {
            assetProposals = await withTenant(
              request.tenantId,
              async (tx) => {
                let count = 0;
                for (const proposal of proposals) {
                  const sourceRef = `fec:${proposal.accountNum}`;
                  const existingAsset = await tx.fixedAsset.findFirst({
                    where: { source: "FEC", sourceRef },
                    select: { id: true },
                  });
                  if (existingAsset) continue;
                  const pendingProposal = await tx.pendingAction.findFirst({
                    where: {
                      type: "create_fixed_asset",
                      status: "pending",
                      payload: { path: ["sourceRef"], equals: sourceRef },
                    },
                    select: { id: true },
                  });
                  if (pendingProposal) continue;
                  await tx.pendingAction.create({
                    data: {
                      tenantId: request.tenantId,
                      type: "create_fixed_asset",
                      requestedBy: request.authSession.user.id,
                      employee: "compta",
                      payload: {
                        label: proposal.label,
                        category: proposal.category,
                        inServiceDate: proposal.inServiceDate,
                        baseCents: proposal.baseCents,
                        durationMonths: ASSET_CATEGORIES[proposal.category].defaultMonths,
                        method: "LINEAIRE",
                        source: "FEC",
                        sourceRef,
                        priorDepreciationCents: proposal.priorDepreciationCents,
                        warnings: proposal.warnings,
                      },
                    },
                  });
                  count += 1;
                }
                return count;
              },
              { timeoutMs: 30_000 },
            );
            if (assetProposals > 0) {
              void notifyPendingAction(request.tenantId).catch(() => undefined);
            }
          }
        } catch (error) {
          // Même règle que l'import : une erreur Prisma peut citer ses
          // arguments (libellés/montants dérivés du FEC) — nom SEULEMENT,
          // et l'import lui-même reste acquis (les propositions attendront
          // un prochain import après purge).
          request.log.warn(
            { err: error instanceof Error ? error.name : "Error" },
            "fixed asset proposals failed",
          );
          warnings.push("propositions d'immobilisations indisponibles (réessayez après purge FEC)");
        }
        return reply.code(201).send({
          alreadyImported: false,
          entryCount: parsed.entries.length,
          customerCount: derivation.customers.length,
          invoiceCount: derivation.invoices.length,
          overdueCount: derivation.overdueCount,
          overdueCents: derivation.overdueCents,
          fixedAssetProposals: assetProposals,
          warnings,
        });
      },
    );
  });

  /**
   * Réduit les propositions dérivées d'une source qu'on vient d'effacer.
   *
   * Une proposition d'immobilisation porte dans son `payload` un libellé de
   * compte, des montants et des avertissements TIRÉS de la source (journal
   * comptable, pièce photographiée). Effacer la source sans y toucher laissait
   * ces dérivés en base — un effacement qui affirme plus qu'il ne fait.
   *
   * DEUX RÉGIMES, parce que les deux lignes ne valent pas la même chose :
   *
   * - `pending` : la proposition est REJETÉE et réduite. Approuver une
   *   proposition dont la source a disparu créerait une immobilisation que
   *   plus personne ne peut vérifier ;
   * - décidée : le `payload` est réduit, mais la ligne, son statut et son
   *   attribution RESTENT. Qui a décidé quoi et quand n'est pas une donnée
   *   dérivée de la source : c'est la trace de la décision d'un humain, et
   *   l'effacement d'une source ne réécrit pas l'histoire.
   *
   * Ce que la purge NE touche PAS : l'immobilisation déjà créée. C'est une
   * donnée métier propre — un actif que l'entreprise possède, saisi par une
   * décision humaine explicite. La supprimer détruirait de la comptabilité
   * légitime au nom de l'effacement d'autre chose.
   *
   * Même patron que `rejectProspectDrafts` (2.12), pour la même raison.
   */
  /*
   * TRANSCRIPTIONS D'AGENT — effacer une source les efface TOUTES (art. 17).
   *
   * `agent_conversations.messages` porte le fil complet, résultats d'outils
   * compris : un `analyze_margin` y dépose des noms de chantiers et des
   * montants, un `list_overdue_invoices` des noms de clients et ce qu'ils
   * doivent, une recherche de prospection des coordonnées. C'est la donnée la
   * plus concentrée du produit, dans sa forme la moins structurée.
   *
   * POURQUOI TOUTES, ET PAS « CELLES QUI CITENT LA SOURCE ». Aucun lien
   * n'existe entre un transcript et une source : les résultats d'outils sont
   * des chaînes opaques, jamais indexées. Les retrouver imposerait de chercher
   * un nom dans du texte libre — exactement l'inférence que la doctrine
   * interdit, et en plus peu fiable : un homonyme, une troncature, une
   * reformulation du modèle, et l'effacement se croit complet en laissant la
   * donnée.
   *
   * Le coût des deux erreurs est très asymétrique. Ce qu'on détruit en trop :
   * la possibilité de REPRENDRE une conversation — et son identifiant ne vit
   * que dans un `useRef` de l'écran de chat, donc un simple rechargement de
   * page l'a déjà perdue. Ce qu'on laisserait en moins : le nom d'une personne
   * qui vient d'exercer son droit à l'effacement. On efface.
   *
   * DANS LA MÊME TRANSACTION que la purge, comme le reste : une source
   * effacée avec ses dérivés restants est le pire des deux mondes.
   */
  async function purgeAgentTranscripts(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<number> {
    /*
     * `tenantId` EXPLICITE, en plus de la RLS. Un `deleteMany({})` nu ne tient
     * que par une seule couche, alors que toutes les suppressions voisines des
     * mêmes blocs filtrent (`fecImport.deleteMany({ where: { tenantId } })`).
     * Et cette signature accepte n'importe quelle transaction — `withOps`, un
     * `$transaction` nu : rien au niveau du type n'empêcherait un futur
     * appelant de vider tous les tenants. Le filtre coûte un mot.
     */
    const { count } = await tx.agentConversation.deleteMany({ where: { tenantId } });
    return count;
  }

  async function reduceDerivedProposals(
    tx: Prisma.TransactionClient,
    source: { readonly label: string; readonly sourceRefPrefix: string },
  ): Promise<{ rejected: number; reduced: number }> {
    // `string_starts_with` sur le chemin JSON : les propositions FEC portent
    // `fec:<compte>`, celles du classeur `classeur:<id>`.
    const where = {
      type: "create_fixed_asset",
      payload: {
        path: ["sourceRef"],
        string_starts_with: source.sourceRefPrefix,
      },
    } as const;
    const reducedPayload = {
      reduced: true,
      reducedReason: source.label,
    } as Prisma.InputJsonValue;

    const rejected = await tx.pendingAction.updateMany({
      where: { ...where, status: "pending" },
      data: { status: "rejected", payload: reducedPayload },
    });
    /*
     * AUCUN filtre de statut ici, et c'est la correction d'un trou béant.
     *
     * La version précédente excluait `status: "rejected"` pour ne pas repasser
     * sur les lignes que l'appel ci-dessus venait de rejeter. Elle excluait du
     * même coup les propositions rejetées AVANT la purge — c'est-à-dire l'état
     * décidé le plus fréquent, puisque l'écran de validation dit lui-même
     * « Catégorie ou durée à ajuster ? Rejetez, puis saisissez manuellement ».
     * Le cas majoritaire échappait donc entièrement à l'effacement.
     *
     * Le filtre juste n'est pas le statut mais le PAYLOAD : une ligne déjà
     * réduite n'a plus de `sourceRef`, donc elle ne correspond plus à `where`.
     * Le premier appel se retire du lot de lui-même.
     */
    const reduced = await tx.pendingAction.updateMany({
      where,
      data: { payload: reducedPayload },
    });
    return { rejected: rejected.count, reduced: reduced.count };
  }

  // Droit à l'effacement (RGPD art. 17) : purge des données dérivées du FEC
  // (imports + factures via cascade) et du connecteur fichier. Owner only.
  app.delete(
    "/connectors/fec",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const outcome = await withTenant(request.tenantId, async (tx) => {
        // Contrôle d'existence AVANT d'écrire : un 404 ne doit rien avoir
        // effacé au passage.
        const imports = await tx.fecImport.count();
        if (imports === 0) return null;

        const { count } = await tx.fecImport.deleteMany({
          where: { tenantId: request.tenantId },
        });
        // DANS LA MÊME TRANSACTION : une purge partiellement appliquée serait
        // le pire des deux mondes — la source effacée, les dérivés restants,
        // et plus rien pour les relier à quoi que ce soit.
        const proposals = await reduceDerivedProposals(tx, {
          label: "source effacée (purge FEC)",
          sourceRefPrefix: "fec:",
        });
        /*
         * Les AGRÉGATS DE CHARGES dérivés du journal (2.x) — oubliés de la
         * première version, et l'import lui-même prouve qu'ils lui
         * appartiennent : il les efface et les réécrit à chaque passage
         * (`costEntry.deleteMany({ source: "fec" })`). Les laisser, c'est
         * servir dans la marge, le cockpit et le brief des charges tirées d'un
         * journal qu'on affirme avoir effacé.
         *
         * Les saisies HUMAINES (`source: "saisi"`) ne sont pas touchées : ce
         * ne sont pas des dérivés, ce sont les chiffres du patron.
         */
        const charges = await tx.costEntry.deleteMany({
          where: { tenantId: request.tenantId, source: "fec" },
        });
        await tx.connector.deleteMany({ where: { type: FEC_CONNECTOR_TYPE } });
        const transcripts = await purgeAgentTranscripts(tx, request.tenantId);
        return { imports: count, proposals, charges: charges.count, transcripts };
      });
      if (outcome === null) return reply.code(404).send({ error: "no fec import" });
      // Une purge qui rejette 200 propositions sans un mot contredirait le
      // principe même de ce ticket : ce qui est fait est DIT.
      return reply.send({
        purged: true,
        imports: outcome.imports,
        propositionsRejetees: outcome.proposals.rejected,
        propositionsReduites: outcome.proposals.reduced,
        chargesDerivees: outcome.charges,
        // Une purge qui efface les conversations en cours sans le dire ferait
        // croire à une panne du chat au prochain message.
        conversationsEffacees: outcome.transcripts,
      });
    },
  );

  /*
   * Classeur documentaire photo (ticket 2.16). La photo (confidentielle) vit
   * en base sous RLS ; l'extraction passe par route() (tier souverain vision,
   * catégorie confidentiel par construction) ; le rapprochement score les
   * transactions bancaires. Capture/correction : tout membre (l'employé de
   * terrain photographie). Rapprochement (données bancaires) et effacement :
   * owner uniquement — même raisonnement tiers-délégué que la trésorerie.
   */

  const DOC_SELECT = {
    id: true,
    fileName: true,
    mimeType: true,
    byteSize: true,
    docType: true,
    status: true,
    extraction: true,
    originalExtraction: true,
    corrections: true,
    learned: true,
    matchedTransactionId: true,
    matchedAt: true,
    // Sans lui, l'écran classeur ne savait jamais qu'une pièce était déjà
    // rattachée : il reproposait de la rattacher, et l'utilisateur récupérait
    // un 409 qui parlait d'une « autre » affaire — souvent la même.
    affaireId: true,
    createdAt: true,
    updatedAt: true,
  } as const; // jamais `photo` dans une liste — servie par la route dédiée

  /**
   * Mémoire fournisseur du tenant (2.16b) — DÉRIVÉE, jamais stockée.
   *
   * Lecture STRICTEMENT tenant-scopée (`withTenant`) : les corrections d'un
   * tenant ne peuvent pas influencer le classement d'un autre. C'est la
   * propriété la plus importante de la boucle d'apprentissage, et elle est
   * testée. Fenêtre bornée : une mémoire ne relit pas tout l'historique.
   */
  const loadSupplierMemory = async (tenantId: string): Promise<SupplierMemory[]> => {
    const rows = await withTenant(tenantId, (tx) =>
      tx.classeurDocument.findMany({
        // Seuls les documents PORTANT une correction humaine : les autres
        // n'apprennent rien et coûteraient une lecture pour rien.
        where: { status: { in: ["verifie", "rapproche"] }, NOT: { corrections: { equals: [] } } },
        orderBy: { updatedAt: "desc" },
        take: MEMORY_WINDOW,
        // `originalExtraction` n'est PAS relue : la preuve vient du journal
        // des corrections, pas d'une comparaison avec la lecture du modèle.
        select: { extraction: true, corrections: true },
      }),
    );
    return buildSupplierMemory(
      rows.map((row) => ({
        // JSONB relu depuis la base : validé, jamais casté (frontières typées).
        final: DocExtraction.partial().safeParse(row.extraction).data ?? null,
        humanFields: humanFieldsOf(row.corrections),
      })),
    );
  };

  /** Ce que le classeur a appris de VOTRE entreprise — et rien d'autre. */
  app.get("/classeur/memoire", { preHandler: businessRoute }, async (request, reply) => {
    const memories = await loadSupplierMemory(request.tenantId);
    // Noms de fournisseurs : donnée d'entreprise, jamais mise en cache.
    void reply.header("cache-control", "private, no-store");
    return { suppliers: memories, minEvidence: MIN_EVIDENCE, window: MEMORY_WINDOW };
  });

  /** Formats photo acceptés, détectés sur les OCTETS (jamais l'extension). */
  function sniffImageMime(buffer: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
    if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return "image/jpeg";
    }
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buffer.length > 8 && buffer.subarray(0, 8).equals(pngMagic)) return "image/png";
    if (
      buffer.length > 12 &&
      buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
      buffer.subarray(8, 12).toString("latin1") === "WEBP"
    ) {
      return "image/webp";
    }
    return null;
  }

  app.get("/classeur/documents", { preHandler: businessRoute }, async (request, reply) => {
    // Noms de fournisseurs et montants : jamais mis en cache par un
    // intermédiaire (même doctrine que la mémoire et l'échéancier).
    void reply.header("cache-control", "private, no-store");
    const documents = await withTenant(request.tenantId, (tx) =>
      tx.classeurDocument.findMany({
        orderBy: { createdAt: "desc" },
        take: 200,
        select: DOC_SELECT,
      }),
    );
    return { documents };
  });

  // Le parser binaire est CANTONNÉ à cette route (plugin encapsulé).
  void app.register(async (classeur) => {
    classeur.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );

    classeur.post(
      "/classeur/documents",
      // onRequest (pas preHandler) : l'auth est vérifiée AVANT que Fastify ne
      // bufferise le corps — un anonyme ne coûte jamais 8 Mo d'allocation.
      { onRequest: businessRoute, bodyLimit: 8 * 1024 * 1024 },
      async (request, reply) => {
        const body = request.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          return reply.code(400).send({ error: "photo attendue (corps application/octet-stream)" });
        }
        // Quota par tenant : borne le stockage (≤ ~4 Go) ET les appels vision
        // facturés — un membre ne peut pas boucler indéfiniment.
        const documentCount = await withTenant(request.tenantId, (tx) =>
          tx.classeurDocument.count(),
        );
        if (documentCount >= 500) {
          return reply
            .code(409)
            .send({ error: "quota du classeur atteint (500 documents) — supprimez d'abord" });
        }
        const mimeType = sniffImageMime(body);
        if (!mimeType) {
          return reply.code(415).send({ error: "format non pris en charge (JPEG, PNG ou WebP)" });
        }
        const sha256 = createHash("sha256").update(body).digest("hex");

        // Métadonnée d'affichage : nom de fichier assaini, optionnel.
        let fileName: string | null = null;
        const rawName = request.headers["x-doc-filename"];
        if (typeof rawName === "string") {
          try {
            fileName =
              decodeURIComponent(rawName)
                .replace(/[^\p{L}\p{N} ._()-]/gu, "")
                .slice(0, 120) || null;
          } catch {
            fileName = null;
          }
        }

        // Dédup AVANT l'appel modèle : re-photographier le même fichier ne
        // coûte ni extraction ni stockage.
        const existing = await withTenant(request.tenantId, (tx) =>
          tx.classeurDocument.findUnique({
            where: { tenantId_sha256: { tenantId: request.tenantId, sha256 } },
            select: DOC_SELECT,
          }),
        );
        if (existing) return reply.send({ alreadyImported: true, document: existing });

        // Extraction via le tier souverain vision — AVANT la transaction (pas
        // d'IO DB pendant l'appel réseau). Un échec modèle n'empêche pas le
        // classement : le document est stocké, les champs restent à saisir.
        let extraction: DocExtraction | null = null;
        try {
          extraction = await extractDocumentFields(request.tenantId, `classeur-${randomUUID()}`, {
            mimeType,
            base64: body.toString("base64"),
          });
        } catch (error) {
          // Nom d'erreur uniquement — jamais le contenu du document.
          request.log.warn(
            { err: error instanceof Error ? error.name : "Error" },
            "classeur extraction failed",
          );
        }

        // Boucle d'apprentissage (2.16b) : la mémoire fournisseur, DÉRIVÉE des
        // corrections déjà validées par ce tenant, comble les trous de
        // l'extraction et signale les désaccords. Elle n'écrase jamais une
        // lecture du modèle, et `originalExtraction` reste la lecture BRUTE —
        // c'est elle la vérité terrain du prochain apprentissage.
        let learning: MemoryApplication | null = null;
        if (extraction) {
          try {
            const memories = await loadSupplierMemory(request.tenantId);
            learning = applySupplierMemory(extraction, memories);
          } catch (error) {
            // L'apprentissage est un CONFORT : son échec ne perd pas un
            // document. Nom d'erreur seulement (le contenu est confidentiel).
            request.log.warn(
              { err: error instanceof Error ? error.name : "Error" },
              "classeur memory unavailable",
            );
          }
        }

        try {
          const document = await withTenant(request.tenantId, (tx) =>
            tx.classeurDocument.create({
              data: {
                tenantId: request.tenantId,
                fileName: fileName ?? "",
                mimeType,
                byteSize: body.length,
                sha256,
                photo: new Uint8Array(body),
                ...(extraction
                  ? {
                      docType: learning?.extraction.docType ?? extraction.docType,
                      extraction: learning?.extraction ?? extraction,
                      // Lecture BRUTE du modèle, jamais enrichie : sans elle,
                      // la mémoire s'auto-alimenterait de ses propres
                      // suggestions et se croirait de mieux en mieux fondée.
                      originalExtraction: extraction,
                      ...(learning && learning.applied.length > 0
                        ? { learned: learning.applied as unknown as Prisma.InputJsonValue }
                        : {}),
                    }
                  : {}),
              },
              select: DOC_SELECT,
            }),
          );
          // Immobilisations (2.19) : facture d'équipement au-dessus du seuil
          // -> SUGGESTION « immobiliser ? » en file de validation. JAMAIS
          // automatique : la frontière charge/immo est une décision de gestion.
          // Seuil ET base amortissable en HT UNIQUEMENT (audit 2.19) : un
          // TTC amorti gonflerait la base de la TVA — pas de repli TTC.
          const htCents =
            extraction && extraction.totalExclTax !== null
              ? Math.round(extraction.totalExclTax * 100)
              : null;
          if (
            extraction &&
            extraction.docType === "facture_fournisseur" &&
            htCents !== null &&
            htCents >= CAPITALIZATION_THRESHOLD_CENTS
          ) {
            await withTenant(request.tenantId, (tx) =>
              tx.pendingAction.create({
                data: {
                  tenantId: request.tenantId,
                  type: "create_fixed_asset",
                  requestedBy: request.authSession.user.id,
                  employee: "compta",
                  payload: {
                    label: extraction.supplierName
                      ? `Équipement ${extraction.supplierName}`
                      : "Équipement (facture photographiée)",
                    category: "materiel",
                    inServiceDate: extraction.docDate ?? new Date().toISOString().slice(0, 10),
                    baseCents: htCents,
                    durationMonths: ASSET_CATEGORIES.materiel.defaultMonths,
                    method: "LINEAIRE",
                    source: "DOCUMENT",
                    sourceRef: `classeur:${document.id}`,
                    priorDepreciationCents: 0,
                    warnings: ["catégorie et durée proposées — à ajuster avant validation"],
                  },
                },
              }),
            ).catch((error: unknown) =>
              request.log.warn(
                { err: error instanceof Error ? error.name : "Error" },
                "classeur asset suggestion failed",
              ),
            );
          }
          // Doorbell 2.17 : le document traité notifie SON auteur (compteur
          // seul — jamais le contenu), regroupé avec les autres actions.
          void recordPushEvent(request.tenantId, [request.authSession.user.id], "actions").catch(
            (error: unknown) => {
              request.log.warn(
                { err: error instanceof Error ? error.name : "Error" },
                "push record failed",
              );
            },
          );
          return reply.code(201).send({ alreadyImported: false, document });
        } catch (error) {
          request.log.error(
            { err: error instanceof Error ? error.name : "Error" },
            "classeur upload failed",
          );
          return reply.code(500).send({ error: "upload failed" });
        }
      },
    );
  });

  app.get(
    "/classeur/documents/:id/photo",
    { preHandler: businessRoute },
    async (request, reply) => {
      const { id } = z.object({ id: Uuid }).parse(request.params);
      const document = await withTenant(request.tenantId, (tx) =>
        tx.classeurDocument.findUnique({
          where: { id },
          select: { photo: true, mimeType: true },
        }),
      );
      if (!document) return reply.code(404).send({ error: "not found" });
      return reply
        .header("content-type", document.mimeType)
        .header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff")
        .header("content-disposition", "inline")
        .send(Buffer.from(document.photo));
    },
  );

  // Correction des champs extraits (apprentissage V1) : l'extraction d'origine
  // est FIGÉE, chaque correction est journalisée en append-only — c'est le
  // futur jeu d'apprentissage. Statut => "verifie".
  const CorrectionBody = z
    .object({
      docType: z.enum(DOC_TYPES).optional(),
      supplierName: z.string().max(300).nullable().optional(),
      pieceNumber: z.string().max(120).nullable().optional(),
      docDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .optional(),
      currency: z.string().max(10).nullable().optional(),
      totalExclTax: z.number().finite().nullable().optional(),
      totalTax: z.number().finite().nullable().optional(),
      totalInclTax: z.number().finite().nullable().optional(),
    })
    .strict();

  app.patch("/classeur/documents/:id", { preHandler: businessRoute }, async (request, reply) => {
    const { id } = z.object({ id: Uuid }).parse(request.params);
    const parsed = CorrectionBody.safeParse(request.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      return reply.code(400).send({ error: "invalid correction" });
    }
    const fields = parsed.data;

    let updated: unknown;
    try {
      updated = await withTenant(request.tenantId, async (tx) => {
        const document = await tx.classeurDocument.findUnique({
          where: { id },
          select: {
            extraction: true,
            corrections: true,
            docType: true,
            status: true,
            learned: true,
          },
        });
        if (!document) return null;
        // Append-only FAIL-CLOSED : un historique corrompu (pas un tableau)
        // ne doit JAMAIS être remplacé silencieusement — on refuse d'écrire.
        if (!Array.isArray(document.corrections)) {
          throw new Error("corrections history is not an array");
        }
        if (document.corrections.length >= 200) return "cap" as const;
        const extraction = {
          ...(typeof document.extraction === "object" && document.extraction !== null
            ? document.extraction
            : {}),
          ...fields,
        };
        const corrections = [
          ...document.corrections,
          { by: request.authSession.user.id, at: new Date().toISOString(), fields },
        ] as Prisma.InputJsonValue;
        // L'humain a tranché : la suggestion de la mémoire sur CE champ n'a
        // plus à s'afficher (« à trancher » resterait au présent pour
        // toujours). Les autres traces d'explicabilité restent.
        const remainingLearned = Array.isArray(document.learned)
          ? document.learned.filter(
              (entry) =>
                typeof entry !== "object" ||
                entry === null ||
                !(((entry as { field?: unknown }).field as string) in fields),
            )
          : document.learned;
        return tx.classeurDocument.update({
          where: { id },
          data: {
            extraction,
            corrections,
            learned: (remainingLearned ?? Prisma.DbNull) as Prisma.InputJsonValue,
            docType: fields.docType ?? document.docType,
            // Un document rapproché RESTE rapproché : corriger un champ ne
            // défait pas silencieusement le rapprochement fait par l'owner.
            status: document.status === "rapproche" ? "rapproche" : "verifie",
          },
          select: DOC_SELECT,
        });
      });
    } catch (error) {
      // Une erreur Prisma peut citer ses arguments (champs du justificatif) :
      // nom d'erreur uniquement, jamais l'objet complet.
      request.log.error(
        { err: error instanceof Error ? error.name : "Error" },
        "classeur correction failed",
      );
      return reply.code(500).send({ error: "correction failed" });
    }
    if (updated === null) return reply.code(404).send({ error: "not found" });
    if (updated === "cap") {
      return reply.code(409).send({ error: "trop de corrections sur ce document" });
    }
    return { document: updated };
  });

  // Rapprochement bancaire — owner only (labels/montants de transactions).
  app.get(
    "/classeur/documents/:id/candidates",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const { id } = z.object({ id: Uuid }).parse(request.params);
      const document = await withTenant(request.tenantId, (tx) =>
        tx.classeurDocument.findUnique({ where: { id }, select: { extraction: true } }),
      );
      if (!document) return reply.code(404).send({ error: "not found" });
      const extraction = z
        .object({
          totalInclTax: z.number().nullable().catch(null),
          docDate: z.string().nullable().catch(null),
        })
        .catch({ totalInclTax: null, docDate: null })
        .parse(document.extraction ?? {});

      // Banque agnostique (2.15) : Qonto direct, sinon agrégateur Bridge.
      let bank: BankClient;
      try {
        bank = await getBankClient(request.tenantId);
      } catch (error) {
        if (error instanceof ConnectorNotConfiguredError) {
          return { candidates: [], reason: "no-bank" };
        }
        throw error;
      }
      const { transactions } = await bank.listTransactions({ perPage: 100 });
      return {
        candidates: matchTransactions(
          extraction,
          transactions.map((tx) => ({
            transaction_id: tx.transaction_id ?? null,
            id: tx.id ?? null,
            amount_cents: tx.amount_cents ?? null,
            side: tx.side ?? null,
            settled_at: tx.settled_at ?? null,
            label: tx.label ?? null,
          })),
        ),
      };
    },
  );

  const MatchBody = z.object({ transactionId: z.string().min(1).max(200).nullable() }).strict();

  app.post(
    "/classeur/documents/:id/match",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const { id } = z.object({ id: Uuid }).parse(request.params);
      const parsed = MatchBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid match" });
      const { transactionId } = parsed.data;

      let updated: unknown;
      try {
        updated = await withTenant(request.tenantId, async (tx) => {
          const exists = await tx.classeurDocument.findUnique({
            where: { id },
            select: { id: true },
          });
          if (!exists) return null;
          return tx.classeurDocument.update({
            where: { id },
            data: transactionId
              ? { matchedTransactionId: transactionId, matchedAt: new Date(), status: "rapproche" }
              : { matchedTransactionId: null, matchedAt: null, status: "verifie" },
            select: DOC_SELECT,
          });
        });
      } catch (error) {
        request.log.error(
          { err: error instanceof Error ? error.name : "Error" },
          "classeur match failed",
        );
        return reply.code(500).send({ error: "match failed" });
      }
      if (!updated) return reply.code(404).send({ error: "not found" });
      return { document: updated };
    },
  );

  // Droit à l'effacement (art. 17) — owner only, photo comprise.
  app.delete(
    "/classeur/documents/:id",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const { id } = z.object({ id: Uuid }).parse(request.params);
      const outcome = await withTenant(request.tenantId, async (tx) => {
        // Existence d'abord : un 404 ne doit pas laisser derrière lui des
        // propositions rejetées pour une pièce qui n'existait pas.
        const document = await tx.classeurDocument.findUnique({
          where: { id },
          select: { id: true },
        });
        if (document === null) return null;
        // Effacer la pièce (art. 17) doit RÉVOQUER son imputation : sinon la
        // fiche d'affaire continue d'afficher « Document du classeur — 450 € »
        // pour une pièce disparue, donc un coût que plus personne ne peut
        // vérifier. La ligne d'imputation reste, révoquée : c'est la trace.
        await tx.affaireImputation.updateMany({
          where: { targetType: "classeur_document", targetId: id, revokedAt: null },
          data: { revokedAt: new Date(), revokedBy: request.authSession.user.id },
        });
        // Même écart que la purge FEC : au-delà du seuil de capitalisation, la
        // pièce a fait naître une proposition d'immobilisation dont le libellé
        // porte un nom de FOURNISSEUR. Effacer la photo en la laissant, c'est
        // un effacement partiel qui se croit complet.
        // Compteurs VOLONTAIREMENT ignorés ici, à la différence de la purge
        // FEC : une pièce fait naître AU PLUS une proposition, et l'écran de
        // validation se rafraîchit tout seul (`document.modifie` périme
        // `validation` et `nav`). Casser le 204 de cette route pour annoncer
        // « 1 » serait du bruit contractuel. La purge FEC, elle, peut en
        // rejeter deux cents d'un coup : là, le silence serait une faute.
        await reduceDerivedProposals(tx, {
          label: "pièce effacée du classeur",
          sourceRefPrefix: `classeur:${id}`,
        });
        /*
         * Le transcript peut porter l'OCR de CETTE pièce — un nom de
         * fournisseur, un montant, un numéro de facture — déposé là par
         * l'outil qui l'a lue. Même raisonnement que pour la proposition
         * dérivée, poussé jusqu'au bout : effacer la photo en laissant sa
         * transcription est un effacement partiel qui se croit complet.
         */
        const transcripts = await purgeAgentTranscripts(tx, request.tenantId);
        await tx.classeurDocument.deleteMany({ where: { id, tenantId: request.tenantId } });
        return { conversationsEffacees: transcripts };
      });
      if (outcome === null) return reply.code(404).send({ error: "not found" });
      /*
       * 200 plutôt que 204, et c'est la revue qui a eu raison.
       *
       * C'est la plus BANALE des trois routes : corriger une photo prise de
       * travers n'est pas une demande d'effacement. Détruire au passage les
       * conversations de toute l'équipe sans un mot, douze fois de suite pour
       * douze pièces mal classées, c'est exactement le silence que le reste du
       * ticket refuse. Le compteur reste à zéro le plus souvent — auquel cas
       * la réponse ne dit rien de plus qu'avant.
       */
      return reply.send(outcome);
    },
  );

  /*
   * Suivi des stocks (ticket 3.2). Le stock n'est pas une donnée financière :
   * tout membre le consulte et l'ajuste (l'employé de terrain sort du matériel
   * du dépôt) ; le RÉFÉRENTIEL (création, seuils, suppression) est owner.
   * Chaque ajustement passe par un mouvement append-only — la quantité ne se
   * modifie jamais directement.
   */

  const STOCK_SELECT = {
    id: true,
    name: true,
    sku: true,
    unit: true,
    quantity: true,
    alertThreshold: true,
    updatedAt: true,
  } as const;

  type StockRow = { quantity: number; alertThreshold: number };
  const stockView = <T extends StockRow>(item: T) => ({
    ...item,
    belowThreshold: item.alertThreshold > 0 && item.quantity <= item.alertThreshold,
  });

  app.get("/stocks", { preHandler: businessRoute }, async (request) => {
    const rows = await withTenant(request.tenantId, (tx) =>
      tx.stockItem.findMany({
        orderBy: { name: "asc" },
        take: 501,
        select: { ...STOCK_SELECT, unitCostCents: true },
      }),
    );
    // Troncature SIGNALÉE, jamais silencieuse (une alerte au-delà de la page
    // ne doit pas disparaître sans trace).
    const hasMore = rows.length > 500;
    // Coûts et valorisation (3.3) = donnée financière : OWNER only — un
    // membre voit les quantités, jamais les coûts de remplacement.
    const isOwner = request.membershipRole === "owner";
    return {
      items: rows.slice(0, 500).map((row) => {
        const { unitCostCents, ...base } = row;
        const view = stockView(base);
        return isOwner
          ? { ...view, unitCostCents, valueCents: row.quantity * unitCostCents }
          : view;
      }),
      hasMore,
    };
  });

  const StockItemBody = z
    .object({
      name: z.string().min(1).max(200),
      sku: z.string().max(100).nullable().optional(),
      unit: z.string().min(1).max(50).optional(),
      alertThreshold: z.number().int().min(0).max(1_000_000).optional(),
      // Coût de remplacement (3.3) — routes owner-only. Borné à 100 k€/unité :
      // combiné au plafond de quantité, le produit reste loin de
      // Number.MAX_SAFE_INTEGER (pas de perte de précision silencieuse).
      unitCostCents: z.number().int().min(0).max(10_000_000).optional(),
    })
    .strict();

  app.post(
    "/stocks",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const parsed = StockItemBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid stock item" });
      const { name, sku, unit, alertThreshold, unitCostCents } = parsed.data;
      try {
        const item = await withTenant(request.tenantId, (tx) =>
          tx.stockItem.create({
            data: {
              tenantId: request.tenantId,
              name,
              ...(sku !== undefined ? { sku } : {}),
              ...(unit !== undefined ? { unit } : {}),
              ...(alertThreshold !== undefined ? { alertThreshold } : {}),
              ...(unitCostCents !== undefined ? { unitCostCents } : {}),
            },
            select: { ...STOCK_SELECT, unitCostCents: true },
          }),
        );
        // Route owner : le coût et la valorisation peuvent sortir.
        return reply
          .code(201)
          .send({ item: { ...stockView(item), valueCents: item.quantity * item.unitCostCents } });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return reply.code(409).send({ error: "an item with this name already exists" });
        }
        throw error;
      }
    },
  );

  app.patch(
    "/stocks/:id",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const { id } = z.object({ id: Uuid }).parse(request.params);
      const parsed = StockItemBody.partial().safeParse(request.body);
      if (!parsed.success || Object.keys(parsed.data).length === 0) {
        return reply.code(400).send({ error: "invalid stock item" });
      }
      const fields = parsed.data;
      const data: Prisma.StockItemUpdateInput = {};
      if (fields.name !== undefined) data.name = fields.name;
      if (fields.sku !== undefined) data.sku = fields.sku;
      if (fields.unit !== undefined) data.unit = fields.unit;
      if (fields.alertThreshold !== undefined) data.alertThreshold = fields.alertThreshold;
      if (fields.unitCostCents !== undefined) data.unitCostCents = fields.unitCostCents;
      try {
        const item = await withTenant(request.tenantId, async (tx) => {
          const exists = await tx.stockItem.findUnique({ where: { id }, select: { id: true } });
          if (!exists) return null;
          return tx.stockItem.update({
            where: { id },
            data,
            select: { ...STOCK_SELECT, unitCostCents: true },
          });
        });
        if (!item) return reply.code(404).send({ error: "not found" });
        // Route owner : le coût et la valorisation peuvent sortir.
        return { item: { ...stockView(item), valueCents: item.quantity * item.unitCostCents } };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return reply.code(409).send({ error: "an item with this name already exists" });
        }
        throw error;
      }
    },
  );

  app.delete(
    "/stocks/:id",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const { id } = z.object({ id: Uuid }).parse(request.params);
      const { count } = await withTenant(request.tenantId, (tx) =>
        tx.stockItem.deleteMany({ where: { id, tenantId: request.tenantId } }),
      );
      if (count === 0) return reply.code(404).send({ error: "not found" });
      return reply.code(204).send();
    },
  );

  const MovementBody = z
    .object({
      delta: z
        .number()
        .int()
        .min(-1_000_000)
        .max(1_000_000)
        .refine((value) => value !== 0, { message: "delta must not be zero" }),
      reason: z.string().max(200).optional(),
    })
    .strict();

  // Plafond de quantité : évite le débordement INTEGER par entrées répétées.
  const MAX_STOCK_QUANTITY = 1_000_000_000;

  app.post(
    "/stocks/:id/movements",
    // L'expert-comptable (tiers délégué) consulte mais ne sort pas de matériel.
    { preHandler: [...businessRoute, requireRole(["owner", "member"])] },
    async (request, reply) => {
      const { id } = z.object({ id: Uuid }).parse(request.params);
      const parsed = MovementBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid movement" });
      const { delta, reason } = parsed.data;

      const outcome = await withTenant(request.tenantId, async (tx) => {
        const exists = await tx.stockItem.findUnique({ where: { id }, select: { id: true } });
        if (!exists) return null;
        // ATOMIQUE : plancher (0) et plafond appliqués DANS le même update
        // conditionnel — deux sorties concurrentes ne franchissent jamais le
        // zéro (audit RGPD 3.2), aucun read-modify-write en mémoire.
        const { count } = await tx.stockItem.updateMany({
          where: {
            id,
            quantity: {
              gte: delta < 0 ? -delta : 0,
              lte: MAX_STOCK_QUANTITY - Math.max(0, delta),
            },
          },
          data: { quantity: { increment: delta } },
        });
        if (count === 0) return "conflict" as const;
        await tx.stockMovement.create({
          data: {
            tenantId: request.tenantId,
            itemId: id,
            delta,
            reason: reason ?? null,
            createdBy: request.authSession.user.id,
          },
        });
        return tx.stockItem.findUnique({ where: { id }, select: STOCK_SELECT });
      });
      if (outcome === null) return reply.code(404).send({ error: "not found" });
      if (outcome === "conflict") {
        return reply.code(409).send({ error: "insufficient stock" });
      }
      return { item: stockView(outcome!) };
    },
  );

  app.get("/stocks/:id/movements", { preHandler: businessRoute }, async (request, reply) => {
    const { id } = z.object({ id: Uuid }).parse(request.params);
    const movements = await withTenant(request.tenantId, async (tx) => {
      const exists = await tx.stockItem.findUnique({ where: { id }, select: { id: true } });
      if (!exists) return null;
      return tx.stockMovement.findMany({
        where: { itemId: id },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, delta: true, reason: true, createdAt: true },
      });
    });
    if (movements === null) return reply.code(404).send({ error: "not found" });
    return { movements };
  });

  const readModuleState = async (tenantId: string) => {
    const profile = await withTenant(tenantId, (tx) =>
      tx.tenantProfile.findFirst({
        select: { vertical: true, moduleOverrides: true },
      }),
    );
    const vertical = (VERTICALS as readonly string[]).includes(profile?.vertical ?? "")
      ? (profile?.vertical as (typeof VERTICALS)[number])
      : "autre";
    const overrides =
      profile?.moduleOverrides !== null &&
      typeof profile?.moduleOverrides === "object" &&
      !Array.isArray(profile?.moduleOverrides)
        ? (profile?.moduleOverrides as Record<string, unknown>)
        : {};
    return { vertical, overrides };
  };

  /**
   * Un module du catalogue 3.11 est-il actif pour ce tenant ?
   *
   * Le toolset de l'agent filtre déjà les outils d'un module éteint, donc les
   * KPI qui passent par lui dégradent tout seuls. Ce qui est calculé EN DIRECT
   * (SQL, service) n'a pas ce filet : sans cette garde, une alerte de stock
   * s'afficherait encore au cockpit d'un tenant qui a éteint le module.
   * Fail-open comme le reste du 3.11 : sans profil, on lit les défauts.
   */
  const isModuleActive = async (tenantId: string, moduleId: string): Promise<boolean> => {
    const { vertical, overrides } = await readModuleState(tenantId);
    return resolveModules(vertical, overrides).find((m) => m.id === moduleId)?.active ?? false;
  };

  /**
   * Cockpit v0 (ticket 1.7) — KPIs of the virtual employees' work. Counts are
   * metadata-only (visible to every member); the treasury forecast is the
   * tenant's aggregate financial picture, reserved to the OWNER (same
   * delegated-third-party reasoning as the pending-action detail, audit 1.5).
   */
  app.get("/cockpit/kpis", { preHandler: businessRoute }, async (request) => {
    // Opening the cockpit = the "alerts" push events are seen (2.17) —
    // awaited (même course que la file de validation).
    await markPushSeen(request.tenantId, request.authSession.user.id, "alerts").catch(
      () => undefined,
    );
    const byStatus = await withTenant(request.tenantId, (tx) =>
      tx.pendingAction.groupBy({ by: ["status"], _count: { _all: true } }),
    );
    const pendingActions: Record<string, number> = {};
    for (const row of byStatus) pendingActions[row.status] = row._count._all;
    /*
     * Conversations RÉCENTES, pas un cumul : la rétention (art. 5.1.e)
     * supprime les transcriptions dormantes, donc ce nombre redescend. Le
     * lire comme « conversations depuis toujours » en ferait un chiffre qui
     * baisse sans raison visible. Le NOM le dit — « aucun écran ne l'affiche
     * aujourd'hui » n'était pas une raison suffisante de ne pas le relibeller :
     * l'argument périme au premier écran qui l'affiche.
     */
    const conversationsRecentes = await withTenant(request.tenantId, (tx) =>
      tx.agentConversation.count(),
    );

    // Alertes stock (3.2) — métadonnée non financière, visible de tout membre.
    // Compté côté SQL (comparaison colonne à colonne, RLS scelle au tenant) :
    // jamais une troncature silencieuse du compteur.
    // Module éteint (3.11) => aucune alerte affichée : ce compteur est calculé
    // en SQL direct, il ne passe pas par le toolset qui filtre les outils.
    const stocksOn = await isModuleActive(request.tenantId, "stocks");
    const stockAlertRows = stocksOn
      ? await withTenant(
          request.tenantId,
          (tx) =>
            tx.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM stock_items
        WHERE alert_threshold > 0 AND quantity <= alert_threshold`,
        )
      : [];
    const stockAlerts = stockAlertRows[0]?.count ?? 0;

    // Treasury via the SAME tenant-bound toolset as the agent (read-only,
    // OWNER-only — enforced by the toolset's role gate AND skipped here).
    // Any failure (no Qonto connector, service down) yields null — the cockpit
    // degrades; only the error NAME reaches the logs, nothing reaches the client.
    let treasury: unknown = null;
    let sales: unknown = null;
    if (request.membershipRole === "owner") {
      let toolset: Awaited<ReturnType<typeof buildToolset>> | null = null;
      try {
        toolset = await buildToolset({
          ...agentContext,
          tenantId: request.tenantId,
          role: request.membershipRole,
        });
        // Chaque prévision dégrade indépendamment : pas de banque n'empêche
        // pas la prévision des ventes (factures), et réciproquement.
        try {
          treasury = JSON.parse(await toolset.execute("compute_treasury_forecast", {}));
        } catch (error) {
          request.log.warn(
            { err: error instanceof Error ? error.name : "Error" },
            "cockpit treasury unavailable",
          );
        }
        try {
          sales = JSON.parse(await toolset.execute("forecast_sales", {}));
        } catch (error) {
          request.log.warn(
            { err: error instanceof Error ? error.name : "Error" },
            "cockpit sales forecast unavailable",
          );
        }
      } catch (error) {
        request.log.warn(
          { err: error instanceof Error ? error.name : "Error" },
          "cockpit toolset unavailable",
        );
      } finally {
        await toolset?.close().catch(() => undefined);
      }
    }
    return { pendingActions, conversationsRecentes, stockAlerts, treasury, sales };
  });

  app.get("/notes", { preHandler: businessRoute }, async (request) => {
    return withTenant(request.tenantId, (tx) =>
      tx.note.findMany({ orderBy: { createdAt: "desc" } }),
    );
  });

  app.post("/notes", { preHandler: businessRoute }, async (request, reply) => {
    const parsed = CreateNoteInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid payload", details: parsed.error.flatten() });
    }
    const note = await withTenant(request.tenantId, (tx) =>
      tx.note.create({ data: { ...parsed.data, tenantId: request.tenantId } }),
    );
    return reply.code(201).send(note);
  });

  /*
   * Notifications push Web (2.17). Opt-in par appareil, préférences par type,
   * révocation — chaîne d'auth complète, subscription rattachée à l'user de
   * session. Les clés de subscription ENTRENT et ne ressortent jamais : les
   * réponses ne contiennent ni endpoint ni p256dh/auth (minimisation).
   * Sans clés VAPID au coffre, la feature dégrade en 503 « non configuré ».
   */
  const pushConfigured = (): boolean =>
    Boolean(process.env.PUSH_VAPID_PUBLIC_KEY && process.env.PUSH_VAPID_PRIVATE_KEY);

  const PUSH_DEVICE_SELECT = {
    id: true,
    channel: true,
    userAgent: true,
    actionsEnabled: true,
    alertsEnabled: true,
    createdAt: true,
    lastUsedAt: true,
  } as const;

  app.get("/push/config", { preHandler: businessRoute }, async () => ({
    configured: pushConfigured(),
    vapidPublicKey: process.env.PUSH_VAPID_PUBLIC_KEY ?? null,
  }));

  const PushSubscriptionBody = z
    .object({
      // Anti-SSRF (audit 2.17) : le serveur émettra des requêtes vers cette
      // URL — https + services push des navigateurs UNIQUEMENT.
      endpoint: z.string().url().max(1_000).refine(isAllowedPushEndpoint, {
        message: "endpoint must be a browser push service",
      }),
      keys: z
        .object({ p256dh: z.string().min(1).max(300), auth: z.string().min(1).max(200) })
        .strict(),
      userAgent: z.string().max(200).optional(),
      // WEBPUSH par défaut ; FCM/APNS réservés aux apps stores (T.11) —
      // refusés tant qu'aucun sender n'existe pour eux.
      channel: PushChannelSchema.optional(),
      actionsEnabled: z.boolean().optional(),
      alertsEnabled: z.boolean().optional(),
    })
    .strict()
    .refine((body) => (body.channel ?? "WEBPUSH") === "WEBPUSH", {
      message: "channel not available yet",
    });

  app.post("/push/subscriptions", { preHandler: businessRoute }, async (request, reply) => {
    if (!pushConfigured()) {
      return reply.code(503).send({ error: "notifications push non configurées" });
    }
    const parsed = PushSubscriptionBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid payload" });
    }
    const { endpoint, keys, userAgent, channel, actionsEnabled, alertsEnabled } = parsed.data;
    const userId = request.authSession.user.id;
    try {
      const subscription = await withTenant(request.tenantId, async (tx) => {
        // Plafond anti-amplification : chaque appareil = des envois réseau
        // du serveur à chaque sweep.
        const deviceCount = await tx.pushSubscription.count({ where: { userId } });
        if (deviceCount >= MAX_PUSH_DEVICES_PER_USER) {
          throw Object.assign(new Error("device limit"), { statusCode: 429 });
        }
        const existing = await tx.pushSubscription.findFirst({ where: { endpoint } });
        if (existing) {
          // Même appareil re-souscrit (clés régénérées par le navigateur) :
          // il doit appartenir au même utilisateur — un endpoint = un
          // propriétaire, jamais de transfert silencieux.
          if (existing.userId !== userId) return null;
          return tx.pushSubscription.update({
            where: { id: existing.id },
            data: {
              p256dh: keys.p256dh,
              auth: keys.auth,
              // Persisté EXPLICITEMENT (audit) : le refine reste la garde
              // d'acceptation, la colonne dit toujours la vérité du canal.
              channel: channel ?? "WEBPUSH",
              ...(userAgent !== undefined ? { userAgent } : {}),
              ...(actionsEnabled !== undefined ? { actionsEnabled } : {}),
              ...(alertsEnabled !== undefined ? { alertsEnabled } : {}),
            },
            select: PUSH_DEVICE_SELECT,
          });
        }
        return tx.pushSubscription.create({
          data: {
            tenantId: request.tenantId,
            userId,
            endpoint,
            p256dh: keys.p256dh,
            auth: keys.auth,
            channel: channel ?? "WEBPUSH",
            userAgent: userAgent ?? null,
            ...(actionsEnabled !== undefined ? { actionsEnabled } : {}),
            ...(alertsEnabled !== undefined ? { alertsEnabled } : {}),
          },
          select: PUSH_DEVICE_SELECT,
        });
      });
      if (!subscription) {
        // Message UNIQUE pour tous les conflits (audit 2.17) : ne confirme
        // jamais où ni par qui l'endpoint est déjà enregistré.
        return reply.code(409).send({ error: "appareil déjà enregistré" });
      }
      return reply.code(201).send(subscription);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.code(409).send({ error: "appareil déjà enregistré" });
      }
      if (error instanceof Error && "statusCode" in error && error.statusCode === 429) {
        return reply.code(429).send({ error: "limite d'appareils atteinte pour ce compte" });
      }
      throw error;
    }
  });

  // SES appareils uniquement : la liste est par utilisateur, pas par tenant.
  app.get("/push/subscriptions", { preHandler: businessRoute }, async (request) => {
    return withTenant(request.tenantId, (tx) =>
      tx.pushSubscription.findMany({
        where: { userId: request.authSession.user.id },
        orderBy: { createdAt: "desc" },
        select: PUSH_DEVICE_SELECT,
      }),
    );
  });

  const PushPrefsBody = z
    .object({ actionsEnabled: z.boolean().optional(), alertsEnabled: z.boolean().optional() })
    .strict()
    .refine((body) => body.actionsEnabled !== undefined || body.alertsEnabled !== undefined, {
      message: "at least one preference required",
    });

  app.patch("/push/subscriptions/:id", { preHandler: businessRoute }, async (request, reply) => {
    const params = z.object({ id: Uuid }).safeParse(request.params);
    const parsed = PushPrefsBody.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({ error: "invalid payload" });
    }
    const updated = await withTenant(request.tenantId, (tx) =>
      tx.pushSubscription.updateMany({
        // Scopé à l'utilisateur de session : on ne règle jamais l'appareil
        // d'un collègue, même owner.
        where: { id: params.data.id, userId: request.authSession.user.id },
        data: {
          ...(parsed.data.actionsEnabled !== undefined
            ? { actionsEnabled: parsed.data.actionsEnabled }
            : {}),
          ...(parsed.data.alertsEnabled !== undefined
            ? { alertsEnabled: parsed.data.alertsEnabled }
            : {}),
        },
      }),
    );
    if (updated.count === 0) return reply.code(404).send({ error: "unknown device" });
    return { updated: true };
  });

  app.delete("/push/subscriptions/:id", { preHandler: businessRoute }, async (request, reply) => {
    const params = z.object({ id: Uuid }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid payload" });
    const deleted = await withTenant(request.tenantId, (tx) =>
      tx.pushSubscription.deleteMany({
        where: { id: params.data.id, userId: request.authSession.user.id },
      }),
    );
    if (deleted.count === 0) return reply.code(404).send({ error: "unknown device" });
    return { revoked: true };
  });

  // Marquage explicite « j'ai vu » (le web l'appelle à l'ouverture de la file
  // de validation) — GET /pending-actions et /cockpit/kpis le font déjà.
  app.post("/push/seen", { preHandler: businessRoute }, async (request, reply) => {
    const parsed = z.object({ category: PushCategorySchema }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid payload" });
    await markPushSeen(request.tenantId, request.authSession.user.id, parsed.data.category);
    return { seen: true };
  });

  /*
   * ── Back-office support (2.18) ─────────────────────────────────────────────
   * Rôle plateforme OPERATOR = allowlist d'e-mails au coffre
   * (OPS_OPERATOR_EMAILS) — hors rôles tenant. Les tables ops (schéma `ops`)
   * ne sont accessibles QUE par ces routes ; un non-opérateur reçoit 404
   * (l'existence même du back-office n'est pas confirmée).
   * RÈGLE : rien ne part vers un client sans validation ici (envoi TEM), et
   * le corps d'un e-mail ne quitte l'Object Storage que vers l'opérateur.
   */
  const supportStorage =
    options.supportStorage !== undefined ? options.supportStorage : createSupportStorage();
  const supportMailer =
    options.supportMailer !== undefined ? options.supportMailer : createTemMailer();

  // Allowlist par USER ID (audit 2.18, bloquant) : une allowlist d'e-mails
  // serait revendicable par un simple sign-up sur une adresse non encore
  // enregistrée — les ids sont générés serveur, non forgeables.
  const operatorUserIds = (): string[] =>
    (process.env.OPS_OPERATOR_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

  async function requireOperator(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!operatorUserIds().includes(request.authSession.user.id)) {
      await reply.code(404).send({ error: "not found" });
    }
  }
  const operatorRoute = [requireAuth, requireOperator];

  const TICKET_SELECT = {
    id: true,
    fromEmail: true,
    subject: true,
    tenantId: true,
    origin: true,
    level: true,
    status: true,
    authSignal: true,
    inReplyTo: true,
    repliedAt: true,
    createdAt: true,
    updatedAt: true,
  } as const;

  app.get("/ops/support/tickets", { preHandler: operatorRoute }, async (request, reply) => {
    const query = z
      .object({
        status: z.string().max(30).optional(),
        level: z.string().max(5).optional(),
        origin: z.string().max(30).optional(),
      })
      .safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "invalid query" });
    return withOps((tx) =>
      tx.supportTicket.findMany({
        where: {
          ...(query.data.status ? { status: query.data.status } : {}),
          ...(query.data.level ? { level: query.data.level } : {}),
          ...(query.data.origin ? { origin: query.data.origin } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: TICKET_SELECT,
      }),
    );
  });

  app.get("/ops/support/tickets/:id", { preHandler: operatorRoute }, async (request, reply) => {
    const params = z.object({ id: Uuid }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id" });
    const ticket = await withOps((tx) =>
      tx.supportTicket.findUnique({
        where: { id: params.data.id },
        select: { ...TICKET_SELECT, draftReply: true, agentReport: true, objectKeys: true },
      }),
    );
    if (!ticket) return reply.code(404).send({ error: "unknown ticket" });
    return ticket;
  });

  // Corps original : lu depuis l'Object Storage, servi à l'OPÉRATEUR seul.
  app.get(
    "/ops/support/tickets/:id/body",
    { preHandler: operatorRoute },
    async (request, reply) => {
      const params = z.object({ id: Uuid }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "invalid id" });
      if (!supportStorage) return reply.code(503).send({ error: "stockage non configuré" });
      const ticket = await withOps((tx) =>
        tx.supportTicket.findUnique({
          where: { id: params.data.id },
          select: { objectKeys: true },
        }),
      );
      const keys = z
        .array(z.string())
        .catch([])
        .parse(ticket?.objectKeys ?? []);
      const bodyKey = keys.find((key) => key.endsWith("/body.txt"));
      if (!bodyKey) return reply.code(404).send({ error: "no body" });
      const object = await supportStorage.get(bodyKey);
      if (!object) return reply.code(404).send({ error: "no body" });
      reply.header("content-type", "text/plain; charset=utf-8");
      reply.header("x-content-type-options", "nosniff");
      return reply.send(Buffer.from(object.body));
    },
  );

  app.patch("/ops/support/tickets/:id", { preHandler: operatorRoute }, async (request, reply) => {
    const params = z.object({ id: Uuid }).safeParse(request.params);
    const body = z
      .object({ draftReply: z.string().min(1).max(20_000) })
      .strict()
      .safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid payload" });
    try {
      const updated = await withOps((tx) =>
        tx.supportTicket.updateMany({
          where: { id: params.data.id, status: { in: ["TRIE", "BROUILLON_PRET"] } },
          data: { draftReply: body.data.draftReply, status: "BROUILLON_PRET" },
        }),
      );
      if (updated.count === 0) return reply.code(404).send({ error: "unknown ticket" });
      return { updated: true };
    } catch (error) {
      // Jamais l'erreur brute : une PrismaValidationError sérialiserait le
      // brouillon (contenu) dans les logs du handler global.
      request.log.warn(
        { err: error instanceof Error ? error.name : "Error" },
        "support draft update failed",
      );
      return reply.code(500).send({ error: "update failed" });
    }
  });

  // LA validation 1 clic : seul chemin d'envoi vers un client (jamais d'envoi
  // automatique — auto_reply n'existe qu'en flag documenté, OFF).
  app.post(
    "/ops/support/tickets/:id/send",
    { preHandler: operatorRoute },
    async (request, reply) => {
      const params = z.object({ id: Uuid }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "invalid id" });
      if (!supportMailer) return reply.code(503).send({ error: "envoi non configuré (TEM)" });
      const ticket = await withOps((tx) =>
        tx.supportTicket.findUnique({ where: { id: params.data.id } }),
      );
      if (!ticket || !ticket.draftReply) return reply.code(404).send({ error: "no draft" });
      if (ticket.status !== "BROUILLON_PRET") {
        return reply.code(409).send({ error: "ticket not ready" });
      }
      await supportMailer.send({
        to: ticket.fromEmail,
        subject: ticket.subject.startsWith("Re:") ? ticket.subject : `Re: ${ticket.subject}`,
        text: ticket.draftReply,
        ...(ticket.inReplyTo ? { inReplyTo: ticket.inReplyTo } : {}),
      });
      await withOps((tx) =>
        tx.supportTicket.update({
          where: { id: ticket.id },
          data: { status: "REPONDU", repliedAt: new Date() },
        }),
      );
      return { sent: true };
    },
  );

  const ResolveBody = z
    .object({
      /** Incrémenter une entrée existante du recueil… */
      issueId: Uuid.optional(),
      /** …ou en proposer une nouvelle (anonymisée, garde vérifiée). */
      issue: z
        .object({
          title: z.string().min(1).max(200),
          symptoms: z.string().min(1).max(2_000),
          cause: z.string().max(2_000).default(""),
          resolution: z.string().max(2_000).default(""),
          origin: SupportOrigin,
        })
        .strict()
        .optional(),
    })
    .strict();

  app.post(
    "/ops/support/tickets/:id/resolve",
    { preHandler: operatorRoute },
    async (request, reply) => {
      const params = z.object({ id: Uuid }).safeParse(request.params);
      const body = ResolveBody.safeParse(request.body ?? {});
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: "invalid payload" });
      }
      const ticket = await withOps((tx) =>
        tx.supportTicket.findUnique({ where: { id: params.data.id } }),
      );
      if (!ticket) return reply.code(404).send({ error: "unknown ticket" });

      let issueId: string | null = null;
      if (body.data.issueId) {
        const knownIssueId = body.data.issueId;
        const updated = await withOps((tx) =>
          tx.supportIssue.updateMany({
            where: { id: knownIssueId },
            data: { occurrences: { increment: 1 } },
          }),
        );
        if (updated.count === 0) return reply.code(404).send({ error: "unknown issue" });
        issueId = body.data.issueId;
      } else if (body.data.issue) {
        // Garde d'anonymisation : le recueil sert TOUS les tenants — jamais
        // l'adresse de l'expéditeur, son domaine ou le nom du tenant dedans.
        const tenant = ticket.tenantId
          ? await prisma.tenant.findUnique({
              where: { id: ticket.tenantId },
              select: { name: true },
            })
          : null;
        const text = `${body.data.issue.title} ${body.data.issue.symptoms} ${body.data.issue.cause} ${body.data.issue.resolution}`;
        try {
          assertAnonymized(text, [
            ticket.fromEmail,
            ticket.fromEmail.split("@")[1] ?? "",
            tenant?.name ?? "",
          ]);
        } catch {
          return reply
            .code(400)
            .send({ error: "entrée non anonymisée (adresse, domaine ou tenant présent)" });
        }
        const issue = await withOps((tx) => tx.supportIssue.create({ data: body.data.issue! }));
        issueId = issue.id;
      }

      await withOps((tx) =>
        tx.supportTicket.update({ where: { id: ticket.id }, data: { status: "RESOLU" } }),
      );
      return { resolved: true, issueId };
    },
  );

  app.get("/ops/support/issues", { preHandler: operatorRoute }, async () => {
    return withOps((tx) => tx.supportIssue.findMany({ orderBy: { updatedAt: "desc" }, take: 200 }));
  });

  app.post(
    "/ops/support/issues/:id/validate",
    { preHandler: operatorRoute },
    async (request, reply) => {
      const params = z.object({ id: Uuid }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "invalid id" });
      const updated = await withOps((tx) =>
        tx.supportIssue.updateMany({ where: { id: params.data.id }, data: { validated: true } }),
      );
      if (updated.count === 0) return reply.code(404).send({ error: "unknown issue" });
      return { validated: true };
    },
  );

  app.get("/ops/support/stats", { preHandler: operatorRoute }, async () => {
    const [byStatus, byLevel, issues] = await withOps(
      async (tx) =>
        [
          await tx.supportTicket.groupBy({ by: ["status"], _count: { _all: true } }),
          await tx.supportTicket.groupBy({ by: ["level"], _count: { _all: true } }),
          await tx.supportIssue.count({ where: { validated: true } }),
        ] as const,
    );
    return {
      byStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count._all])),
      byLevel: Object.fromEntries(byLevel.map((row) => [row.level ?? "?", row._count._all])),
      validatedIssues: issues,
    };
  });

  /*
   * ── Immobilisations (2.19) ────────────────────────────────────────────────
   * Registre à visée trésorerie/décision : on CALCULE, on n'écrit JAMAIS
   * dans la comptabilité. OWNER-ONLY (patrimoine + valeurs financières).
   * L'impact IS est une ESTIMATION labellisée ; le mur de renouvellement est
   * un SCÉNARIO ; une dotation n'entre jamais comme décaissement.
   */
  const registryAsset = (row: {
    id: string;
    label: string;
    baseCents: bigint;
    inServiceDate: Date;
    durationMonths: number;
    method: string;
    status: string;
    renewalCostCents: bigint | null;
  }): RegistryAsset => ({
    id: row.id,
    label: row.label,
    baseCents: Number(row.baseCents),
    inServiceDate: row.inServiceDate,
    durationMonths: row.durationMonths,
    method: row.method === "DEGRESSIF" ? "DEGRESSIF" : "LINEAIRE",
    renewalCostCents: row.renewalCostCents === null ? null : Number(row.renewalCostCents),
    status: row.status,
  });

  const ownerRoute = [...businessRoute, requireRole(["owner"])];

  app.get("/immobilisations", { preHandler: ownerRoute }, async (request) => {
    const rows = await withTenant(request.tenantId, (tx) =>
      tx.fixedAsset.findMany({
        orderBy: [{ status: "asc" }, { inServiceDate: "asc" }],
        take: 500,
      }),
    );
    const now = new Date();
    const year = now.getUTCFullYear();
    const assets = rows.map((row) => {
      const model = registryAsset(row);
      const plan = buildDepreciationPlan(model);
      // Reprise FEC 28x consommée (audit 2.19) : le cumul affiché est AU
      // MOINS celui des livres — la VNC recalculée ne contredit jamais un
      // amortissement déjà constaté par le comptable.
      const recomputed = plan.lines.filter((l) => l.year <= year).at(-1)?.cumulativeCents ?? 0;
      const cumulative = Math.min(
        model.baseCents,
        Math.max(recomputed, Number(row.priorDepreciationCents)),
      );
      const bookValue = model.baseCents - cumulative;
      return {
        id: row.id,
        label: row.label,
        category: row.category,
        inServiceDate: row.inServiceDate.toISOString().slice(0, 10),
        baseCents: Number(row.baseCents),
        durationMonths: row.durationMonths,
        method: row.method,
        source: row.source,
        status: row.status,
        renewalCostCents: row.renewalCostCents === null ? null : Number(row.renewalCostCents),
        bookValueCents: bookValue,
        wearRatio: model.baseCents > 0 ? cumulative / model.baseCents : 0,
        planEndYear: plan.lines.at(-1)?.year ?? null,
      };
    });
    const active = rows.filter((r) => r.status === "ACTIF").map(registryAsset);
    return {
      assets,
      totalBookValueCents: assets
        .filter((a) => a.status === "ACTIF")
        .reduce((sum, a) => sum + a.bookValueCents, 0),
      renewalWall: renewalWall(active, now, 24),
      isImpact: estimateIsImpact(active, now),
    };
  });

  app.get("/immobilisations/:id/plan", { preHandler: ownerRoute }, async (request, reply) => {
    const params = z.object({ id: Uuid }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id" });
    const row = await withTenant(request.tenantId, (tx) =>
      tx.fixedAsset.findUnique({ where: { id: params.data.id } }),
    );
    if (!row) return reply.code(404).send({ error: "unknown asset" });
    return { plan: buildDepreciationPlan(registryAsset(row)).lines };
  });

  const FixedAssetBody = z
    .object({
      label: z.string().min(1).max(200),
      category: z.enum([
        "informatique",
        "logiciel",
        "vehicule",
        "materiel",
        "mobilier",
        "agencement",
      ]),
      inServiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      baseCents: z.number().int().min(1).max(10_000_000_000),
      durationMonths: z.number().int().min(1).max(600),
      method: z.enum(["LINEAIRE", "DEGRESSIF"]).default("LINEAIRE"),
    })
    .strict()
    // CGI 39 A : dégressif réservé aux catégories éligibles (config sourcée).
    .refine(
      (data) => data.method !== "DEGRESSIF" || ASSET_CATEGORIES[data.category].decliningAllowed,
      { message: "dégressif non admis pour cette catégorie" },
    );

  // Saisie MANUELLE : c'est déjà la décision humaine — création directe owner.
  app.post("/immobilisations", { preHandler: ownerRoute }, async (request, reply) => {
    const parsed = FixedAssetBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid payload" });
    const asset = await withTenant(request.tenantId, (tx) =>
      tx.fixedAsset.create({
        data: {
          tenantId: request.tenantId,
          label: parsed.data.label,
          category: parsed.data.category,
          inServiceDate: new Date(`${parsed.data.inServiceDate}T00:00:00Z`),
          baseCents: BigInt(parsed.data.baseCents),
          durationMonths: parsed.data.durationMonths,
          method: parsed.data.method,
          source: "MANUEL",
        },
        select: { id: true },
      }),
    );
    return reply.code(201).send({ id: asset.id });
  });

  const FixedAssetPatch = z
    .object({
      renewalCostCents: z.number().int().min(0).max(10_000_000_000).nullable().optional(),
      status: z.enum(["ACTIF", "CEDE", "SORTI"]).optional(),
      disposedAt: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .optional(),
    })
    .strict()
    .refine((b) => Object.keys(b).length > 0, { message: "empty patch" })
    // Une cession/sortie sans date fausserait le plan : date obligatoire.
    .refine(
      (b) => !(b.status === "CEDE" || b.status === "SORTI") || typeof b.disposedAt === "string",
      { message: "disposedAt required when disposing" },
    );

  app.patch("/immobilisations/:id", { preHandler: ownerRoute }, async (request, reply) => {
    const params = z.object({ id: Uuid }).safeParse(request.params);
    const body = FixedAssetPatch.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid payload" });
    const updated = await withTenant(request.tenantId, (tx) =>
      tx.fixedAsset.updateMany({
        where: { id: params.data.id },
        data: {
          ...(body.data.renewalCostCents !== undefined
            ? {
                renewalCostCents:
                  body.data.renewalCostCents === null ? null : BigInt(body.data.renewalCostCents),
              }
            : {}),
          ...(body.data.status !== undefined ? { status: body.data.status } : {}),
          ...(body.data.disposedAt !== undefined
            ? {
                disposedAt:
                  body.data.disposedAt === null
                    ? null
                    : new Date(`${body.data.disposedAt}T00:00:00Z`),
              }
            : {}),
        },
      }),
    );
    if (updated.count === 0) return reply.code(404).send({ error: "unknown asset" });
    return { updated: true };
  });

  /*
   * ── Plannings RH (3.5) ────────────────────────────────────────────────────
   * Données RH = PII (noms) + charge dérivée du CA : OWNER-ONLY de bout en
   * bout, comme le financier. Jamais un nom de salarié dans les logs.
   */
  const STAFF_SELECT = {
    id: true,
    name: true,
    role: true,
    weeklyHours: true,
    active: true,
  } as const;

  app.get("/rh", { preHandler: ownerRoute }, async (request) => {
    const [staff, absences] = await withTenant(request.tenantId, async (tx) => [
      await tx.staffMember.findMany({ orderBy: { name: "asc" }, take: 200, select: STAFF_SELECT }),
      await tx.staffAbsence.findMany({
        orderBy: { startDate: "desc" },
        take: 200,
        select: { id: true, staffId: true, type: true, startDate: true, endDate: true },
      }),
    ]);
    return { staff, absences };
  });

  const StaffBody = z
    .object({
      name: z.string().min(1).max(120),
      role: z.string().max(80).default(""),
      weeklyHours: z.number().int().min(0).max(80).default(35),
    })
    .strict();

  app.post("/rh/staff", { preHandler: ownerRoute }, async (request, reply) => {
    const parsed = StaffBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid payload" });
    try {
      const member = await withTenant(request.tenantId, (tx) =>
        tx.staffMember.create({
          data: { tenantId: request.tenantId, ...parsed.data },
          select: STAFF_SELECT,
        }),
      );
      return reply.code(201).send(member);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.code(409).send({ error: "salarié déjà enregistré" });
      }
      throw error;
    }
  });

  const StaffPatch = z
    .object({
      role: z.string().max(80).optional(),
      weeklyHours: z.number().int().min(0).max(80).optional(),
      active: z.boolean().optional(),
    })
    .strict()
    .refine((body) => Object.keys(body).length > 0, { message: "empty patch" });

  app.patch("/rh/staff/:id", { preHandler: ownerRoute }, async (request, reply) => {
    const params = z.object({ id: Uuid }).safeParse(request.params);
    const body = StaffPatch.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid payload" });
    const updated = await withTenant(request.tenantId, (tx) =>
      tx.staffMember.updateMany({
        where: { id: params.data.id },
        data: {
          ...(body.data.role !== undefined ? { role: body.data.role } : {}),
          ...(body.data.weeklyHours !== undefined ? { weeklyHours: body.data.weeklyHours } : {}),
          ...(body.data.active !== undefined ? { active: body.data.active } : {}),
        },
      }),
    );
    if (updated.count === 0) return reply.code(404).send({ error: "unknown staff member" });
    return { updated: true };
  });

  // Date STRICTEMENT calendaire (audit 3.5) : "2026-02-31" glisserait au
  // 3 mars et fausserait la capacité de deux mois — round-trip exigé.
  const IsoDay = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(
      (value) => {
        const date = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
      },
      { message: "invalid calendar date" },
    );

  const AbsenceBody = z
    .object({
      staffId: Uuid,
      type: z.enum(["conges", "maladie", "formation", "autre"]).default("conges"),
      startDate: IsoDay,
      endDate: IsoDay,
    })
    .strict()
    .refine((body) => body.endDate >= body.startDate, { message: "endDate before startDate" })
    // Amplitude bornée : une absence > 1 an est une erreur de saisie.
    .refine((body) => Date.parse(body.endDate) - Date.parse(body.startDate) <= 366 * 86_400_000, {
      message: "absence longer than a year",
    });

  app.post("/rh/absences", { preHandler: ownerRoute }, async (request, reply) => {
    const parsed = AbsenceBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid payload" });
    const created = await withTenant(request.tenantId, async (tx) => {
      const member = await tx.staffMember.findUnique({
        where: { id: parsed.data.staffId },
        select: { id: true },
      });
      if (!member) return null;
      return tx.staffAbsence.create({
        data: {
          tenantId: request.tenantId,
          staffId: parsed.data.staffId,
          type: parsed.data.type,
          startDate: new Date(`${parsed.data.startDate}T00:00:00Z`),
          endDate: new Date(`${parsed.data.endDate}T00:00:00Z`),
        },
        select: { id: true },
      });
    });
    if (!created) return reply.code(404).send({ error: "unknown staff member" });
    return reply.code(201).send(created);
  });

  app.delete("/rh/absences/:id", { preHandler: ownerRoute }, async (request, reply) => {
    const params = z.object({ id: Uuid }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid payload" });
    const deleted = await withTenant(request.tenantId, (tx) =>
      tx.staffAbsence.deleteMany({ where: { id: params.data.id } }),
    );
    if (deleted.count === 0) return reply.code(404).send({ error: "unknown absence" });
    return { deleted: true };
  });

  // Une route adossée à un outil d'un module DÉSACTIVÉ (3.11) répond un
  // motif explicite — jamais un 503 opaque (l'outil sort du toolset, donc
  // « unknown tool » côté exécution).
  const isUnknownTool = (error: unknown): boolean =>
    error instanceof Error && /unknown tool/i.test(error.message);

  // Plan capacité vs charge : MÊME chemin que l'agent (outil owner-gated du
  // toolset lié au tenant) — une seule implémentation, deux consommateurs.
  app.get("/rh/plan", { preHandler: ownerRoute }, async (request, reply) => {
    const query = z
      .object({ hourlyRateEur: z.coerce.number().min(10).max(500).optional() })
      .safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "invalid query" });
    let toolset: Awaited<ReturnType<typeof buildToolset>> | null = null;
    try {
      toolset = await buildToolset({
        ...agentContext,
        tenantId: request.tenantId,
        role: request.membershipRole,
      });
      const result = await toolset.execute("plan_staffing", {
        ...(query.data.hourlyRateEur !== undefined
          ? { hourlyRateEur: query.data.hourlyRateEur }
          : {}),
      });
      return JSON.parse(result) as unknown;
    } catch (error) {
      if (isUnknownTool(error)) {
        return reply.code(409).send({ error: "module désactivé" });
      }
      request.log.warn(
        { err: error instanceof Error ? error.name : "Error" },
        "staffing plan unavailable",
      );
      return reply.code(503).send({ error: "plan indisponible" });
    } finally {
      await toolset?.close().catch(() => undefined);
    }
  });

  // Performance horaire réalisée (3.6) : même chemin que l'agent (outil
  // owner-gated du toolset lié au tenant) — une seule implémentation.
  app.get("/rh/performance", { preHandler: ownerRoute }, async (request, reply) => {
    const query = z
      .object({
        targetRateEur: z.coerce.number().min(10).max(500).optional(),
        monthsBack: z.coerce.number().int().min(3).max(12).optional(),
      })
      .safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "invalid query" });
    let toolset: Awaited<ReturnType<typeof buildToolset>> | null = null;
    try {
      toolset = await buildToolset({
        ...agentContext,
        tenantId: request.tenantId,
        role: request.membershipRole,
      });
      const result = await toolset.execute("analyze_hourly_performance", {
        ...(query.data.targetRateEur !== undefined
          ? { targetRateEur: query.data.targetRateEur }
          : {}),
        ...(query.data.monthsBack !== undefined ? { monthsBack: query.data.monthsBack } : {}),
      });
      return JSON.parse(result) as unknown;
    } catch (error) {
      if (isUnknownTool(error)) {
        return reply.code(409).send({ error: "module désactivé" });
      }
      request.log.warn(
        { err: error instanceof Error ? error.name : "Error" },
        "hourly performance unavailable",
      );
      return reply.code(503).send({ error: "performance indisponible" });
    } finally {
      await toolset?.close().catch(() => undefined);
    }
  });

  // Rapport mensuel + anomalies (2.11) : owner-only — CA du mois, encours échu
  // et nom du meilleur client. Même chemin que l'agent (outil du toolset lié au
  // tenant) : une seule implémentation, donc un seul jeu de seuils.
  app.get("/rapports/mensuel", { preHandler: ownerRoute }, async (request, reply) => {
    void reply.header("cache-control", "private, no-store");
    const query = z
      .object({
        month: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
          .optional(),
      })
      .safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "invalid query" });
    let toolset: Awaited<ReturnType<typeof buildToolset>> | null = null;
    try {
      toolset = await buildToolset({
        ...agentContext,
        tenantId: request.tenantId,
        role: request.membershipRole,
      });
      const result = await toolset.execute("build_monthly_report", {
        ...(query.data.month !== undefined ? { month: query.data.month } : {}),
      });
      return JSON.parse(result) as unknown;
    } catch (error) {
      // `ownerRoute` a déjà garanti le rôle : un outil inconnu ici ne peut plus
      // venir du gate owner (fail-closed), seulement d'un outil retiré du
      // toolset. Le 409 dit donc bien ce qu'il dit.
      if (isUnknownTool(error)) {
        return reply.code(409).send({ error: "outil indisponible pour ce tenant" });
      }
      request.log.warn(
        { err: error instanceof Error ? error.name : "Error" },
        "monthly report unavailable",
      );
      return reply.code(503).send({ error: "rapport indisponible" });
    } finally {
      await toolset?.close().catch(() => undefined);
    }
  });

  // --- Marge (2.8) — owner-only : CA, charges (dont la masse salariale
  // agrégée) et marge. La donnée financière la plus sensible du produit.

  app.get("/marge", { preHandler: ownerRoute }, async (request, reply) => {
    void reply.header("cache-control", "private, no-store");
    const query = z
      .object({
        month: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
          .optional(),
      })
      .safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "invalid query" });
    let toolset: Awaited<ReturnType<typeof buildToolset>> | null = null;
    try {
      toolset = await buildToolset({
        ...agentContext,
        tenantId: request.tenantId,
        role: request.membershipRole,
      });
      const result = await toolset.execute("analyze_margin", {
        ...(query.data.month !== undefined ? { month: query.data.month } : {}),
      });
      return JSON.parse(result) as unknown;
    } catch (error) {
      if (isUnknownTool(error)) {
        return reply.code(409).send({ error: "outil indisponible pour ce tenant" });
      }
      request.log.warn(
        { err: error instanceof Error ? error.name : "Error" },
        "margin unavailable",
      );
      return reply.code(503).send({ error: "marge indisponible" });
    } finally {
      await toolset?.close().catch(() => undefined);
    }
  });

  const CostBody = z
    .object({
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
      category: z.enum(COST_CATEGORY_IDS as [string, ...string[]]),
      // Borne alignée sur le CHECK : au-delà c'est une faute de frappe, et le
      // montant écraserait la marge sans qu'on le voie.
      amountCents: z.number().int().min(-2_000_000_000).max(2_000_000_000),
    })
    .strict();

  // Saisie d'une charge par l'owner. Source `saisi` : elle ne peut donc jamais
  // être écrasée par un import FEC (l'unicité porte la source), ni l'écraser.
  app.put("/marge/charges", { preHandler: ownerRoute }, async (request, reply) => {
    // En-tête posé AVANT toute sortie : un 400 aussi porte une réponse.
    void reply.header("cache-control", "private, no-store");
    const parsed = CostBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid payload" });
    const { month, category, amountCents } = parsed.data;
    const saved = await withTenant(request.tenantId, (tx) =>
      tx.costEntry.upsert({
        where: {
          tenantId_month_category_source: {
            tenantId: request.tenantId,
            month,
            category,
            source: "saisi",
          },
        },
        update: { amountCents },
        create: { tenantId: request.tenantId, month, category, amountCents, source: "saisi" },
        select: { id: true },
      }),
    );
    return reply.code(200).send(saved);
  });

  app.get("/marge/charges", { preHandler: ownerRoute }, async (request, reply) => {
    void reply.header("cache-control", "private, no-store");
    const query = z
      .object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) })
      .safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "invalid query" });
    const costs = await withTenant(request.tenantId, (tx) =>
      tx.costEntry.findMany({
        where: { month: query.data.month },
        select: { id: true, category: true, amountCents: true, source: true },
        orderBy: { category: "asc" },
        take: 200,
      }),
    );
    return { costs };
  });

  // Suppression d'une saisie HUMAINE uniquement : une charge dérivée du FEC ne
  // se supprime pas à la main (elle reviendrait au prochain import, et son
  // absence rendrait la marge trop belle sans qu'on sache pourquoi).
  app.delete("/marge/charges/:id", { preHandler: ownerRoute }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid payload" });
    void reply.header("cache-control", "private, no-store");
    const { count } = await withTenant(request.tenantId, (tx) =>
      tx.costEntry.deleteMany({ where: { id: params.data.id, source: "saisi" } }),
    );
    if (count === 0) {
      const exists = await withTenant(request.tenantId, (tx) =>
        tx.costEntry.findUnique({ where: { id: params.data.id }, select: { source: true } }),
      );
      if (!exists) return reply.code(404).send({ error: "charge not found" });
      return reply.code(409).send({ error: "charge dérivée du FEC : réimportez le fichier" });
    }
    return { deleted: true };
  });

  // --- Veille réglementaire (3.7) — owner-only : profil stratégique -------
  // (vertical + effectif RH). Obligations = catalogue versionné sourcé,
  // information générale, jamais un conseil juridique.

  app.get("/reglementaire/profil", { preHandler: ownerRoute }, async (request, reply) => {
    // Profil stratégique (vertical, effectif) : même doctrine de cache que le
    // profil fiscal — l'audit 2.9 a relevé le trou des deux côtés.
    void reply.header("cache-control", "private, no-store");
    const { profile, activeStaff } = await withTenant(request.tenantId, async (tx) => ({
      profile: await tx.tenantProfile.findFirst({
        select: { vertical: true, headcountOverride: true, updatedAt: true },
      }),
      activeStaff: await tx.staffMember.count({ where: { active: true } }),
    }));
    return {
      vertical: profile?.vertical ?? "autre",
      headcountOverride: profile?.headcountOverride ?? null,
      derivedHeadcount: activeStaff > 0 ? activeStaff : null,
    };
  });

  const ProfileBody = z
    .object({
      vertical: z.enum(VERTICALS),
      headcountOverride: z.number().int().min(0).max(10_000).nullable().optional(),
    })
    .strict();

  app.put("/reglementaire/profil", { preHandler: ownerRoute }, async (request, reply) => {
    const parsed = ProfileBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid payload" });
    const saved = await withTenant(request.tenantId, (tx) =>
      tx.tenantProfile.upsert({
        where: { tenantId: request.tenantId },
        create: {
          tenantId: request.tenantId,
          vertical: parsed.data.vertical,
          headcountOverride: parsed.data.headcountOverride ?? null,
        },
        update: {
          vertical: parsed.data.vertical,
          ...(parsed.data.headcountOverride !== undefined
            ? { headcountOverride: parsed.data.headcountOverride }
            : {}),
        },
        select: { vertical: true, headcountOverride: true },
      }),
    );
    return saved;
  });

  // Obligations applicables : MÊME chemin que l'agent (outil owner-gated).
  app.get("/reglementaire", { preHandler: ownerRoute }, async (request, reply) => {
    let toolset: Awaited<ReturnType<typeof buildToolset>> | null = null;
    try {
      toolset = await buildToolset({
        ...agentContext,
        tenantId: request.tenantId,
        role: request.membershipRole,
      });
      const result = await toolset.execute("check_regulatory_watch", {});
      return JSON.parse(result) as unknown;
    } catch (error) {
      if (isUnknownTool(error)) {
        return reply.code(409).send({ error: "module désactivé" });
      }
      request.log.warn(
        { err: error instanceof Error ? error.name : "Error" },
        "regulatory watch unavailable",
      );
      return reply.code(503).send({ error: "veille indisponible" });
    } finally {
      await toolset?.close().catch(() => undefined);
    }
  });

  // --- Devis depuis un e-mail (2.7) ---------------------------------------
  // Le corps reçu est écrit par un INCONNU : il ne traverse jamais un log ni
  // une réponse, et le pipeline qui le lit n'a AUCUN OUTIL (doctrine 2.18).
  // La sortie est une proposition en file de validation — jamais un envoi,
  // jamais un prix.
  // Même borne que l'outil MCP : la défense en profondeur veut la limite des
  // deux côtés (convention du repo — cf. les payloads d'exécuteurs).
  const EMAIL_BODY_MAX = 8_000;

  app.post("/devis/depuis-email", { preHandler: businessRoute }, async (request, reply) => {
    const body = z
      .object({
        emailBody: z.string().min(10).max(EMAIL_BODY_MAX),
        // Une ADRESSE, pas du texte libre : ce champ est de la PII persistée.
        from: z.string().email().max(320).optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid payload" });

    // Même borne que le cockpit conversationnel : deux appels modèle par
    // requête (classifieur + extraction) sur 8 000 caractères, sur une route
    // pilotée depuis un écran. Sans plafond, une boucle consomme sans fin.
    if (!askLimiter.take(`${request.tenantId}:${request.authSession.user.id}`)) {
      return reply.code(429).send({ error: "trop de demandes — patientez une minute" });
    }

    let toolset: Awaited<ReturnType<typeof buildToolset>> | null = null;
    try {
      toolset = await buildToolset({
        ...agentContext,
        tenantId: request.tenantId,
        role: request.membershipRole,
        requestedBy: request.authSession.user.id,
        employee: "commercial",
        // Sonnette push (2.17) : une proposition préparée depuis la page
        // attendait un owner qui n'était jamais prévenu.
        onPendingAction: () => {
          void notifyPendingAction(request.tenantId).catch((error: unknown) => {
            request.log.warn(
              { err: error instanceof Error ? error.name : "Error" },
              "push record failed",
            );
          });
        },
      });
      const result = await toolset.execute("draft_quote_from_email", {
        emailBody: body.data.emailBody,
        ...(body.data.from ? { from: body.data.from } : {}),
      });
      void reply.header("cache-control", "private, no-store");
      return reply.code(202).send(JSON.parse(result) as unknown);
    } catch (error) {
      if (isUnknownTool(error)) return reply.code(409).send({ error: "module désactivé" });
      // NOM d'erreur seulement : le message pourrait citer l'e-mail reçu.
      request.log.warn(
        { err: error instanceof Error ? error.name : "Error" },
        "quote draft failed",
      );
      return reply.code(422).send({ error: "e-mail non exploitable en devis" });
    } finally {
      await toolset?.close().catch(() => undefined);
    }
  });

  /*
   * Devis DICTÉ — « il dicte, il photographie, il valide ». Le premier verbe
   * de la promesse produit, et le dernier à être livré.
   *
   * Corps BRUT (`application/octet-stream`), comme la photo du classeur, et
   * `onRequest` plutôt que `preHandler` : l'authentification est vérifiée
   * AVANT que Fastify ne bufferise, sinon un anonyme coûte 25 Mo d'allocation.
   *
   * L'AUDIO N'EST PAS STOCKÉ. Il est transcrit puis relâché. Le produit n'en a
   * plus besoin après extraction, et une voix est une donnée personnelle d'un
   * autre ordre que le texte qu'elle porte. Ce qui est conservé, c'est la
   * TRANSCRIPTION, dans la proposition — et c'est elle qui rend la relecture
   * possible : sans l'audio, c'est le seul moyen pour le dirigeant de vérifier
   * que « 2,5 » n'est pas devenu « 25 » (le risque nommé par le spike F1).
   */
  // Parser binaire CANTONNÉ à cette route (plugin encapsulé), comme le
  // classeur et l'import FEC : le reste de l'API n'accepte pas d'octet-stream.
  void app.register(async (dictee) => {
    dictee.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );

    dictee.post(
      "/devis/dictee",
      { onRequest: businessRoute, bodyLimit: TRANSCRIPTION_MAX_BYTES },
      async (request, reply) => {
        const body = request.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          return reply.code(400).send({ error: "audio attendu (corps application/octet-stream)" });
        }

        /*
         * Le quota est consommé AVANT le sniff, et c'est délibéré.
         *
         * Le placer après laissait un boucleur authentifié enchaîner des corps
         * de 25 Mo au mauvais nombre magique : refusés en 415, mais jamais
         * comptés — la borne coûteuse en aval de la borne gratuite. Un envoi
         * reste un envoi, même mal formé.
         *
         * Même plafond que le cockpit conversationnel : deux appels modèle par
         * requête (transcription + extraction), sur une route pilotée depuis
         * un écran. La transcription est facturée à la SECONDE d'audio.
         */
        if (!askLimiter.take(`${request.tenantId}:${request.authSession.user.id}`)) {
          return reply.code(429).send({ error: "trop de demandes — patientez une minute" });
        }

        // Format reconnu par ses OCTETS, jamais par ce que le client déclare :
        // envoyer une image à un moteur de transcription coûterait un appel
        // facturé pour rien. Refus AVANT toute sortie réseau.
        const format = sniffAudioFormat(body);
        if (format === null) {
          return reply.code(415).send({
            error: "format audio non reconnu (WAV, MP3, OGG, FLAC, WebM ou MP4)",
          });
        }

        let transcript: string;
        try {
          const result = await transcribe({
            audio: new Uint8Array(body),
            // Nom NEUTRE : surtout pas « devis-mme-martin.wav ». Il part chez le
            // fournisseur, et un nom de fichier est une donnée comme une autre.
            fileName: `dictee.${format.id}`,
            language: "fr",
            tenantId: request.tenantId,
            requestId: `dictee-${randomUUID()}`,
          });
          transcript = result.text.trim();
        } catch (error) {
          // NOM d'erreur seulement : le message pourrait citer l'audio ou son
          // contenu. Et le refus est MOTIVÉ côté client, jamais un 500 muet.
          request.log.warn(
            { err: error instanceof Error ? error.name : "Error", format: format.id },
            "dictation transcription failed",
          );
          return reply.code(502).send({
            error: format.providerConfirmed
              ? "transcription indisponible — réessayez dans un instant"
              : // Ce format n'est pas garanti par le fournisseur (voir
                // `audioFormat.ts`) : le dire vaut mieux que laisser croire à une
                // panne passagère, parce que le remède n'est pas le même.
                `transcription indisponible pour le format ${format.id}, non garanti par le fournisseur — réessayez depuis un autre navigateur`,
          });
        }

        if (transcript.length < 10) {
          // Une dictée vide ou inaudible n'est pas une erreur technique : c'est
          // un résultat, et il se dit. Enchaîner sur l'extraction produirait une
          // proposition vide que personne ne saurait interpréter.
          return reply
            .code(422)
            .send({ error: "rien d'exploitable n'a été entendu — reprenez l'enregistrement" });
        }

        /*
         * Borne AVANT l'outil, et non par la validation de son schéma.
         *
         * 25 Mo d'Opus, c'est environ onze minutes de parole : dépasser
         * `DICTATION_MAX` est un cas réel, pas théorique. Laisser le schéma Zod
         * de l'outil s'en charger renvoyait une ZodError dans le `catch`
         * générique, donc un 422 « dictée non exploitable en devis » — un
         * message FAUX, rendu après avoir déjà payé la transcription.
         *
         * On tronque, on traite ce qu'on a, et on le DIT.
         */
        const kept = transcript.slice(0, DICTATION_MAX);

        let toolset: Awaited<ReturnType<typeof buildToolset>> | null = null;
        try {
          toolset = await buildToolset({
            ...agentContext,
            tenantId: request.tenantId,
            role: request.membershipRole,
            requestedBy: request.authSession.user.id,
            employee: "commercial",
            onPendingAction: () => {
              void notifyPendingAction(request.tenantId).catch((error: unknown) => {
                request.log.warn(
                  { err: error instanceof Error ? error.name : "Error" },
                  "push record failed",
                );
              });
            },
          });
          const result = await toolset.execute("draft_quote_from_dictation", {
            transcript: kept,
          });
          void reply.header("cache-control", "private, no-store");
          return reply.code(202).send({
            ...(JSON.parse(result) as Record<string, unknown>),
            // Rendu à l'écran pour la relecture immédiate, avant même d'ouvrir
            // la file : ce que la machine a ENTENDU, mot pour mot.
            transcript: kept,
            // Une troncature MUETTE serait le pire cas : le dirigeant relirait
            // un texte amputé en croyant tout voir, et validerait un devis
            // auquel il manque la fin de la dictée.
            transcriptTruncated: kept.length < transcript.length,
            formatProviderConfirmed: format.providerConfirmed,
          });
        } catch (error) {
          if (isUnknownTool(error)) return reply.code(409).send({ error: "module désactivé" });
          request.log.warn(
            { err: error instanceof Error ? error.name : "Error" },
            "dictation quote draft failed",
          );
          return reply.code(422).send({ error: "dictée non exploitable en devis" });
        } finally {
          await toolset?.close().catch(() => undefined);
        }
      },
    );
  });

  // --- Échéancier fiscal & social (2.9) -----------------------------------
  // Le calendrier n'est JAMAIS stocké : il est recalculé à chaque lecture
  // depuis le catalogue versionné et le profil fiscal. Seules les décisions
  // humaines persistent (montant déclaré, payé, non applicable) — un
  // changement de régime ne laisse donc pas derrière lui des échéances
  // fantômes. Owner-only de bout en bout : régime fiscal et montants d'impôt.

  app.get("/echeancier/profil", { preHandler: ownerRoute }, async (request, reply) => {
    // Régime fiscal = donnée de dirigeant : jamais mise en cache par un
    // intermédiaire (même doctrine que l'échéancier lui-même).
    void reply.header("cache-control", "private, no-store");
    const profile = await withTenant(request.tenantId, (tx) =>
      tx.tenantProfile.findFirst({
        select: {
          vatRegime: true,
          corporateTaxLiable: true,
          fiscalYearEndMonth: true,
          payrollPeriodicity: true,
        },
      }),
    );
    return {
      // Défauts = état RÉEL tant que rien n'est renseigné : `inconnu` et
      // `aucune` ne sont pas des valeurs commodes, ils bloquent la génération
      // des échéances correspondantes plutôt que d'en inventer.
      vatRegime: profile?.vatRegime ?? "inconnu",
      corporateTaxLiable: profile?.corporateTaxLiable ?? true,
      fiscalYearEndMonth: profile?.fiscalYearEndMonth ?? 12,
      payrollPeriodicity: profile?.payrollPeriodicity ?? "aucune",
      rulesVersion: TAX_CALENDAR_VERSION,
    };
  });

  const FiscalProfileBody = z
    .object({
      vatRegime: z.enum(VAT_REGIMES),
      corporateTaxLiable: z.boolean(),
      fiscalYearEndMonth: z.number().int().min(1).max(12),
      payrollPeriodicity: z.enum(PAYROLL_PERIODICITIES),
    })
    .strict();

  app.put("/echeancier/profil", { preHandler: ownerRoute }, async (request, reply) => {
    const parsed = FiscalProfileBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid payload" });
    void reply.header("cache-control", "private, no-store");
    const saved = await withTenant(request.tenantId, (tx) =>
      tx.tenantProfile.upsert({
        where: { tenantId: request.tenantId },
        create: { tenantId: request.tenantId, ...parsed.data },
        update: parsed.data,
        select: {
          vatRegime: true,
          corporateTaxLiable: true,
          fiscalYearEndMonth: true,
          payrollPeriodicity: true,
        },
      }),
    );
    return saved;
  });

  /** Échéancier : MÊME chemin que l'agent (outil owner-gated du toolset). */
  app.get("/echeancier", { preHandler: ownerRoute }, async (request, reply) => {
    const query = z
      .object({ monthsAhead: z.coerce.number().int().min(1).max(12).optional() })
      .safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "invalid query" });
    let toolset: Awaited<ReturnType<typeof buildToolset>> | null = null;
    try {
      toolset = await buildToolset({
        ...agentContext,
        tenantId: request.tenantId,
        role: request.membershipRole,
      });
      const result = await toolset.execute("check_tax_calendar", {
        ...(query.data.monthsAhead !== undefined ? { monthsAhead: query.data.monthsAhead } : {}),
      });
      void reply.header("cache-control", "private, no-store");
      return JSON.parse(result) as unknown;
    } catch (error) {
      if (isUnknownTool(error)) return reply.code(409).send({ error: "module désactivé" });
      request.log.warn(
        { err: error instanceof Error ? error.name : "Error" },
        "tax calendar unavailable",
      );
      return reply.code(503).send({ error: "échéancier indisponible" });
    } finally {
      await toolset?.close().catch(() => undefined);
    }
  });

  /** Statuts d'une échéance — écriture ET relecture passent par ce schéma. */
  const DeadlineStatus = z.enum(["prevu", "paye", "non_applicable"]);

  const DeadlineBody = z
    .object({
      obligationId: z.enum(Object.keys(TAX_OBLIGATIONS) as [string, ...string[]]),
      // Date STRICTEMENT calendaire : "2026-02-31" passerait un simple regex,
      // deviendrait `Invalid Date`, et l'erreur Prisma qui s'ensuit CITE ses
      // arguments (montant, note) dans les logs. 400 propre plutôt que 500.
      dueDate: IsoDay,
      // Montant DÉCLARÉ par le dirigeant : le produit n'en dérive jamais un.
      amountCents: z.number().int().min(0).max(100_000_000_00).nullable(),
      status: DeadlineStatus,
      note: z.string().max(500).nullable(),
    })
    .strict();

  app.put("/echeancier/deadline", { preHandler: ownerRoute }, async (request, reply) => {
    const parsed = DeadlineBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid payload" });
    const { obligationId, dueDate, ...rest } = parsed.data;
    const saved = await withTenant(request.tenantId, (tx) =>
      tx.taxDeadline.upsert({
        where: {
          tenantId_obligationId_dueDate: {
            tenantId: request.tenantId,
            obligationId,
            dueDate: new Date(`${dueDate}T00:00:00Z`),
          },
        },
        create: {
          tenantId: request.tenantId,
          obligationId,
          dueDate: new Date(`${dueDate}T00:00:00Z`),
          ...rest,
        },
        update: rest,
        select: { obligationId: true, status: true, amountCents: true },
      }),
    );
    return saved;
  });

  // --- Sync Silae (3.10) — alimente équipe + absences depuis le SIRH ------
  // Déclenchée par l'HUMAIN (bouton page Équipe, précédent FEC 2.14) ;
  // idempotente : salariés rapprochés par externalRef puis par nom, absences
  // dédupliquées — re-synchroniser ne duplique jamais, n'écrase jamais un
  // conflit en silence. Salaires/bulletins JAMAIS lus (minimisation source).

  const SILAE_EMPLOYEE_MAX = 500;
  const SILAE_ABSENCE_MAX = 2_000;
  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

  function mapAbsenceType(raw: string | null | undefined): string {
    const value = (raw ?? "").toLowerCase();
    if (/malad/.test(value)) return "maladie";
    if (/form/.test(value)) return "formation";
    // `cp` ancré sur le mot : « arrêt CPAM » ou « CPF » ne sont pas des congés.
    if (/cong|rtt|vacan/.test(value) || /\bcp\b/.test(value)) return "conges";
    return "autre";
  }

  async function collectPages<T>(
    fetchPage: (
      cursor?: string,
    ) => Promise<{ items: T[]; next_cursor?: string | null | undefined }>,
    max: number,
  ): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 12; page++) {
      const { items: pageItems, next_cursor } = await fetchPage(cursor);
      // Pas de spread (pile bornée) et plafond appliqué EN accumulant : une
      // page fournisseur surdimensionnée ne gonfle jamais la mémoire au-delà
      // de la borne annoncée.
      for (const item of pageItems) {
        if (items.length >= max + 1) break;
        items.push(item);
      }
      if (items.length > max) return { items: items.slice(0, max), truncated: true };
      if (!next_cursor) return { items, truncated: false };
      cursor = next_cursor;
    }
    return { items, truncated: true };
  }

  app.post("/connectors/silae/sync", { preHandler: ownerRoute }, async (request, reply) => {
    let silae;
    try {
      silae = await getSilaeClient(request.tenantId, agentContext);
    } catch (error) {
      if (error instanceof ConnectorNotConfiguredError) {
        return reply.code(409).send({ error: "connecteur silae non configuré" });
      }
      throw error;
    }
    try {
      const employees = await collectPages(
        (cursor) => silae.listEmployees({ limit: 100, ...(cursor ? { cursor } : {}) }),
        SILAE_EMPLOYEE_MAX,
      );
      // Fenêtre d'absences bornée : 3 mois en arrière (perf horaire 3.6)
      // jusqu'à 12 mois en avant (plannings 3.5).
      const now = new Date();
      const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1))
        .toISOString()
        .slice(0, 10);
      const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 13, 0))
        .toISOString()
        .slice(0, 10);
      const absences = await collectPages(
        (cursor) => silae.listAbsences({ from, to, limit: 200, ...(cursor ? { cursor } : {}) }),
        SILAE_ABSENCE_MAX,
      );

      // Pré-nettoyage HORS transaction : lignes exploitables uniquement.
      // Borne de nom alignée sur la saisie manuelle (StaffBody, 120).
      const employeeRows: { ref: string; name: string; weeklyHours: number; active: boolean }[] =
        [];
      let precheckSkipped = 0;
      for (const employee of employees.items) {
        const name = `${employee.first_name ?? ""} ${employee.last_name ?? ""}`
          .trim()
          .slice(0, 120);
        if (!name || !employee.id) {
          precheckSkipped += 1;
          continue;
        }
        employeeRows.push({
          ref: employee.id,
          name,
          weeklyHours: Math.min(80, Math.max(0, Math.round(employee.weekly_hours ?? 35))),
          active: employee.active ?? true,
        });
      }
      const fromDate = new Date(`${from}T00:00:00Z`);
      const toDate = new Date(`${to}T00:00:00Z`);

      const result = await withTenant(
        request.tenantId,
        async (tx) => {
          const counts = {
            employeesCreated: 0,
            employeesUpdated: 0,
            employeesSkipped: precheckSkipped,
            employeesDeactivated: 0,
            absencesCreated: 0,
            absencesUpdated: 0,
            absencesSkipped: 0,
            absencesRemoved: 0,
          };
          // Lectures PAR LOT (audit 3.10) : deux findMany indexés remplacent
          // les findFirst par salarié — la transaction reste courte.
          const refs = employeeRows.map((row) => row.ref);
          const names = employeeRows.map((row) => row.name);
          const byRefRows = await tx.staffMember.findMany({
            where: { externalRef: { in: refs } },
            select: { id: true, name: true, externalRef: true },
          });
          const byNameRows = await tx.staffMember.findMany({
            where: { name: { in: names } },
            select: { id: true, name: true, externalRef: true },
          });
          const refMap = new Map(byRefRows.map((row) => [row.externalRef as string, row]));
          const nameMap = new Map(byNameRows.map((row) => [row.name, row]));
          const takenNames = new Set([...byNameRows, ...byRefRows].map((row) => row.name));
          const staffIdByRef = new Map<string, string>();

          for (const row of employeeRows) {
            const existing = refMap.get(row.ref);
            if (existing) {
              // Renommage seulement si le nouveau nom est libre — jamais un
              // conflit d'unicité au milieu de la transaction.
              const rename = existing.name !== row.name && !takenNames.has(row.name);
              await tx.staffMember.update({
                where: { id: existing.id },
                data: {
                  weeklyHours: row.weeklyHours,
                  active: row.active,
                  ...(rename ? { name: row.name } : {}),
                },
              });
              if (rename) {
                takenNames.delete(existing.name);
                takenNames.add(row.name);
              }
              counts.employeesUpdated += 1;
              staffIdByRef.set(row.ref, existing.id);
              continue;
            }
            const homonym = nameMap.get(row.name);
            if (homonym && homonym.externalRef === null) {
              // Fiche saisie à la main : adoptée par la sync (externalRef posé).
              await tx.staffMember.update({
                where: { id: homonym.id },
                data: { externalRef: row.ref, weeklyHours: row.weeklyHours, active: row.active },
              });
              homonym.externalRef = row.ref;
              counts.employeesUpdated += 1;
              staffIdByRef.set(row.ref, homonym.id);
            } else if (homonym || takenNames.has(row.name)) {
              // Même nom, autre id Silae : conflit compté, jamais écrasé.
              counts.employeesSkipped += 1;
            } else {
              const created = await tx.staffMember.create({
                data: {
                  tenantId: request.tenantId,
                  name: row.name,
                  weeklyHours: row.weeklyHours,
                  active: row.active,
                  externalRef: row.ref,
                },
                select: { id: true },
              });
              takenNames.add(row.name);
              counts.employeesCreated += 1;
              staffIdByRef.set(row.ref, created.id);
            }
          }

          // Rétention (art. 5.1.e, audit 3.10) : sur une liste NON tronquée et
          // non vide, les fiches synchronisées absentes de la source sont
          // DÉSACTIVÉES — jamais supprimées en silence, jamais sur une liste
          // vide (un raté fournisseur ne doit pas éteindre toute l'équipe).
          if (!employees.truncated && refs.length > 0) {
            const gone = await tx.staffMember.updateMany({
              where: { externalRef: { not: null, notIn: refs }, active: true },
              data: { active: false },
            });
            counts.employeesDeactivated = gone.count;
          }

          // Absences : réconciliation par ID SOURCE (audit 3.10) — une absence
          // modifiée côté paie met à jour SA ligne, jamais un doublon.
          const validAbsences: {
            ref: string;
            staffId: string;
            type: string;
            startDate: Date;
            endDate: Date;
          }[] = [];
          for (const absence of absences.items) {
            const staffId = staffIdByRef.get(absence.employee_id);
            if (!staffId || !ISO_DAY.test(absence.start_date) || !ISO_DAY.test(absence.end_date)) {
              counts.absencesSkipped += 1;
              continue;
            }
            const startDate = new Date(`${absence.start_date}T00:00:00Z`);
            const endDate = new Date(`${absence.end_date}T00:00:00Z`);
            if (
              Number.isNaN(startDate.getTime()) ||
              Number.isNaN(endDate.getTime()) ||
              endDate < startDate ||
              endDate.getTime() - startDate.getTime() > 366 * 86_400_000
            ) {
              counts.absencesSkipped += 1;
              continue;
            }
            validAbsences.push({
              ref: absence.id,
              staffId,
              type: mapAbsenceType(absence.type),
              startDate,
              endDate,
            });
          }
          const absenceRefs = validAbsences.map((absence) => absence.ref);
          const existingAbsences = await tx.staffAbsence.findMany({
            where: {
              OR: [
                { externalRef: { in: absenceRefs } },
                { staffId: { in: [...new Set(validAbsences.map((a) => a.staffId))] } },
              ],
            },
            select: {
              id: true,
              staffId: true,
              type: true,
              startDate: true,
              endDate: true,
              externalRef: true,
            },
          });
          const absenceByRef = new Map(
            existingAbsences
              .filter((absence) => absence.externalRef !== null)
              .map((absence) => [absence.externalRef as string, absence]),
          );
          const keyOf = (a: { staffId: string; type: string; startDate: Date; endDate: Date }) =>
            `${a.staffId}|${a.type}|${a.startDate.toISOString()}|${a.endDate.toISOString()}`;
          const absenceByKey = new Map(existingAbsences.map((a) => [keyOf(a), a]));

          for (const absence of validAbsences) {
            const byRef = absenceByRef.get(absence.ref);
            if (byRef) {
              const changed =
                byRef.staffId !== absence.staffId ||
                byRef.type !== absence.type ||
                byRef.startDate.getTime() !== absence.startDate.getTime() ||
                byRef.endDate.getTime() !== absence.endDate.getTime();
              if (changed) {
                await tx.staffAbsence.update({
                  where: { id: byRef.id },
                  data: {
                    staffId: absence.staffId,
                    type: absence.type,
                    startDate: absence.startDate,
                    endDate: absence.endDate,
                  },
                });
                counts.absencesUpdated += 1;
              } else {
                counts.absencesSkipped += 1;
              }
              continue;
            }
            const twin = absenceByKey.get(keyOf(absence));
            if (twin) {
              // Ligne identique déjà présente (saisie manuelle ou sync
              // antérieure sans id) : adoptée, jamais dupliquée.
              if (twin.externalRef === null) {
                await tx.staffAbsence.update({
                  where: { id: twin.id },
                  data: { externalRef: absence.ref },
                });
              }
              counts.absencesSkipped += 1;
              continue;
            }
            const created = await tx.staffAbsence.create({
              data: {
                tenantId: request.tenantId,
                staffId: absence.staffId,
                type: absence.type,
                startDate: absence.startDate,
                endDate: absence.endDate,
                externalRef: absence.ref,
              },
              select: { id: true, staffId: true, type: true, startDate: true, endDate: true },
            });
            absenceByKey.set(keyOf(created), { ...created, externalRef: absence.ref });
            counts.absencesCreated += 1;
          }

          // Fenêtre NON tronquée et non vide : une absence synchronisée
          // disparue de la source (congé annulé) est retirée — uniquement les
          // lignes ENTIÈREMENT dans la fenêtre interrogée.
          if (!absences.truncated && absenceRefs.length > 0) {
            const removed = await tx.staffAbsence.deleteMany({
              where: {
                externalRef: { not: null, notIn: absenceRefs },
                startDate: { gte: fromDate },
                endDate: { lte: toDate },
              },
            });
            counts.absencesRemoved = removed.count;
          }
          return counts;
        },
        { timeoutMs: 30_000 },
      );

      return {
        ...result,
        truncated: employees.truncated || absences.truncated,
      };
    } catch (error) {
      // Jamais un détail fournisseur ni un nom de salarié dans la réponse.
      request.log.warn({ err: error instanceof Error ? error.name : "Error" }, "silae sync failed");
      return reply.code(503).send({ error: "synchronisation indisponible" });
    }
  });

  // --- Factur-X (2.3) — génération de la facture au format légal ----------
  // La réforme impose la RÉCEPTION au 01/09/2026 et l'ÉMISSION PME au
  // 01/09/2027 (calendrier : regulatoryWatch.ts, 3.7). L'audit de conformité
  // passe AVANT la génération : une facture incohérente ne doit pas exister,
  // pas être rejetée plus tard par la plateforme (ou par un contrôle).

  // bodyLimit EXPLICITE : le défaut Fastify (1 Mo) rendait la borne Zod
  // inatteignable — un vrai PDF de facture avec logo la dépasse vite.
  app.post(
    "/factures/facturx",
    { preHandler: ownerRoute, bodyLimit: 12 * 1024 * 1024 },
    async (request, reply) => {
      const body = z
        .object({
          invoice: z.unknown(),
          profile: z.enum(["MINIMUM", "BASIC_WL", "BASIC", "EN16931"]).default("EN16931"),
          /** PDF existant du tenant (base64) : on attache, on ne redessine pas. */
          basePdfBase64: z.string().max(12_000_000).optional(),
        })
        .strict()
        .safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "invalid payload" });

      const invoice = FacturXInvoice.safeParse(body.data.invoice);
      if (!invoice.success) {
        // Jamais l'erreur Zod telle quelle : elle citerait les valeurs reçues
        // (nom du client, montants) dans la réponse et les logs.
        return reply.code(400).send({ error: "facture invalide" });
      }

      const audit = auditInvoice(invoice.data);
      if (!audit.issuable) {
        // 422 + le détail des BLOQUANTS : l'owner doit savoir quoi corriger.
        return reply.code(422).send({ error: "facture non conforme", audit });
      }

      try {
        const xml = buildCiiXml(invoice.data, body.data.profile);
        const pdf = await buildFacturXPdf(
          invoice.data,
          xml,
          body.data.profile,
          body.data.basePdfBase64
            ? new Uint8Array(Buffer.from(body.data.basePdfBase64, "base64"))
            : undefined,
        );
        // Données client (nom, adresse, SIRET, montants) : jamais mises en
        // cache par un intermédiaire — même doctrine que la photo du classeur.
        void reply.header("cache-control", "private, no-store");
        return {
          profile: body.data.profile,
          rulesVersion: audit.rulesVersion,
          audit,
          fileName: `facture-${invoice.data.number || "sans-numero"}.pdf`.replace(/[^\w.-]/g, "-"),
          pdfBase64: Buffer.from(pdf).toString("base64"),
          xml,
        };
      } catch (error) {
        // Nom d'erreur seulement : le message pourrait citer la facture.
        request.log.warn(
          { err: error instanceof Error ? error.name : "Error" },
          "facturx generation failed",
        );
        // Un PDF de base illisible/chiffré est une erreur d'ENTRÉE : un 503
        // ferait chercher une panne serveur là où il faut corriger le fichier.
        return reply.code(422).send({ error: "PDF de base illisible ou facture non générable" });
      }
    },
  );

  /** Lecture d'une facture Factur-X REÇUE : extraction du XML embarqué. */
  app.post(
    "/factures/facturx/lire",
    { preHandler: businessRoute, bodyLimit: 12 * 1024 * 1024 },
    async (request, reply) => {
      const body = z
        .object({ pdfBase64: z.string().min(1).max(12_000_000) })
        .strict()
        .safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "invalid payload" });
      try {
        const xml = await extractFacturXXml(
          new Uint8Array(Buffer.from(body.data.pdfBase64, "base64")),
        );
        if (!xml) return reply.code(422).send({ error: "aucune donnée Factur-X dans ce PDF" });
        void reply.header("cache-control", "private, no-store");
        return { xml };
      } catch (error) {
        request.log.warn(
          { err: error instanceof Error ? error.name : "Error" },
          "facturx read failed",
        );
        return reply.code(422).send({ error: "PDF illisible" });
      }
    },
  );

  // --- Soumission PDP + e-reporting (2.4) ---------------------------------
  // Émettre une facture sur le réseau national ENGAGE l'entreprise : le dépôt
  // est irréversible, horodaté, et opposable. Il ne part donc JAMAIS de la
  // boucle agent — la route prépare, l'humain valide, l'exécuteur dépose
  // (règle HITL du CLAUDE.md, comme adjust_stock avant lui).

  /** Métadonnées de suivi SEULEMENT : ni PDF, ni XML, ni ligne de facture. */
  const SUBMISSION_SELECT = {
    id: true,
    invoiceNumber: true,
    profile: true,
    direction: true,
    status: true,
    pdpReference: true,
    documentHash: true,
    amountCents: true,
    currency: true,
    statusHistory: true,
    submittedAt: true,
    createdAt: true,
    updatedAt: true,
  } as const;

  app.post(
    "/factures/soumettre",
    { preHandler: ownerRoute, bodyLimit: 2 * 1024 * 1024 },
    async (request, reply) => {
      const body = z
        .object({
          invoice: z.unknown(),
          // MINIMUM/BASIC_WL ne sont pas générables (2.3) : les proposer ici
          // ferait échouer l'exécution APRÈS validation humaine.
          profile: z.enum(["BASIC", "EN16931"]).default("EN16931"),
        })
        .strict()
        .safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "invalid payload" });

      const invoice = FacturXInvoice.safeParse(body.data.invoice);
      // Jamais l'erreur Zod telle quelle : elle citerait les valeurs reçues.
      if (!invoice.success) return reply.code(400).send({ error: "facture invalide" });

      const audit = auditInvoice(invoice.data);
      if (!audit.issuable) {
        // Une facture non conforme n'entre même pas dans la file : la faire
        // valider puis échouer au dépôt userait la confiance dans la file.
        return reply.code(422).send({ error: "facture non conforme", audit });
      }

      // Idempotence AVANT la file (confort) : une facture déjà chez la
      // plateforme ne se re-propose pas, et une proposition en attente ne se
      // duplique pas. La garantie DURE, elle, est la réservation atomique
      // faite par l'exécuteur sur l'index unique — deux propositions
      // concurrentes ne peuvent pas produire deux dépôts.
      const conflict = await withTenant(request.tenantId, async (tx) => {
        const submitted = await tx.eInvoiceSubmission.findFirst({
          where: { invoiceNumber: invoice.data.number, direction: "emission" },
          select: { status: true },
        });
        if (submitted && !REDEPOSITABLE_STATUSES.has(submitted.status)) {
          return { error: "facture déjà déposée", status: submitted.status };
        }
        const queued = await tx.pendingAction.findFirst({
          where: {
            type: "submit_einvoice",
            status: "pending",
            payload: { path: ["invoice", "number"], equals: invoice.data.number },
          },
          select: { id: true },
        });
        return queued ? { error: "dépôt déjà en attente de validation", status: "prete" } : null;
      });
      if (conflict) return reply.code(409).send(conflict);

      const action = await withTenant(request.tenantId, (tx) =>
        tx.pendingAction.create({
          data: {
            tenantId: request.tenantId,
            type: "submit_einvoice",
            requestedBy: request.authSession.user.id,
            employee: "compta",
            // Le payload porte la FACTURE NORMALISÉE, jamais le PDF : le
            // générateur est pur, l'exécuteur le reconstruit à l'identique et
            // REJOUE l'audit juste avant de déposer.
            payload: {
              invoice: invoice.data,
              profile: body.data.profile,
              // Champs d'AFFICHAGE pour la file (l'exécuteur les ignore).
              label: `Dépôt de la facture ${invoice.data.number}`,
              grossCents: invoice.data.totals.grossCents,
              currency: invoice.data.currency,
              rulesVersion: audit.rulesVersion,
            } as Prisma.InputJsonValue,
          },
          select: { id: true },
        }),
      );
      return reply.code(202).send({ pendingActionId: action.id, status: "prete", audit });
    },
  );

  /** Suivi des dépôts — owner only : numéros et montants de factures. */
  app.get("/factures/soumissions", { preHandler: ownerRoute }, async (request, reply) => {
    const query = z
      .object({
        direction: z.enum(["emission", "ereporting"]).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "invalid query" });
    const items = await withTenant(request.tenantId, (tx) =>
      tx.eInvoiceSubmission.findMany({
        where: query.data.direction ? { direction: query.data.direction } : {},
        orderBy: { createdAt: "desc" },
        take: query.data.limit,
        select: SUBMISSION_SELECT,
      }),
    );
    void reply.header("cache-control", "private, no-store");
    return { items, statusLabels: STATUS_LABELS, rulesVersion: LIFECYCLE_RULES_VERSION };
  });

  // E-reporting : ce qui part est un AGRÉGAT (totaux de la période), jamais
  // le détail nominatif des clients — c'est toute la différence avec
  // l'e-invoicing, et elle est structurelle ici.

  /** Pré-remplissage depuis le facturier — ce n'est PAS une déclaration. */
  app.get("/factures/ereporting/apercu", { preHandler: ownerRoute }, async (request, reply) => {
    const query = z
      .object({
        periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "invalid query" });
    let toolset: Awaited<ReturnType<typeof buildToolset>> | null = null;
    try {
      toolset = await buildToolset({
        ...agentContext,
        tenantId: request.tenantId,
        role: request.membershipRole,
      });
      const raw = JSON.parse(await toolset.execute("pennylane_get_invoices", { limit: 100 })) as {
        items?: {
          amount?: string | number | null;
          date?: string | null;
          currency?: string | null;
        }[];
      };
      const ledger = (raw.items ?? []).map((invoice) => {
        const value = typeof invoice.amount === "string" ? Number(invoice.amount) : invoice.amount;
        return {
          amountCents:
            typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : null,
          date: invoice.date ?? null,
          currency: invoice.currency ?? null,
        };
      });
      const aggregate = aggregateEReporting(ledger, query.data.periodStart, query.data.periodEnd);
      void reply.header("cache-control", "private, no-store");
      // `truncated` : le facturier est lu par page — un agrégat partiel ne se
      // présente jamais comme complet.
      return { ...aggregate, truncated: (raw.items ?? []).length >= 100 };
    } catch (error) {
      if (isUnknownTool(error)) return reply.code(409).send({ error: "module désactivé" });
      request.log.warn(
        { err: error instanceof Error ? error.name : "Error" },
        "ereporting preview unavailable",
      );
      return reply.code(503).send({ error: "aperçu indisponible" });
    } finally {
      await toolset?.close().catch(() => undefined);
    }
  });

  /** Transmission de l'agrégat : proposée, validée par l'humain, puis émise. */
  app.post("/factures/ereporting", { preHandler: ownerRoute }, async (request, reply) => {
    const body = z
      .object({
        periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        totalCents: z.number().int().min(0).max(1_000_000_000_00),
        // La TVA n'est PAS dérivée du facturier (cf. aggregateEReporting) :
        // elle est DÉCLARÉE, bornée au total.
        vatCents: z.number().int().min(0).max(1_000_000_000_00),
        transactionCount: z.number().int().min(0).max(1_000_000),
      })
      .strict()
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid payload" });
    if (body.data.vatCents > body.data.totalCents) {
      return reply.code(422).send({ error: "TVA supérieure au total déclaré" });
    }
    if (body.data.periodEnd < body.data.periodStart) {
      return reply.code(422).send({ error: "période invalide" });
    }
    const periodKey = `${body.data.periodStart}..${body.data.periodEnd}`;
    const already = await withTenant(request.tenantId, (tx) =>
      tx.eInvoiceSubmission.findFirst({
        where: { invoiceNumber: periodKey, direction: "ereporting" },
        select: { id: true, status: true },
      }),
    );
    // Une transmission restée en `erreur` (panne de transport) reste
    // re-proposable — sinon la période serait déclarable nulle part.
    if (already && !REDEPOSITABLE_STATUSES.has(already.status)) {
      return reply.code(409).send({ error: "période déjà transmise", status: already.status });
    }
    const action = await withTenant(request.tenantId, (tx) =>
      tx.pendingAction.create({
        data: {
          tenantId: request.tenantId,
          type: "report_einvoice_transactions",
          requestedBy: request.authSession.user.id,
          employee: "compta",
          payload: {
            ...body.data,
            label: `E-reporting ${periodKey}`,
          } as Prisma.InputJsonValue,
        },
        select: { id: true },
      }),
    );
    return reply.code(202).send({ pendingActionId: action.id, period: periodKey });
  });

  // --- Socle webhooks entrants (2.13) --------------------------------------
  // Prérequis des flux PDP (2.4) et Bridge Connect. Une requête webhook n'a
  // AUCUNE session : la signature HMAC est la SEULE preuve d'authenticité, et
  // le tenant se résout depuis l'endpoint (porte `withWebhookResolver`, en
  // lecture seule sur cette seule table) — JAMAIS depuis le corps reçu.

  const webhookSecretName = (tenantId: string, provider: string): string =>
    `webhook/${tenantId}/${provider}`;
  // Handler PDP (2.4) enregistré PAR DÉFAUT : sans lui, la plateforme
  // notifierait dans le vide et le payload d'un statut serait collecté sans
  // finalité (2.13 ne stocke le corps que si un handler existe).
  const webhookHandlers: WebhookHandlerRegistry = options.webhookHandlers ?? {
    pdp: createPdpWebhookHandler(),
  };
  // Gardes de la seule route anonyme : débit borné AVANT toute I/O, et cache
  // court des secrets (sinon un appel coffre par livraison, déclenchable par
  // quiconque connaît l'id d'endpoint — qui est partagé avec un tiers).
  const webhookLimiter = options.webhookRateLimiter ?? new WebhookRateLimiter();
  const webhookSecrets = new WebhookSecretCache();
  /** Métadonnées seulement : ni secretRef, ni payload d'événement. */
  const ENDPOINT_SELECT = {
    id: true,
    provider: true,
    active: true,
    description: true,
    createdAt: true,
  } as const;

  app.post("/webhooks/endpoints", { preHandler: ownerRoute }, async (request, reply) => {
    const body = z
      .object({
        provider: z.enum(WEBHOOK_PROVIDERS),
        description: z.string().trim().max(200).optional(),
      })
      .strict()
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid payload" });

    // Secret généré par le SERVEUR (jamais choisi par le client) et renvoyé
    // UNE SEULE FOIS : ensuite il ne vit qu'au coffre, jamais en base.
    const secret = generateWebhookSecret();
    const secretRef = webhookSecretName(request.tenantId, body.data.provider);

    // Rotation NON destructive (audit 2.13) : un upsert conserve l'id de
    // l'endpoint — donc l'URL déjà configurée chez le fournisseur — ET le
    // journal des réceptions (piste d'audit non effaçable en un clic).
    const endpoint = await withTenant(request.tenantId, (tx) =>
      tx.webhookEndpoint.upsert({
        where: {
          tenantId_provider: { tenantId: request.tenantId, provider: body.data.provider },
        },
        create: {
          tenantId: request.tenantId,
          provider: body.data.provider,
          secretRef,
          description: body.data.description ?? "",
        },
        update: {
          secretRef,
          active: true,
          ...(body.data.description !== undefined ? { description: body.data.description } : {}),
        },
        select: ENDPOINT_SELECT,
      }),
    );
    // Coffre APRÈS la ligne : si l'écriture DB échoue, l'ancien secret n'a pas
    // été écrasé et l'endpoint existant continue de fonctionner.
    try {
      await vault.set(secretRef, secret);
      webhookSecrets.invalidate(secretRef);
    } catch (error) {
      request.log.error(
        { err: error instanceof Error ? error.name : "Error" },
        "webhook secret write failed",
      );
      return reply.code(503).send({ error: "coffre indisponible" });
    }
    return reply.code(201).send({
      ...endpoint,
      // Absolue quand l'URL publique est connue : une URL relative n'est pas
      // recopiable telle quelle chez un fournisseur.
      url: `${(process.env.PUBLIC_API_URL ?? "").replace(/\/+$/, "")}/webhooks/${endpoint.provider}/${endpoint.id}`,
      // Affiché une fois, à recopier chez le fournisseur — jamais relisible.
      secret,
      signatureHeader: "X-Nodaq-Signature",
    });
  });

  app.get("/webhooks/endpoints", { preHandler: ownerRoute }, async (request) => {
    const endpoints = await withTenant(request.tenantId, (tx) =>
      tx.webhookEndpoint.findMany({ select: ENDPOINT_SELECT, orderBy: { provider: "asc" } }),
    );
    return { endpoints };
  });

  app.delete(
    "/webhooks/endpoints/:provider",
    { preHandler: ownerRoute },
    async (request, reply) => {
      const params = z.object({ provider: z.enum(WEBHOOK_PROVIDERS) }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "invalid payload" });
      const deleted = await withTenant(request.tenantId, (tx) =>
        tx.webhookEndpoint.deleteMany({ where: { provider: params.data.provider } }),
      );
      if (deleted.count === 0) return reply.code(404).send({ error: "unknown endpoint" });
      await vault
        .delete(webhookSecretName(request.tenantId, params.data.provider))
        .catch(() => undefined);
      return { deleted: true };
    },
  );

  // Journal des réceptions : métadonnées de traitement UNIQUEMENT — le
  // payload fournisseur (données métier) ne ressort pas par cette route.
  app.get("/webhooks/events", { preHandler: ownerRoute }, async (request) => {
    const events = await withTenant(request.tenantId, (tx) =>
      tx.webhookEvent.findMany({
        select: {
          id: true,
          provider: true,
          eventType: true,
          externalId: true,
          status: true,
          attempts: true,
          receivedAt: true,
          processedAt: true,
        },
        orderBy: { receivedAt: "desc" },
        take: 100,
      }),
    );
    return { events };
  });

  /**
   * Traitement métier APRÈS la réponse 202 : un handler lent ou en échec ne
   * déclenche jamais de tempête de re-livraisons côté fournisseur, et
   * l'événement stocké reste la source de vérité pour un rejeu.
   */
  const processWebhookEvent = async (event: {
    id: string;
    tenantId: string;
    provider: string;
    eventType: string;
    externalId: string;
    payload: unknown;
  }): Promise<void> => {
    // Rétention (art. 5.1.e) : purge opportuniste des réceptions expirées du
    // tenant — bornée, sans balayeur supplémentaire.
    const retentionFloor = new Date(
      Date.now() - WEBHOOK_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    await withTenant(event.tenantId, (tx) =>
      tx.webhookEvent.deleteMany({ where: { receivedAt: { lt: retentionFloor } } }),
    ).catch(() => undefined);

    const handler = webhookHandlers[event.provider];
    if (!handler) {
      await withTenant(event.tenantId, (tx) =>
        tx.webhookEvent.updateMany({ where: { id: event.id }, data: { status: "ignored" } }),
      );
      return;
    }
    try {
      await handler(event);
      await withTenant(event.tenantId, (tx) =>
        tx.webhookEvent.updateMany({
          where: { id: event.id },
          data: { status: "processed", processedAt: new Date(), attempts: { increment: 1 } },
        }),
      );
    } catch (error) {
      // Nom d'erreur SEULEMENT : un message pourrait citer le payload.
      await withTenant(event.tenantId, (tx) =>
        tx.webhookEvent.updateMany({
          where: { id: event.id },
          data: {
            status: "failed",
            error: error instanceof Error ? error.name : "Error",
            attempts: { increment: 1 },
          },
        }),
      );
    }
  };

  // Réception PUBLIQUE (aucune session) : parser brut CANTONNÉ à ce plugin —
  // la signature couvre les octets exacts, un corps re-sérialisé casserait la
  // preuve. Corps borné : un fournisseur ne dicte pas notre mémoire.
  void app.register(async (hooks) => {
    hooks.addContentTypeParser(
      ["application/json", "application/json; charset=utf-8"],
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );

    hooks.post(
      "/webhooks/:provider/:endpointId",
      { bodyLimit: 1024 * 1024 },
      async (request, reply) => {
        // Réponse CONSTANTE sur tout échec d'authentification : ni l'existence
        // de l'endpoint, ni la raison du rejet ne fuient (pas d'oracle).
        const refuse = () => reply.code(401).send({ error: "unauthorized" });

        // Débit borné AVANT toute I/O : sans cela un flood anonyme ouvrirait
        // une transaction par requête et viderait le pool — l'API tomberait
        // pour TOUS les tenants (disponibilité, art. 32).
        if (!webhookLimiter.take(request.ip)) {
          return reply.code(429).send({ error: "too many requests" });
        }

        const params = z
          .object({ provider: z.enum(WEBHOOK_PROVIDERS), endpointId: Uuid })
          .safeParse(request.params);
        if (!params.success) return refuse();
        const raw = request.body;
        if (!Buffer.isBuffer(raw) || raw.length === 0) return refuse();

        // Résolution du tenant AVANT tout accès métier : accesseur FERMÉ (une
        // ligne ou rien) au-dessus de la porte en lecture seule.
        const endpoint = await resolveWebhookEndpoint(params.data.endpointId, params.data.provider);
        if (!endpoint) {
          request.log.warn({ provider: params.data.provider }, "webhook endpoint not resolved");
          return refuse();
        }
        // Garde de namespace (précédent connecteurs) : un secretRef qui ne
        // vise pas le tenant de l'endpoint est refusé, jamais suivi.
        if (endpoint.secretRef !== webhookSecretName(endpoint.tenantId, endpoint.provider)) {
          request.log.warn({ endpointId: endpoint.id }, "webhook secret ref outside namespace");
          return refuse();
        }
        let secret = webhookSecrets.get(endpoint.secretRef);
        if (secret === undefined) {
          secret = await vault.get(endpoint.secretRef).catch(() => undefined);
          if (secret) webhookSecrets.set(endpoint.secretRef, secret);
        }
        if (!secret) {
          // Panne de coffre = 401 massif : sans ce log, elle serait INVISIBLE
          // côté ops et se lirait comme une révocation côté fournisseur.
          request.log.error({ endpointId: endpoint.id }, "webhook secret unavailable");
          return refuse();
        }

        const verdict = verifyWebhookSignature({
          header:
            typeof request.headers["x-nodaq-signature"] === "string"
              ? request.headers["x-nodaq-signature"]
              : undefined,
          body: raw,
          secret,
          now: new Date(),
        });
        if (!verdict.ok) {
          // La RAISON reste côté serveur (ops), jamais dans la réponse.
          request.log.warn(
            { reason: verdict.reason, provider: endpoint.provider },
            "webhook rejected",
          );
          return refuse();
        }

        let payload: unknown;
        try {
          payload = JSON.parse(raw.toString("utf8"));
        } catch {
          return reply.code(400).send({ error: "invalid payload" });
        }
        const envelope = parseWebhookEnvelope(payload);
        if (!envelope) return reply.code(400).send({ error: "invalid payload" });

        // MINIMISATION (art. 5.1.b/c) : sans handler pour ce provider, le
        // corps fournisseur (transactions bancaires, factures nominatives)
        // n'a AUCUNE finalité — on garde la trace de réception, jamais la
        // donnée. Le payload n'est collecté que s'il va être traité.
        const willProcess = webhookHandlers[endpoint.provider] !== undefined;

        // Idempotence : (tenant, provider, externalId) unique — une
        // re-livraison du fournisseur ne crée jamais un second événement.
        let stored: { id: string } | null = null;
        let duplicate = false;
        try {
          stored = await withTenant(endpoint.tenantId, (tx) =>
            tx.webhookEvent.create({
              data: {
                tenantId: endpoint.tenantId,
                endpointId: endpoint.id,
                provider: endpoint.provider,
                externalId: envelope.externalId,
                eventType: envelope.eventType,
                payload: (willProcess ? payload : {}) as Prisma.InputJsonValue,
                ...(willProcess ? {} : { status: "ignored" }),
              },
              select: { id: true },
            }),
          );
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            duplicate = true;
          } else {
            // Corps signé mais ininsérable (ex.   refusé par jsonb) :
            // refus explicite, sans laisser une erreur Prisma citer ses
            // arguments dans le gestionnaire global.
            request.log.warn(
              { err: error instanceof Error ? error.name : "Error", provider: endpoint.provider },
              "webhook event not stored",
            );
            return reply.code(400).send({ error: "invalid payload" });
          }
        }

        if (stored) {
          const event = {
            ...envelope,
            id: stored.id,
            tenantId: endpoint.tenantId,
            provider: endpoint.provider,
            payload,
          };
          void processWebhookEvent(event).catch((error: unknown) => {
            request.log.warn(
              { err: error instanceof Error ? error.name : "Error" },
              "webhook handler failed",
            );
          });
        }
        // 202 dans les deux cas : le fournisseur a fait son travail.
        return reply.code(202).send({ received: true, duplicate });
      },
    );
  });

  // --- Modules par vertical (3.11) ----------------------------------------
  // État effectif = défauts du catalogue versionné (vertical du profil 3.7)
  // + surcharges explicites de l'owner. Lecture pour TOUS les membres (la
  // navigation en dépend) ; bascule owner-only. La (dés)activation est une
  // surface produit, PAS une frontière de sécurité : les autorisations des
  // routes restent inchangées, seuls nav et outils agent suivent.

  app.get("/modules", { preHandler: businessRoute }, async (request) => {
    const { vertical, overrides } = await readModuleState(request.tenantId);
    // Le vertical est une donnée stratégique OWNER-ONLY (3.7) : la nav des
    // membres n'a besoin que de {id, href, active} — ni vertical ni source
    // (les défauts du vertical resteraient inférables sinon).
    const isOwner = request.membershipRole === "owner";
    return {
      version: MODULE_CATALOG_VERSION,
      ...(isOwner ? { vertical } : {}),
      modules: resolveModules(vertical, overrides).map(({ tools: _tools, source, ...module }) => ({
        ...module,
        ...(isOwner ? { source } : {}),
      })),
    };
  });

  app.put("/modules/:id", { preHandler: ownerRoute }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1).max(50) }).safeParse(request.params);
    const body = z.object({ active: z.boolean() }).strict().safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "invalid payload" });
    }
    if (!MODULES.some((module) => module.id === params.data.id)) {
      return reply.code(404).send({ error: "unknown module" });
    }
    // Lecture-modification-écriture dans UNE transaction : deux bascules
    // concurrentes ne se perdent pas. Assainissement en map booléenne pure
    // (modules CONNUS seulement — Prisma exige un InputJsonValue).
    await withTenant(request.tenantId, async (tx) => {
      const profile = await tx.tenantProfile.findFirst({
        select: { moduleOverrides: true },
      });
      const stored =
        profile?.moduleOverrides !== null &&
        typeof profile?.moduleOverrides === "object" &&
        !Array.isArray(profile?.moduleOverrides)
          ? (profile?.moduleOverrides as Record<string, unknown>)
          : {};
      const nextOverrides: Record<string, boolean> = {};
      for (const module of MODULES) {
        const value = stored[module.id];
        if (typeof value === "boolean") nextOverrides[module.id] = value;
      }
      nextOverrides[params.data.id] = body.data.active;
      await tx.tenantProfile.upsert({
        where: { tenantId: request.tenantId },
        create: { tenantId: request.tenantId, moduleOverrides: nextOverrides },
        update: { moduleOverrides: nextOverrides },
        select: { id: true },
      });
    });
    return { id: params.data.id, active: body.data.active };
  });

  // --- Assistant RGPD (3.9) — owner-only : registre des traitements -------
  // (art. 30, document de conformité stratégique). Modèles CNIL versionnés
  // sourcés ; audit déterministe ; jamais un conseil juridique.

  const ACTIVITY_SELECT = {
    id: true,
    name: true,
    purpose: true,
    legalBasis: true,
    dataCategories: true,
    dataSubjects: true,
    recipients: true,
    retention: true,
    sensitiveData: true,
    sourceTemplate: true,
    updatedAt: true,
  } as const;

  app.get("/rgpd", { preHandler: ownerRoute }, async (request) => {
    const rows = await withTenant(request.tenantId, (tx) =>
      tx.processingActivity.findMany({
        select: ACTIVITY_SELECT,
        orderBy: { name: "asc" },
        take: 501,
      }),
    );
    const activitiesTruncated = rows.length > 500;
    const activities = rows.slice(0, 500);
    // Audit via le MÊME outil que l'agent ; s'il échoue, le registre reste
    // servi avec `audit: null` — jamais un 503 qui masque des données saines.
    let audit: unknown = null;
    let toolset: Awaited<ReturnType<typeof buildToolset>> | null = null;
    try {
      toolset = await buildToolset({
        ...agentContext,
        tenantId: request.tenantId,
        role: request.membershipRole,
      });
      audit = JSON.parse(await toolset.execute("check_rgpd_register", {}));
    } catch (error) {
      request.log.warn(
        { err: error instanceof Error ? error.name : "Error" },
        "rgpd audit unavailable",
      );
    } finally {
      await toolset?.close().catch(() => undefined);
    }
    return { activities, activitiesTruncated, audit, templates: PROCESSING_TEMPLATES };
  });

  const ActivityBody = z
    .object({
      name: z.string().trim().min(1).max(200),
      purpose: z.string().trim().min(1).max(1_000),
      legalBasis: z.enum(LEGAL_BASES),
      // Catégories fermées (DATA_CATEGORIES) : « santé » ou « Santé » ne
      // peuvent pas contourner la règle d'audit sur le littéral `sante`.
      dataCategories: z.array(z.enum(DATA_CATEGORIES)).min(1).max(20),
      dataSubjects: z.array(z.string().trim().min(1).max(50)).min(1).max(20),
      recipients: z.string().max(500).optional(),
      retention: z.string().trim().min(1).max(500),
      sensitiveData: z.boolean().default(false),
    })
    .strict();

  app.post("/rgpd", { preHandler: ownerRoute }, async (request, reply) => {
    const parsed = ActivityBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid payload" });
    try {
      const created = await withTenant(request.tenantId, (tx) =>
        tx.processingActivity.create({
          data: {
            tenantId: request.tenantId,
            name: parsed.data.name,
            purpose: parsed.data.purpose,
            legalBasis: parsed.data.legalBasis,
            dataCategories: parsed.data.dataCategories,
            dataSubjects: parsed.data.dataSubjects,
            recipients: parsed.data.recipients ?? null,
            retention: parsed.data.retention,
            sensitiveData: parsed.data.sensitiveData,
          },
          select: { id: true },
        }),
      );
      return reply.code(201).send(created);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.code(409).send({ error: "traitement déjà enregistré" });
      }
      throw error;
    }
  });

  // Ajout 1-clic depuis un modèle CNIL du catalogue versionné.
  app.post("/rgpd/modele/:templateId", { preHandler: ownerRoute }, async (request, reply) => {
    const params = z.object({ templateId: z.string().min(1).max(50) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid payload" });
    const template = PROCESSING_TEMPLATES.find((t) => t.id === params.data.templateId);
    if (!template) return reply.code(404).send({ error: "unknown template" });
    try {
      const created = await withTenant(request.tenantId, (tx) =>
        tx.processingActivity.create({
          data: {
            tenantId: request.tenantId,
            name: template.name,
            purpose: template.purpose,
            legalBasis: template.legalBasis,
            dataCategories: [...template.dataCategories],
            dataSubjects: [...template.dataSubjects],
            recipients: template.recipients,
            retention: template.retention,
            sensitiveData: template.sensitiveData,
            sourceTemplate: template.id,
          },
          select: { id: true },
        }),
      );
      return reply.code(201).send(created);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.code(409).send({ error: "traitement déjà enregistré" });
      }
      throw error;
    }
  });

  app.patch("/rgpd/:id", { preHandler: ownerRoute }, async (request, reply) => {
    const params = z.object({ id: Uuid }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid payload" });
    const parsed = ActivityBody.partial().strict().safeParse(request.body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      return reply.code(400).send({ error: "invalid payload" });
    }
    const data = parsed.data;
    try {
      const updated = await withTenant(request.tenantId, (tx) =>
        tx.processingActivity.updateMany({
          where: { id: params.data.id },
          data: {
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.purpose !== undefined ? { purpose: data.purpose } : {}),
            ...(data.legalBasis !== undefined ? { legalBasis: data.legalBasis } : {}),
            ...(data.dataCategories !== undefined ? { dataCategories: data.dataCategories } : {}),
            ...(data.dataSubjects !== undefined ? { dataSubjects: data.dataSubjects } : {}),
            ...(data.recipients !== undefined ? { recipients: data.recipients } : {}),
            ...(data.retention !== undefined ? { retention: data.retention } : {}),
            ...(data.sensitiveData !== undefined ? { sensitiveData: data.sensitiveData } : {}),
          },
        }),
      );
      if (updated.count === 0) return reply.code(404).send({ error: "unknown activity" });
      return { updated: true };
    } catch (error) {
      // Renommage vers un nom déjà pris : même 409 que POST, jamais un 500 ORM.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.code(409).send({ error: "traitement déjà enregistré" });
      }
      throw error;
    }
  });

  app.delete("/rgpd/:id", { preHandler: ownerRoute }, async (request, reply) => {
    const params = z.object({ id: Uuid }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid payload" });
    const deleted = await withTenant(request.tenantId, (tx) =>
      tx.processingActivity.deleteMany({ where: { id: params.data.id } }),
    );
    if (deleted.count === 0) return reply.code(404).send({ error: "unknown activity" });
    return { deleted: true };
  });

  // --- Avis clients / e-réputation (3.8) ----------------------------------
  // Lecture pour tous les membres (avis publics déjà en ligne) ; écriture du
  // registre owner-only ; la RÉPONSE passe par la file de validation (HITL) —
  // en V1 la publication plateforme reste manuelle (copier-coller).

  const REVIEW_SELECT = {
    id: true,
    source: true,
    authorName: true,
    rating: true,
    text: true,
    reviewedAt: true,
    replyText: true,
    repliedAt: true,
  } as const;

  // --- CRM & prospection (2.12) — données personnelles de TIERS non clients.
  // Accessible aux MEMBRES : prospecter est leur métier, et la fiche ne porte
  // aucun chiffre d'affaires (contrairement aux signaux clients 3.4, owner-
  // only). La suppression définitive, elle, reste à l'owner.

  const PROSPECT_SELECT = {
    id: true,
    name: true,
    company: true,
    email: true,
    phone: true,
    stage: true,
    source: true,
    optedOut: true,
    optedOutAt: true,
    notes: true,
    createdAt: true,
  } as const;

  /**
   * Retire de la file les brouillons de relance visant ce prospect. Leur
   * payload porte son nom : ni l'opposition ni l'effacement ne seraient
   * complets s'ils survivaient dans `pending_actions`.
   */
  async function rejectProspectDrafts(
    tx: Prisma.TransactionClient,
    prospectId: string,
  ): Promise<void> {
    await tx.pendingAction.updateMany({
      where: {
        type: "record_prospect_contact",
        status: "pending",
        payload: { path: ["prospect", "id"], equals: prospectId },
      },
      data: {
        status: "rejected",
        // Le payload est RÉDUIT en même temps : rejeter sans réduire
        // laisserait le brouillon nominatif en base indéfiniment.
        payload: { reduced: true, prospectId } as Prisma.InputJsonValue,
      },
    });
  }

  app.get("/prospects", { preHandler: businessRoute }, async (request, reply) => {
    // Fiches = données personnelles : jamais de cache partagé.
    void reply.header("cache-control", "private, no-store");
    // Troncature DITE (doctrine maison) : au-delà de la borne, une partie du
    // CRM deviendrait invisible sans que personne le sache.
    const PROSPECT_PAGE = 500;
    const prospects = await withTenant(request.tenantId, (tx) =>
      tx.prospect.findMany({
        select: PROSPECT_SELECT,
        orderBy: { createdAt: "desc" },
        take: PROSPECT_PAGE + 1,
      }),
    );
    return {
      prospects: prospects.slice(0, PROSPECT_PAGE),
      truncated: prospects.length > PROSPECT_PAGE,
    };
  });

  const ProspectBody = z
    .object({
      name: z.string().min(1).max(200),
      company: z.string().max(200).optional(),
      // `.trim()` AVANT la validation : une adresse collée avec des espaces
      // est la même adresse, et un 400 ici masquerait le contrôle
      // d'exclusion qui vient juste après.
      email: z.string().trim().email().max(320).optional(),
      phone: z.string().trim().max(40).optional(),
      stage: z.enum(PROSPECT_STAGES).default("nouveau"),
      // Provenance EXIGÉE (art. 14) : pas de valeur par défaut, pas de fiche
      // dont on ne saurait pas dire d'où elle vient.
      source: z.enum(PROSPECT_SOURCES),
      notes: z.string().max(1_000).optional(),
    })
    .strict();

  app.post("/prospects", { preHandler: businessRoute }, async (request, reply) => {
    const parsed = ProspectBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid payload" });
    void reply.header("cache-control", "private, no-store");
    // LISTE D'EXCLUSION (audit 2.12) : une personne qui s'est opposée ne doit
    // pas revenir par une resaisie. Ses coordonnées ayant été effacées, c'est
    // le condensat qui la reconnaît — sinon la garde annoncée n'existe pas.
    const hashes = contactHashes(request.tenantId, parsed.data);
    if (hashes.length > 0) {
      const excluded = await withTenant(request.tenantId, (tx) =>
        tx.prospectExclusion.findFirst({
          where: { contactHash: { in: hashes } },
          select: { id: true },
        }),
      );
      if (excluded) {
        return reply.code(409).send({ error: "personne opposée à la prospection" });
      }
    }
    const created = await withTenant(request.tenantId, (tx) =>
      tx.prospect.create({
        data: {
          tenantId: request.tenantId,
          name: parsed.data.name,
          company: parsed.data.company ?? null,
          email: parsed.data.email ?? null,
          phone: parsed.data.phone ?? null,
          stage: parsed.data.stage,
          source: parsed.data.source,
          notes: parsed.data.notes ?? null,
        },
        select: { id: true },
      }),
    );
    return reply.code(201).send(created);
  });

  const ProspectPatchBody = z
    .object({
      stage: z.enum(PROSPECT_STAGES).optional(),
      notes: z.string().max(1_000).optional(),
      company: z.string().max(200).optional(),
      // `.trim()` AVANT la validation : une adresse collée avec des espaces
      // est la même adresse, et un 400 ici masquerait le contrôle
      // d'exclusion qui vient juste après.
      email: z.string().trim().email().max(320).optional(),
      phone: z.string().trim().max(40).optional(),
    })
    .strict();

  app.patch("/prospects/:id", { preHandler: businessRoute }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = ProspectPatchBody.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({ error: "invalid payload" });
    }
    void reply.header("cache-control", "private, no-store");
    // `optedOut` n'est PAS modifiable ici (schéma strict) : lever une
    // opposition par un PATCH générique serait trop facile — elle a sa route.
    const data = {
      ...(parsed.data.stage !== undefined ? { stage: parsed.data.stage } : {}),
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
      ...(parsed.data.company !== undefined ? { company: parsed.data.company } : {}),
      ...(parsed.data.email !== undefined ? { email: parsed.data.email } : {}),
      ...(parsed.data.phone !== undefined ? { phone: parsed.data.phone } : {}),
    };
    // Même garde qu'à la création : rattacher à une AUTRE fiche la coordonnée
    // d'une personne opposée la ferait revenir dans les relances par la porte
    // du PATCH.
    const patchHashes = contactHashes(request.tenantId, parsed.data);
    if (patchHashes.length > 0) {
      const excluded = await withTenant(request.tenantId, (tx) =>
        tx.prospectExclusion.findFirst({
          where: { contactHash: { in: patchHashes } },
          select: { id: true },
        }),
      );
      if (excluded) {
        return reply.code(409).send({ error: "personne opposée à la prospection" });
      }
    }
    // `optedOut: false` dans le WHERE : sans lui, un PATCH remettrait un
    // e-mail ou un téléphone sur une personne qui s'y est opposée — la
    // minimisation faite à l'opposition serait défaite en un appel.
    const { count } = await withTenant(request.tenantId, (tx) =>
      tx.prospect.updateMany({ where: { id: params.data.id, optedOut: false }, data }),
    );
    if (count === 0) {
      const exists = await withTenant(request.tenantId, (tx) =>
        tx.prospect.findUnique({ where: { id: params.data.id }, select: { optedOut: true } }),
      );
      if (!exists) return reply.code(404).send({ error: "prospect not found" });
      return reply.code(409).send({ error: "prospect opposé" });
    }
    return { updated: true };
  });

  const InteractionBody = z
    .object({
      kind: z.enum(INTERACTION_KINDS),
      occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      note: z.string().max(1_000).optional(),
    })
    .strict();

  app.post("/prospects/:id/interactions", { preHandler: businessRoute }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = InteractionBody.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({ error: "invalid payload" });
    }
    // Date STRICTEMENT calendaire : "2026-02-31" glisserait au 3 mars et
    // décalerait un « dernier contact », donc une relance.
    const occurredAt = new Date(`${parsed.data.occurredAt}T00:00:00Z`);
    if (
      Number.isNaN(occurredAt.getTime()) ||
      occurredAt.toISOString().slice(0, 10) !== parsed.data.occurredAt
    ) {
      return reply.code(400).send({ error: "invalid payload" });
    }
    void reply.header("cache-control", "private, no-store");
    // Lecture ET insertion dans la MÊME transaction (audit 2.12) : en deux
    // transactions, une opposition validée entre les deux laisserait consigner
    // un contact sur une personne qui vient de s'y opposer.
    const created = await withTenant(request.tenantId, async (tx) => {
      const prospect = await tx.prospect.findUnique({
        where: { id: params.data.id },
        select: { optedOut: true },
      });
      if (!prospect) return { error: "not-found" as const };
      // Consigner un contact sur une personne opposée reviendrait à documenter
      // une prospection qui n'aurait pas dû avoir lieu : refus net.
      if (prospect.optedOut) return { error: "opposed" as const };
      const row = await tx.prospectInteraction.create({
        data: {
          tenantId: request.tenantId,
          prospectId: params.data.id,
          kind: parsed.data.kind,
          occurredAt,
          note: parsed.data.note ?? null,
          createdBy: request.authSession.user.id,
        },
        select: { id: true },
      });
      return { id: row.id };
    });
    if ("error" in created) {
      return created.error === "not-found"
        ? reply.code(404).send({ error: "prospect not found" })
        : reply.code(409).send({ error: "prospect opposé" });
    }
    return reply.code(201).send(created);
  });

  app.get("/prospects/:id/interactions", { preHandler: businessRoute }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid payload" });
    void reply.header("cache-control", "private, no-store");
    const JOURNAL_PAGE = 200;
    const interactions = await withTenant(request.tenantId, (tx) =>
      tx.prospectInteraction.findMany({
        where: { prospectId: params.data.id },
        select: { id: true, kind: true, occurredAt: true, note: true, createdAt: true },
        orderBy: { occurredAt: "desc" },
        take: JOURNAL_PAGE + 1,
      }),
    );
    return {
      interactions: interactions.slice(0, JOURNAL_PAGE),
      truncated: interactions.length > JOURNAL_PAGE,
    };
  });

  // Opposition (art. 21). Elle n'est PAS réversible depuis le produit : lever
  // une opposition demanderait la preuve d'un nouveau consentement, que le
  // produit n'a aucun moyen de recueillir ici. On garde la fiche MINIMALE —
  // la supprimer laisserait la même personne être réimportée demain.
  app.post("/prospects/:id/opposition", { preHandler: businessRoute }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid payload" });
    void reply.header("cache-control", "private, no-store");
    const result = await withTenant(request.tenantId, async (tx) => {
      const prospect = await tx.prospect.findUnique({
        where: { id: params.data.id },
        select: { id: true, optedOut: true, email: true, phone: true },
      });
      if (!prospect) return null;
      if (prospect.optedOut) return { alreadyOptedOut: true };

      // L'exclusion est dérivée AVANT l'effacement : après, la clé n'existe
      // plus. C'est elle — et non la fiche conservée — qui empêche vraiment
      // la personne d'être resaisie demain.
      const hashes = contactHashes(request.tenantId, prospect);
      if (hashes.length > 0) {
        await tx.prospectExclusion.createMany({
          data: hashes.map((hash) => ({ tenantId: request.tenantId, contactHash: hash })),
          skipDuplicates: true,
        });
      }

      await tx.prospect.update({
        where: { id: prospect.id },
        data: {
          optedOut: true,
          optedOutAt: new Date(),
          // Minimisation immédiate : on ne garde que de quoi ne PAS
          // recontacter la personne. Les coordonnées et les notes n'ont plus
          // de finalité une fois l'opposition exprimée.
          email: null,
          phone: null,
          notes: null,
        },
      });
      // Les comptes rendus de contacts perdent aussi leur finalité : le
      // journal reste (il prouve la chronologie) mais vidé de son contenu.
      await tx.prospectInteraction.updateMany({
        where: { prospectId: prospect.id },
        data: { note: null },
      });
      // Une relance encore EN ATTENTE porte le nom de la personne dans son
      // brouillon : la laisser en file, c'est garder — et pouvoir approuver —
      // une prospection à laquelle elle vient de s'opposer.
      await rejectProspectDrafts(tx, prospect.id);
      /*
       * Les transcriptions portent les MÊMES coordonnées que celles qu'on
       * vient d'effacer : `list_prospection_followups` les y a déposées. Ce
       * n'est pas l'article 17, mais c'est le même raisonnement — minimiser
       * la fiche en laissant sa copie dans un fil illisible ne minimise rien.
       */
      const transcripts = await purgeAgentTranscripts(tx, request.tenantId);
      return { alreadyOptedOut: false, hashed: hashes.length > 0, conversationsEffacees: transcripts };
    });
    if (result === null) return reply.code(404).send({ error: "prospect not found" });
    return { optedOut: true, ...result };
  });

  // Suppression définitive : OWNER. Effacer une fiche efface aussi son
  // journal (cascade) — c'est le droit à l'effacement, pas un archivage.
  app.delete(
    "/prospects/:id",
    { preHandler: [...businessRoute, requireRole(["owner"])] },
    async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "invalid payload" });
      void reply.header("cache-control", "private, no-store");
      const outcome = await withTenant(request.tenantId, async (tx) => {
        /*
         * EXISTENCE D'ABORD — un 404 ne doit RIEN avoir effacé au passage.
         *
         * Le 404 se décide après le commit (sur `count === 0`), donc la
         * transaction n'est jamais annulée : sans ce contrôle en tête,
         * `DELETE /prospects/<uuid inconnu>` — un double-clic, un rejeu après
         * un 200 réussi — détruisait TOUTES les transcriptions du tenant puis
         * répondait « prospect not found ». Les deux autres purges énoncent
         * cet invariant et le respectent ; celle-ci le violait.
         */
        const cible = await tx.prospect.findUnique({
          where: { id: params.data.id },
          select: { id: true },
        });
        if (cible === null) return null;

        // La cascade FK emporte le journal, mais pas la file : un brouillon
        // nominatif y survivrait à l'effacement, qui ne serait donc que
        // partiel. On le retire dans la MÊME transaction.
        await rejectProspectDrafts(tx, params.data.id);

        /*
         * L'identité RECOPIÉE sur les affaires (4.1) — la limite que
         * `docs/affaires.md` annonçait sans la traiter.
         *
         * `client_name`, `address` et les coordonnées GPS sont une copie
         * INDÉPENDANTE de l'identité et de l'adresse — souvent le domicile —
         * de la personne. La clé composite met `prospect_id` à NULL ; la copie,
         * elle, survivait intacte. Effacer la fiche en gardant l'adresse, ce
         * n'est pas un effacement.
         *
         * LE STATUT NE SUFFIT PAS À DÉCIDER, et la première version de ce
         * ticket le croyait. `PERDUE` semblait signifier « jamais contractée »,
         * mais `EN_COURS -> PERDUE` est un chemin banal : chantier commencé
         * puis abandonné, client défaillant. Anonymiser sur ce seul mot
         * détruisait la preuve d'un travail réellement effectué — exactement
         * l'erreur pour laquelle `ARCHIVEE` était déjà épargnée. Le
         * raisonnement valait pour une famille et pas pour l'autre.
         *
         * On regarde donc les TRACES D'EXÉCUTION, qui sont des faits et non un
         * libellé : pièces imputées non révoquées, factures rattachées,
         * acomptes encaissés, heures pointées, date de fin réelle. Une seule
         * suffit à conserver.
         */
        /*
         * LA SOURCE DE RECOPIE (4.2 bloc 2) — le trou que ce ticket ferme.
         *
         * `POST /contrats/:id/occurrences` écrit `contrat.client_name` sur
         * chaque affaire générée. Anonymiser les affaires existantes en
         * laissant le contrat intact, c'est effacer un nom qui revient au clic
         * suivant : un effacement qui se défait tout seul n'est pas un
         * effacement, c'est un délai.
         */
        const contrats = await tx.contrat.findMany({
          where: { prospectId: params.data.id },
          select: { id: true, label: true, status: true, clientName: true },
        });
        const contratIds = contrats.map((contrat) => contrat.id);

        /*
         * Deux chemins vers les affaires, tous deux EXPLICITES.
         *
         * Le second (fiche -> contrat -> affaires) n'est pas un raffinement :
         * les affaires matérialisées avant ce ticket ne portent aucun
         * `prospect_id`, la matérialisation ne copiait que le nom. La
         * recherche par fiche seule les manquait — et l'effacement se
         * déclarait complet en les laissant nominatives.
         */
        const affaires = await tx.affaire.findMany({
          where: {
            OR: [
              { prospectId: params.data.id },
              /*
               * Le chemin par contrat ne vaut que pour les affaires ORPHELINES
               * de fiche.
               *
               * Un contrat d'entretien peut servir plusieurs interlocuteurs, et
               * `PATCH /affaires` accepte un `prospectId` : une affaire générée
               * par ce contrat mais rattachée EXPLICITEMENT à quelqu'un d'autre
               * appartient à cette autre personne. L'anonymiser serait le
               * symétrique exact de l'erreur que le refus de la correspondance
               * de noms cherche à éviter — détruire la donnée d'un tiers au
               * nom de l'effacement d'un autre.
               */
              ...(contratIds.length > 0
                ? [{ contratId: { in: contratIds }, prospectId: null }]
                : []),
            ],
          },
          select: {
            id: true,
            reference: true,
            label: true,
            status: true,
            contratId: true,
            depositsCents: true,
            hoursWorked: true,
            actualEndDate: true,
            completedAt: true,
            _count: {
              select: {
                imputations: { where: { revokedAt: null } },
                fecInvoices: true,
              },
            },
          },
        });

        const anonymisables: readonly (typeof AFFAIRE_STATUSES)[number][] = [
          "PROSPECT",
          "DEVIS_ENVOYE",
          "PERDUE",
        ];
        /** Motif de CONSERVATION, ou `null` quand rien ne fonde de garder. */
        const motifDeConservation = (affaire: (typeof affaires)[number]): string | null => {
          if (!anonymisables.includes(affaire.status as (typeof AFFAIRE_STATUSES)[number])) {
            return affaire.status === "ARCHIVEE"
              ? "archivée — le statut ne dit pas si un contrat a existé, à vérifier"
              : "exécution du contrat";
          }
          // Statut « jamais contractée », mais les faits disent le contraire.
          if (affaire._count.imputations > 0) return "des dépenses y sont imputées, à vérifier";
          if (affaire._count.fecInvoices > 0) return "des factures y sont rattachées, à vérifier";
          if ((affaire.depositsCents ?? 0) > 0) return "un acompte a été encaissé, à vérifier";
          if ((affaire.hoursWorked ?? 0) > 0) return "des heures y ont été pointées, à vérifier";
          /*
           * `completedAt` est le fait le PLUS FORT de cette liste : il atteste
           * une transition réelle vers `TERMINEE`, là où `actualEndDate` n'est
           * qu'une saisie libre. Le cas est inatteignable aujourd'hui — les
           * trois statuts anonymisables l'effacent tous — mais cette cohérence
           * ne tient qu'à `nextCompletedAt` : l'omettre ici ferait dépendre
           * une garde d'effacement d'une règle écrite ailleurs.
           */
          if (affaire.completedAt !== null)
            return "l'affaire a été livrée, à vérifier";
          if (affaire.actualEndDate !== null)
            return "une date de fin réelle est saisie, à vérifier";
          return null;
        };

        const aAnonymiser = affaires.filter((affaire) => motifDeConservation(affaire) === null);
        const { count: anonymisees } = await tx.affaire.updateMany({
          where: { id: { in: aAnonymiser.map((affaire) => affaire.id) } },
          data: { clientName: null, address: null, latitude: null, longitude: null },
        });
        // Ce qui RESTE, et pourquoi — jamais une conservation muette.
        const conservees = affaires
          .map((affaire) => ({ affaire, motif: motifDeConservation(affaire) }))
          .filter(
            (row): row is { affaire: (typeof affaires)[number]; motif: string } =>
              row.motif !== null,
          );

        /*
         * Le contrat suit la MÊME logique que les affaires : on conserve sur
         * un FAIT, jamais sur un libellé.
         *
         * Deux faits fondent une conservation. Un contrat ACTIF est une
         * relation en cours d'exécution (art. 17.3.b) — l'effacer casserait
         * la prestation que la personne reçoit encore. Un contrat qui a
         * produit une affaire elle-même conservée porte la trace de la même
         * exécution : l'anonymiser tout en gardant l'affaire nominative ne
         * protégerait personne et détruirait la seule pièce qui explique d'où
         * vient ce chantier.
         */
        const contratsAvecAffaireConservee = new Set(
          conservees
            .map(({ affaire }) => affaire.contratId)
            .filter((id): id is string => id !== null),
        );
        const motifDeConservationContrat = (contrat: (typeof contrats)[number]): string | null => {
          if (contrat.status === "ACTIF") {
            return "contrat en cours — l'exécution le fonde, à vérifier";
          }
          if (contratsAvecAffaireConservee.has(contrat.id)) {
            return "des interventions exécutées en dérivent, à vérifier";
          }
          return null;
        };
        const contratsAAnonymiser = contrats.filter(
          (contrat) => motifDeConservationContrat(contrat) === null,
        );
        const { count: contratsAnonymises } = await tx.contrat.updateMany({
          where: { id: { in: contratsAAnonymiser.map((contrat) => contrat.id) } },
          /*
           * `notes` part AVEC le nom, et ce n'est pas du zèle.
           *
           * C'est un champ libre de 2 000 caractères sur un contrat dont on
           * vient de juger que rien ne fonde de le garder — « le client
           * n'ouvre jamais avant 9 h », « conflit sur la facture de mars ». Le
           * lien vers la fiche disparaît une ligne plus bas par `SET NULL` :
           * ce qui survit ici devient définitivement inatteignable. L'opt-out
           * (`/prospects/:id/opposition`) efface déjà `notes` pour la même
           * raison, et l'anonymisation des affaires emporte déjà l'adresse.
           */
          data: { clientName: null, notes: null },
        });
        const contratsConserves = contrats
          .map((contrat) => ({ contrat, motif: motifDeConservationContrat(contrat) }))
          .filter(
            (row): row is { contrat: (typeof contrats)[number]; motif: string } =>
              row.motif !== null,
          );

        /*
         * L'ANGLE MORT, compté plutôt que tu.
         *
         * Un contrat qui porte un nom de client sans lien vers une fiche est
         * hors de portée de tout effacement : rien ne permet de savoir s'il
         * s'agit de cette personne, et le déduire par correspondance de noms
         * serait l'inférence que la doctrine interdit — deux clients homonymes
         * existent, et effacer le contrat du mauvais détruit la donnée d'un
         * tiers en silence. Le nombre ne prétend rien sur la personne
         * effacée : il dit combien de contrats l'owner doit relire lui-même.
         */
        const transcripts = await purgeAgentTranscripts(tx, request.tenantId);
        const deleted = await tx.prospect.deleteMany({ where: { id: params.data.id } });
        /*
         * COMPTÉ APRÈS la suppression, et l'ordre porte la justesse du nombre.
         *
         * Le `SET NULL` de la FK détache à l'instant les contrats CONSERVÉS :
         * ils gardent leur nom et n'ont plus de fiche, donc ils entrent
         * pleinement dans « ce que l'owner doit relire ». Compter avant les
         * aurait exclus — le nombre aurait valu `réel − contratsConserves`
         * sous un libellé qui promet le total, c'est-à-dire un angle mort
         * annoncé trop petit.
         */
        const contratsSansFiche = await tx.contrat.count({
          where: { prospectId: null, clientName: { not: null } },
        });
        return {
          count: deleted.count,
          anonymisees,
          conservees,
          contratsAnonymises,
          contratsConserves,
          contratsSansFiche,
          transcripts,
        };
      });
      if (outcome === null) return reply.code(404).send({ error: "prospect not found" });
      /*
       * TRACE DE REDEVABILITÉ (art. 5.2) — des compteurs, jamais un nom.
       *
       * Le compte rendu rendu à l'écran n'est pas persisté : c'est une réponse
       * HTTP. Sans cette ligne, la seule preuve qu'un effacement a eu lieu
       * serait la prise de notes de l'owner. Le nom en est absent — journaliser
       * l'identité qu'on vient d'effacer serait la recréer dans les logs.
       */
      request.log.info(
        {
          affairesAnonymisees: outcome.anonymisees,
          affairesConservees: outcome.conservees.length,
          contratsAnonymises: outcome.contratsAnonymises,
          contratsConserves: outcome.contratsConserves.length,
          conversationsEffacees: outcome.transcripts,
        },
        "prospect erased (art. 17)",
      );
      return {
        deleted: true,
        affairesAnonymisees: outcome.anonymisees,
        // Un effacement qui laisse des données DOIT dire lesquelles : c'est ce
        // qui permet à l'owner de terminer le travail à la main.
        affairesConservees: outcome.conservees.map(({ affaire, motif }) => ({
          id: affaire.id,
          reference: affaire.reference,
          label: affaire.label,
          status: affaire.status,
          motif,
        })),
        contratsAnonymises: outcome.contratsAnonymises,
        contratsConserves: outcome.contratsConserves.map(({ contrat, motif }) => ({
          id: contrat.id,
          label: contrat.label,
          status: contrat.status,
          motif,
        })),
        // Ce que l'effacement NE PEUT PAS atteindre — sans quoi « effacé » se
        // lirait « il ne reste rien ».
        contratsSansFiche: outcome.contratsSansFiche,
        conversationsEffacees: outcome.transcripts,
      };
    },
  );

  // Plan de relance : même chemin que l'agent (outil du toolset lié au
  // tenant) — une implémentation, un seul jeu de seuils.
  app.get("/prospection/suivi", { preHandler: businessRoute }, async (request, reply) => {
    void reply.header("cache-control", "private, no-store");
    let toolset: Awaited<ReturnType<typeof buildToolset>> | null = null;
    try {
      toolset = await buildToolset({
        ...agentContext,
        tenantId: request.tenantId,
        role: request.membershipRole,
      });
      const result = await toolset.execute("list_prospection_followups", {});
      return JSON.parse(result) as unknown;
    } catch (error) {
      if (isUnknownTool(error)) {
        return reply.code(409).send({ error: "outil indisponible pour ce tenant" });
      }
      request.log.warn(
        { err: error instanceof Error ? error.name : "Error" },
        "prospection plan unavailable",
      );
      return reply.code(503).send({ error: "suivi indisponible" });
    } finally {
      await toolset?.close().catch(() => undefined);
    }
  });

  app.get("/avis", { preHandler: businessRoute }, async (request) => {
    const reviews = await withTenant(request.tenantId, (tx) =>
      tx.customerReview.findMany({
        select: REVIEW_SELECT,
        orderBy: { reviewedAt: "desc" },
        take: 200,
      }),
    );
    return { reviews };
  });

  const ReviewBody = z
    .object({
      source: z.enum(["manuel", "google", "autre"]).default("manuel"),
      externalId: z.string().min(1).max(200).optional(),
      authorName: z.string().min(1).max(200).optional(),
      rating: z.number().int().min(1).max(5),
      text: z.string().min(1).max(4_000),
      reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .strict();

  app.post("/avis", { preHandler: ownerRoute }, async (request, reply) => {
    const parsed = ReviewBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid payload" });
    const reviewedAt = new Date(`${parsed.data.reviewedAt}T00:00:00Z`);
    if (
      Number.isNaN(reviewedAt.getTime()) ||
      reviewedAt.toISOString().slice(0, 10) !== parsed.data.reviewedAt
    ) {
      return reply.code(400).send({ error: "invalid payload" });
    }
    try {
      const created = await withTenant(request.tenantId, (tx) =>
        tx.customerReview.create({
          data: {
            tenantId: request.tenantId,
            source: parsed.data.source,
            externalId: parsed.data.externalId ?? null,
            authorName: parsed.data.authorName ?? null,
            rating: parsed.data.rating,
            text: parsed.data.text,
            reviewedAt,
          },
          select: { id: true },
        }),
      );
      return reply.code(201).send(created);
    } catch (error) {
      // Doublon (tenant, source, externalId) : 409 net, jamais un 500 qui
      // nomme l'ORM.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return reply.code(409).send({ error: "review already exists" });
      }
      throw error;
    }
  });

  const ImportReviewsBody = z.object({ reviews: z.array(ReviewBody).min(1).max(500) }).strict();

  app.post("/avis/import", { preHandler: ownerRoute }, async (request, reply) => {
    const parsed = ImportReviewsBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid payload" });
    const rows: Prisma.CustomerReviewCreateManyInput[] = [];
    for (const review of parsed.data.reviews) {
      const reviewedAt = new Date(`${review.reviewedAt}T00:00:00Z`);
      if (
        Number.isNaN(reviewedAt.getTime()) ||
        reviewedAt.toISOString().slice(0, 10) !== review.reviewedAt
      ) {
        return reply.code(400).send({ error: "invalid payload" });
      }
      rows.push({
        tenantId: request.tenantId,
        source: review.source,
        externalId: review.externalId ?? null,
        authorName: review.authorName ?? null,
        rating: review.rating,
        text: review.text,
        reviewedAt,
      });
    }
    // Dédup par (tenant, source, externalId) : re-importer le même export ne
    // duplique jamais ; sans externalId, la ligne est toujours insérée.
    const result = await withTenant(request.tenantId, (tx) =>
      tx.customerReview.createMany({ data: rows, skipDuplicates: true }),
    );
    return { imported: result.count, skipped: rows.length - result.count };
  });

  app.delete("/avis/:id", { preHandler: ownerRoute }, async (request, reply) => {
    const params = z.object({ id: Uuid }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid payload" });
    const deleted = await withTenant(request.tenantId, (tx) =>
      tx.customerReview.deleteMany({ where: { id: params.data.id } }),
    );
    if (deleted.count === 0) return reply.code(404).send({ error: "unknown review" });
    return { deleted: true };
  });

  // Synthèse e-réputation : MÊME chemin que l'agent (outil du toolset).
  app.get("/avis/reputation", { preHandler: businessRoute }, async (request, reply) => {
    let toolset: Awaited<ReturnType<typeof buildToolset>> | null = null;
    try {
      toolset = await buildToolset({
        ...agentContext,
        tenantId: request.tenantId,
        role: request.membershipRole,
      });
      const result = await toolset.execute("analyze_reputation", {});
      return JSON.parse(result) as unknown;
    } catch (error) {
      if (isUnknownTool(error)) {
        return reply.code(409).send({ error: "module désactivé" });
      }
      request.log.warn(
        { err: error instanceof Error ? error.name : "Error" },
        "reputation unavailable",
      );
      return reply.code(503).send({ error: "réputation indisponible" });
    } finally {
      await toolset?.close().catch(() => undefined);
    }
  });

  // Brouillon de réponse : outil d'ÉCRITURE -> pending_action (HITL), jamais
  // une publication directe. Accessible aux membres : la file gate l'exécution.
  app.post("/avis/:id/reponse", { preHandler: businessRoute }, async (request, reply) => {
    const params = z.object({ id: Uuid }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid payload" });
    let toolset: Awaited<ReturnType<typeof buildToolset>> | null = null;
    try {
      toolset = await buildToolset({
        ...agentContext,
        tenantId: request.tenantId,
        role: request.membershipRole,
        requestedBy: request.authSession.user.id,
        onPendingAction: () => {
          void notifyPendingAction(request.tenantId).catch((error: unknown) => {
            request.log.warn(
              { err: error instanceof Error ? error.name : "Error" },
              "push record failed",
            );
          });
        },
      });
      const result = await toolset.execute("draft_review_reply", { reviewId: params.data.id });
      return JSON.parse(result) as unknown;
    } catch (error) {
      if (isUnknownTool(error)) {
        return reply.code(409).send({ error: "module désactivé" });
      }
      request.log.warn(
        { err: error instanceof Error ? error.name : "Error" },
        "review reply draft failed",
      );
      return reply.code(503).send({ error: "brouillon indisponible" });
    } finally {
      await toolset?.close().catch(() => undefined);
    }
  });

  /*
   * F5 — le brief du matin.
   *
   * Premier écran lu de la journée, sur un téléphone, avant le café. Tout est
   * assemblé à partir de moteurs déterministes déjà testés — aucun LLM, aucun
   * chiffre calculé ici.
   *
   * Ce qui n'a pas pu être regardé est RENDU (`blindSpots`) : un brief qui omet
   * silencieusement les impayés parce qu'aucun facturier n'est connecté laisse
   * croire qu'il n'y en a pas.
   */
  /**
   * Contrats actifs examinés par le brief et rendus par la liste.
   *
   * Borne DITE : au-delà, le brief pousse un angle mort plutôt que de laisser
   * un compteur partiel passer pour un total. Un TPE de 3 à 15 salariés n'y
   * arrivera pas ; la borne est écrite ici plutôt que promise absente.
   */
  const CONTRATS_BRIEF_LIMIT = 500;

  app.get("/brief", { preHandler: businessRoute }, async (request, reply) => {
    void reply.header("cache-control", "private, no-store");
    const isOwner = request.membershipRole === "owner";
    const blindSpots: { area: string; why: string }[] = [];

    const [affairesOn, stocksOn, classeurOn] = await Promise.all([
      isModuleActive(request.tenantId, "affaires"),
      isModuleActive(request.tenantId, "stocks"),
      isModuleActive(request.tenantId, "classeur"),
    ]);

    // Fenêtre d'échéancier : de quoi voir ce qui vient ET ce qui traîne. Le
    // regard en arrière est borné parce qu'une échéance oubliée depuis un an
    // n'est plus l'information du matin ; ce que cette borne laisse dehors se
    // lit sur l'écran Échéancier, qui, lui, n'est pas borné.
    const dayMs = 86_400_000;
    const today = new Date();
    // Date CIVILE française, pas UTC : l'échéancier raisonne en jours du
    // calendrier français, et entre minuit et 2 h à Paris `toISOString()` rend
    // la veille — un brief ouvert tôt daterait ses échéances d'un jour de trop.
    const isoDaysFromNow = (days: number): string =>
      new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(
        new Date(today.getTime() + days * dayMs),
      );
    const todayIso = isoDaysFromNow(0);
    const windowFrom = isoDaysFromNow(-BRIEF_LATE_LOOKBACK_DAYS);
    const windowTo = isoDaysFromNow(ECHEANCE_HORIZON_DAYS);

    const stockSql = async (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) =>
      stocksOn
        ? await tx.$queryRaw<{ count: number }[]>`
            SELECT count(*)::int AS count FROM stock_items
            WHERE alert_threshold > 0 AND quantity <= alert_threshold`
        : null;

    const data = await withTenant(request.tenantId, async (tx) => {
      const pendingActions = await tx.pendingAction.count({ where: { status: "pending" } });
      const documentsAVerifier = classeurOn
        ? await tx.classeurDocument.count({ where: { status: "a_verifier" } })
        : null;

      // Les montants sont owner-only, comme partout ailleurs (4.1, cockpit).
      if (!isOwner) {
        return {
          pendingActions,
          documentsAVerifier,
          affaires: null,
          hourlyCostKnown: null,
          schedule: null,
          annotated: new Set<string>(),
          impayes: null,
          fecWarnings: null,
          stock: await stockSql(tx),
          // Les contrats échus ne portent AUCUN montant dans le brief : c'est
          // du planning, pas de l'argent. Un membre de terrain a besoin de
          // savoir qu'un passage est dû — le lui cacher ferait du brief un
          // écran de dirigeant, alors que le travail, c'est lui qui le fait.
          //
          // Gaté sur le module `affaires` : matérialiser une échéance CRÉE une
          // affaire. Inviter à en créer pendant que le brief dit par ailleurs
          // « affaires : module désactivé » serait se contredire dans le même
          // écran.
          contrats: affairesOn
            ? await tx.contrat.findMany({
                where: { status: "ACTIF" },
                take: CONTRATS_BRIEF_LIMIT + 1,
              })
            : null,
        };
      }

      const stored = await tx.tenantProfile.findUnique({ where: { tenantId: request.tenantId } });
      const margins = affairesOn
        ? await loadAffairesMargins(tx, stored?.hourlyCostCents ?? null)
        : null;

      // Impayés EXIGIBLES : la retenue de garantie est due mais pas exigible,
      // et relancer dessus est la faute qui coûte un client (US-8). Le filtre
      // `residualCents > 0` est celui du moteur de dérivation — sans lui, une
      // facture soldée par une pièce distincte ressort en retard.
      //
      // AGRÉGAT, pas `findMany` : cet écran s'ouvre tous les matins, et il n'a
      // besoin que d'un compte et d'une somme.
      const lastImport = await tx.fecImport.findFirst({
        orderBy: { importedAt: "desc" },
        select: { warnings: true },
      });
      const overdue =
        lastImport === null
          ? null
          : await tx.fecInvoice.aggregate({
              where: { settled: false, residualCents: { gt: 0 }, dueDate: { lt: today } },
              _count: { _all: true },
              _sum: { residualCents: true },
            });

      // Le calendrier est RECALCULÉ (2.9), il n'est pas stocké : la table ne
      // porte que les décisions humaines. Lire la table seule laissait le brief
      // muet sur une CA3 due dans deux jours dès lors que personne ne l'avait
      // annotée — c'est-à-dire dans le cas nominal.
      const activeStaff = await tx.staffMember.count({ where: { active: true } });
      const overrides = await tx.taxDeadline.findMany({
        where: {
          dueDate: {
            gte: new Date(`${windowFrom}T00:00:00Z`),
            lte: new Date(`${windowTo}T00:00:00Z`),
          },
        },
        select: { obligationId: true, dueDate: true, amountCents: true, status: true, note: true },
      });
      const schedule = applyTaxOverrides(
        buildTaxSchedule(resolveTaxProfile(stored, activeStaff), windowFrom, windowTo),
        overrides.map((row): TaxDeadlineOverride => ({
          obligationId: row.obligationId,
          dueDate: row.dueDate.toISOString().slice(0, 10),
          amountCents: row.amountCents,
          // Frontière typée, même sur une lecture : un statut inattendu
          // sortirait l'occurrence de `stillDue`, donc du brief, en silence.
          // `prevu` est le défaut du calendrier — on n'invente rien en y
          // retombant, on refuse juste de disparaître.
          status: DeadlineStatus.catch("prevu").parse(row.status),
          note: row.note,
        })),
      );

      return {
        pendingActions,
        documentsAVerifier,
        affaires: margins,
        hourlyCostKnown: stored?.hourlyCostCents != null,
        schedule,
        // Occurrences que l'humain a EXPLICITEMENT pointées. `prevu` est le
        // défaut d'`applyTaxOverrides` : sans cette clé, « non annotée » et
        // « déclarée impayée » seraient indiscernables (voir plus bas).
        annotated: new Set(
          overrides.map((row) => `${row.obligationId}|${row.dueDate.toISOString().slice(0, 10)}`),
        ),
        impayes: overdue,
        fecWarnings: FecWarnings.parse(lastImport?.warnings ?? []),
        stock: await stockSql(tx),
        contrats: affairesOn
          ? await tx.contrat.findMany({
              where: { status: "ACTIF" },
              take: CONTRATS_BRIEF_LIMIT + 1,
            })
          : null,
      };
    });

    if (!affairesOn) blindSpots.push({ area: "affaires", why: "module désactivé" });
    /*
     * Ce qui n'est pas calculé est DIT : au-delà de la borne, des échéances
     * dues disparaîtraient du compteur sans un mot, et le patron lirait
     * « 4 passages à planifier » là où il y en a cinquante.
     */
    if (data.contrats !== null && data.contrats.length > CONTRATS_BRIEF_LIMIT) {
      blindSpots.push({
        area: "contrats",
        why: `plus de ${CONTRATS_BRIEF_LIMIT} contrats actifs : le compte des passages dus est partiel`,
      });
    }
    if (!stocksOn) blindSpots.push({ area: "stocks", why: "module désactivé" });
    if (!classeurOn) blindSpots.push({ area: "classeur", why: "module désactivé" });
    if (!isOwner) {
      blindSpots.push({ area: "montants et échéances", why: "réservés au dirigeant" });
    } else if (data.impayes === null) {
      blindSpots.push({ area: "impayés", why: "aucun import comptable" });
    }
    // Les limites de la dérivation FEC changent le chiffre lu (une retenue non
    // rattachable reste comptée en impayé) : les taire ici ferait relancer un
    // bon client sur une somme qui n'est pas exigible.
    for (const warning of data.fecWarnings ?? []) {
      blindSpots.push({ area: "impayés", why: warning });
    }
    // Ce que l'échéancier n'a pas pu proposer (régime non renseigné, par
    // exemple) : sans ça, « aucune échéance » se lit « rien à payer ».
    for (const gap of data.schedule?.gaps ?? []) {
      blindSpots.push({ area: "échéancier", why: gap });
    }
    // Trois angles morts que F4 nomme déjà sur sa carte et que le brief perdait
    // en route : une affaire non chiffrable n'est pas une affaire saine.
    if (data.affaires !== null) {
      if (data.affaires.ignorees > 0) {
        blindSpots.push({
          area: "affaires",
          why: `${data.affaires.ignorees} affaire(s) ouverte(s) au-delà des ${AFFAIRES_MARGIN_SCAN_LIMIT} les plus récentes`,
        });
      }
      if (data.affaires.nonChiffrables.length > 0) {
        blindSpots.push({
          area: "affaires",
          why: `${data.affaires.nonChiffrables.length} affaire(s) sans marge calculable (devis ou coûts manquants)`,
        });
      }
      if (data.hourlyCostKnown === false) {
        blindSpots.push({
          area: "marges",
          why: "coût horaire non renseigné : la main-d'œuvre n'entre dans aucune marge",
        });
      }
    }

    // Affaires en perte : marge EXACTE négative, ou plafond négatif (« même au
    // mieux, ce chantier perd »). Un plafond POSITIF ne dit rien et n'entre pas.
    // Règle empruntée à F4, jamais réécrite ici.
    const losing = (data.affaires?.aSurveiller ?? []).filter(
      (row) => (comparableMargin(row.margin) ?? 0) < 0,
    );
    // La PIRE, pas un total — et sur sa propre base : un plafond aplati en
    // marge exacte serait un chiffre faux rendu sans le moindre signe.
    const worst = losing.reduce<BriefWorstMargin | null>((current, row) => {
      const cents = comparableMargin(row.margin);
      if (cents === null || (current !== null && cents >= current.cents)) return current;
      return { cents, basis: row.margin.kind === "marge" ? "exact" : "au_mieux" };
    }, null);
    const overBudget = (data.affaires?.aSurveiller ?? []).filter(
      (row) =>
        (row.margin.kind === "marge" || row.margin.kind === "marge_borne_superieure") &&
        (row.margin.budgetGap?.deltaCents ?? 0) > 0,
    ).length;

    const stillDue = (data.schedule?.deadlines ?? []).filter((line) => line.status === "prevu");
    const toEcheance = (
      line: (typeof stillDue)[number],
      days: number,
      windowOpen = false,
    ): BriefEcheance => ({
      days,
      amountCents: line.amountCents,
      dateIsApproximate: line.dateIsApproximate,
      windowOpen,
    });
    /*
     * TROIS ÉTATS, PAS DEUX — et le troisième n'était pas une subtilité.
     *
     * Filtrer sur « passée » d'un côté et « à venir » de l'autre laissait
     * tomber tout ce qui est entre les deux : une CA3 datée du 15, dont la
     * fenêtre légale court jusqu'au 24, n'était NI en retard (la marge
     * d'approximation n'était pas écoulée) NI à venir (sa date basse était
     * passée). L'obligation la plus récurrente du produit disparaissait du
     * brief neuf jours par mois, sans un mot, sur l'écran dont tout l'argument
     * est de ne rien taire.
     *
     * « EN RETARD » EXIGE UNE ANNOTATION HUMAINE — et ce n'est pas un détail
     * non plus. `applyTaxOverrides` rend `prevu` par DÉFAUT : une occurrence
     * que personne n'a pointée est indiscernable d'une occurrence déclarée
     * impayée. Sans cette garde, la CA3 payée en juin mais jamais annotée — le
     * cas nominal, puisque l'écran d'annotation est facultatif — criait « en
     * retard de 55 jours » tous les matins. Un brief qui hurle au loup chaque
     * matin, on cesse de l'ouvrir en trois jours.
     *
     * La fenêtre ouverte, elle, n'a pas besoin d'annotation : l'échéance est
     * réellement due, personne ne peut affirmer le contraire.
     *
     * Le silence n'est pas une omission : le compte des occurrences passées non
     * pointées part en angle mort, avec de quoi agir.
     */
    const split = splitDeadlines(stillDue, todayIso);
    const key = (line: (typeof stillDue)[number]): string => `${line.obligationId}|${line.dueDate}`;
    const late = split.late.filter((line) => data.annotated.has(key(line)));
    const unpointed = split.late.length - late.length;
    if (unpointed > 0) {
      blindSpots.push({
        area: "échéancier",
        why: `${unpointed} échéance(s) passée(s) non pointée(s) : impossible de dire si elles sont payées`,
      });
    }
    const oldestLate = earliestDeadline(late);
    // Une fenêtre déjà ouverte passe devant une échéance encore à venir : elle
    // se referme la première.
    const openNow = earliestDeadline(split.windowOpen);
    const nextUp = openNow ?? earliestDeadline(split.upcoming);

    const brief = composeMorningBrief({
      pendingActions: data.pendingActions,
      documentsAVerifier: data.documentsAVerifier ?? 0,
      // « Regardé et vide » n'est PAS « pas regardé » : module allumé et aucune
      // affaire en perte reste un examen, avec un résultat.
      affairesEnPerte: data.affaires === null ? null : { count: losing.length, worst },
      budgetsDepasses: data.affaires === null ? null : overBudget,
      echeances:
        data.schedule === null
          ? null
          : {
              enRetard:
                oldestLate === null
                  ? null
                  : toEcheance(oldestLate, lateDaysOf(oldestLate, todayIso)),
              prochaine:
                nextUp === null
                  ? null
                  : nextUp === openNow
                    ? toEcheance(nextUp, 0, true)
                    : toEcheance(
                        nextUp,
                        Math.round(
                          (Date.parse(`${nextUp.dueDate}T00:00:00Z`) -
                            Date.parse(`${todayIso}T00:00:00Z`)) /
                            dayMs,
                        ),
                      ),
            },
      impayes:
        data.impayes === null
          ? null
          : {
              count: data.impayes._count._all,
              totalCents: Number(data.impayes._sum.residualCents ?? 0),
              // Un avertissement de rattachement veut dire qu'une retenue a pu
              // rester comptée en impayé : le qualificatif du montant doit
              // cesser d'affirmer le contraire. Filtre LARGE à dessein — tous
              // les avertissements de retenue ne portent pas sur les impayés,
              // mais nuancer à tort coûte infiniment moins cher qu'affirmer
              // « retenue exclue » sur un total qui en contient une.
              retentionDeducted: !(data.fecWarnings ?? []).some((warning) =>
                warning.includes("retenue"),
              ),
            },
      stockSousSeuil: data.stock === null ? null : (data.stock[0]?.count ?? 0),
      // Calculé à la LECTURE, comme le plan de chaque contrat : une valeur
      // stockée serait fausse dès le lendemain, et fausse en silence.
      contratsEchus:
        data.contrats === null
          ? null
          : summarizeDueContracts(data.contrats.slice(0, CONTRATS_BRIEF_LIMIT), todayIso),
      blindSpots,
    });

    return { ...brief, version: BRIEF_RULES_VERSION };
  });

  /*
   * ─────────────────────────────────────────────────────────────────────────
   * AFFAIRES (ticket 4.1) — le pivot du produit.
   *
   * Lecture et imputation sont ouvertes à TOUS LES MEMBRES : c'est l'employé de
   * terrain qui photographie une facture et la rattache au chantier, et lui
   * interdire l'imputation viderait la promesse du produit. Les MONTANTS, eux,
   * restent owner-only — même règle que le cockpit et la marge.
   * ─────────────────────────────────────────────────────────────────────────
   */

  app.get("/affaires", { preHandler: businessRoute }, async (request, reply) => {
    void reply.header("cache-control", "private, no-store");
    const query = z
      .object({
        statut: z.enum(AFFAIRE_STATUSES).optional(),
        // Les archivées sont RANGÉES, pas supprimées : on ne les montre que si
        // on les demande.
        inclureArchivees: z.enum(["true", "false"]).optional(),
      })
      .safeParse(request.query ?? {});
    if (!query.success) return reply.code(400).send({ error: "invalid query" });

    const includeArchived = query.data.inclureArchivees === "true";
    const where = query.data.statut
      ? { status: query.data.statut }
      : includeArchived
        ? {}
        : { status: { not: "ARCHIVEE" } };

    const { rows, profile } = await withTenant(request.tenantId, async (tx) => ({
      rows: await tx.affaire.findMany({ where, orderBy: [{ createdAt: "desc" }] }),
      profile: await tx.tenantProfile.findUnique({ where: { tenantId: request.tenantId } }),
    }));

    const isOwner = request.membershipRole === "owner";
    return {
      affaires: rows.map((affaire) => {
        const serialized = serializeAffaire(affaire);
        // Un membre voit ses chantiers et peut y rattacher des pièces ; il n'en
        // voit pas les montants.
        return isOwner
          ? serialized
          : {
              ...serialized,
              quotedAmountCents: null,
              estimatedMaterialCents: null,
              depositsCents: null,
            };
      }),
      // Le mot vient du vertical, pas du code — l'écran l'affiche tel quel.
      vertical: profile?.vertical ?? null,
      amountsVisible: isOwner,
    };
  });

  app.post("/affaires", { preHandler: ownerRoute }, async (request, reply) => {
    const body = AffaireCreateInput.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid body" });

    const year = new Date().getUTCFullYear();
    const created = await withTenant(request.tenantId, async (tx) => {
      // `prospectId` vient du client : il se contrôle contre CE tenant avant
      // d'être écrit. La clé étrangère composite l'empêche désormais en base,
      // mais un identifiant étranger doit produire un refus clair, pas une
      // erreur d'intégrité.
      if (body.data.prospectId) {
        const prospect = await tx.prospect.findUnique({
          where: { id: body.data.prospectId },
          select: { id: true },
        });
        if (!prospect) return null;
      }
      // La référence est réservée DANS la transaction de création : une
      // création qui échoue rend son numéro, deux créations simultanées n'ont
      // jamais la même.
      const reference = await nextAffaireReference(tx, request.tenantId, year);
      // Une affaire peut naître déjà terminée (saisie a posteriori d'un
      // chantier fait). Le fait vaut à la création comme à la transition.
      const completedAt = nextCompletedAt(body.data.status, null, new Date());
      return tx.affaire.create({
        data: {
          tenantId: request.tenantId,
          reference,
          ...toPrismaData(body.data),
          ...(completedAt === undefined ? {} : { completedAt }),
          label: body.data.label,
        },
      });
    });
    if (!created) return reply.code(404).send({ error: "prospect inconnu" });
    void reply.header("cache-control", "private, no-store");
    return reply.code(201).send(serializeAffaire(created));
  });

  /*
   * F4 — la marge de chaque chantier, dans le cockpit.
   *
   * Donnée financière agrégée du tenant : OWNER uniquement, même raisonnement
   * que la prévision de trésorerie et la page marge. Module `affaires` éteint
   * => la carte disparaît, comme les alertes de stock.
   */
  /*
   * ENCAISSÉ ≠ ACQUIS (4.2, bloc 3).
   *
   * Trois chiffres qui se ressemblent sur un relevé bancaire et qui ne disent
   * pas la même chose : ce qui est sur le compte, ce qui est vendu, ce qui est
   * livré. Le moteur (`splitRevenus`) refuse de les fondre, et cette route
   * refuse de rendre un écart entre l'encaissé (TTC) et l'acquis (HT) — leur
   * différence vaudrait à peu près la TVA, qui n'appartient pas à
   * l'entreprise.
   *
   * OWNER seulement, comme toute donnée financière agrégée du tenant.
   */
  app.get("/affaires/revenus", { preHandler: ownerRoute }, async (request, reply) => {
    void reply.header("cache-control", "private, no-store");
    if (!(await isModuleActive(request.tenantId, "affaires"))) {
      return reply.code(409).send({ error: "module désactivé" });
    }
    const split = await withTenant(request.tenantId, (tx) => loadRevenusSplit(tx));
    return split;
  });

  app.get("/affaires/marges", { preHandler: ownerRoute }, async (request, reply) => {
    void reply.header("cache-control", "private, no-store");
    if (!(await isModuleActive(request.tenantId, "affaires"))) {
      return reply.code(409).send({ error: "module désactivé" });
    }
    const view = await withTenant(request.tenantId, async (tx) => {
      const profile = await tx.tenantProfile.findUnique({
        where: { tenantId: request.tenantId },
      });
      const margins = await loadAffairesMargins(tx, profile?.hourlyCostCents ?? null);
      return {
        margins,
        hourlyCostKnown: (profile?.hourlyCostCents ?? null) !== null,
        vertical: profile?.vertical ?? null,
      };
    });
    return {
      aSurveiller: view.margins.aSurveiller,
      chiffrables: view.margins.chiffrables,
      // « Au mieux X » : à part, jamais compté avec les rentables.
      sousReserve: view.margins.sousReserve,
      // Comptées et NOMMÉES : une affaire dont on ne sait rien n'est pas une
      // affaire qui va bien.
      nonChiffrables: view.margins.nonChiffrables,
      ignorees: view.margins.ignorees,
      hourlyCostKnown: view.hourlyCostKnown,
      // Rendu ici pour que le cockpit n'ait pas à lire toute la table des
      // affaires juste pour connaître le mot à afficher.
      vertical: view.vertical,
    };
  });

  app.get("/affaires/:id", { preHandler: businessRoute }, async (request, reply) => {
    void reply.header("cache-control", "private, no-store");
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id" });

    const isOwner = request.membershipRole === "owner";
    const result = await withTenant(request.tenantId, async (tx) => {
      const affaire = await tx.affaire.findUnique({ where: { id: params.data.id } });
      if (!affaire) return null;
      const profile = await tx.tenantProfile.findUnique({
        where: { tenantId: request.tenantId },
      });
      const imputations = await tx.affaireImputation.findMany({
        where: { affaireId: affaire.id, revokedAt: null },
        orderBy: [{ createdAt: "desc" }],
      });
      const documents = await tx.classeurDocument.findMany({
        where: { affaireId: affaire.id },
        select: { id: true, fileName: true, docType: true, status: true, createdAt: true },
        orderBy: [{ createdAt: "desc" }],
      });
      /*
       * F6 — ce qui attend une DÉCISION sur ce chantier. OWNER SEULEMENT.
       *
       * Toute autre donnée financière de cette réponse est déjà gated (devis,
       * budget, acomptes, marge) ; « une relance dort sur ce chantier » en dit
       * autant qu'un montant : que ce client-là ne paie pas. Ne pas requêter
       * du tout pour un membre, plutôt que filtrer après coup.
       *
       * Le TOTAL est compté à part : la liste est bornée, et afficher « (20) »
       * pour un chantier qui en compte 30 serait un chiffre faux sur un écran
       * qui prétend compter.
       */
      const pendingActions = isOwner
        ? await tx.pendingAction.findMany({
            where: { affaireId: affaire.id, status: "pending" },
            select: { id: true, type: true, createdAt: true },
            orderBy: [{ createdAt: "desc" }],
            take: AFFAIRE_ACTIONS_LIMIT,
          })
        : [];
      const pendingActionsTotal = isOwner
        ? await tx.pendingAction.count({
            where: { affaireId: affaire.id, status: "pending" },
          })
        : 0;
      const margin = await loadAffaireMargin(tx, affaire.id, profile?.hourlyCostCents ?? null);
      return {
        affaire,
        imputations,
        documents,
        pendingActions,
        pendingActionsTotal,
        margin,
        profile,
      };
    });

    if (!result) return reply.code(404).send({ error: "affaire inconnue" });

    return {
      affaire: isOwner
        ? serializeAffaire(result.affaire)
        : {
            ...serializeAffaire(result.affaire),
            quotedAmountCents: null,
            estimatedMaterialCents: null,
            depositsCents: null,
          },
      vertical: result.profile?.vertical ?? null,
      amountsVisible: isOwner,
      // Le coût horaire manquant est la cause n°1 d'une marge en borne
      // supérieure : l'écran doit pouvoir le DIRE et proposer de le saisir.
      hourlyCostKnown: (result.profile?.hourlyCostCents ?? null) !== null,
      imputations: result.imputations.map((imputation) => ({
        id: imputation.id,
        targetType: imputation.targetType,
        targetId: imputation.targetId,
        source: imputation.source,
        subcontract: imputation.subcontract,
        amountCents:
          isOwner && imputation.amountCents !== null ? Number(imputation.amountCents) : null,
        amountBasis: imputation.amountBasis,
        createdAt: imputation.createdAt.toISOString(),
      })),
      documents: result.documents.map((document) => ({
        ...document,
        createdAt: document.createdAt.toISOString(),
      })),
      actionsAValider: result.pendingActions.map((action) => ({
        ...action,
        createdAt: action.createdAt.toISOString(),
      })),
      // Le total RÉEL, à côté de la page rendue : sans lui, un chantier qui
      // compte trente décisions en annoncerait vingt, sans un mot.
      actionsAValiderTotal: result.pendingActionsTotal,
      actionsAValiderRefus: isOwner ? null : "réservé au dirigeant",
      // Marge = donnée financière : owner uniquement, et le refus est MOTIVÉ.
      marge: isOwner ? (result.margin?.margin ?? null) : null,
      margeRefus: isOwner ? null : "réservé au dirigeant",
      invoicedCents: isOwner ? (result.margin?.invoicedCents ?? 0) : null,
    };
  });

  app.patch("/affaires/:id", { preHandler: ownerRoute }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id" });
    const body = AffaireUpdateInput.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid body" });

    const updated = await withTenant(request.tenantId, async (tx) => {
      const existing = await tx.affaire.findUnique({ where: { id: params.data.id } });
      if (!existing) return null;
      if (body.data.prospectId) {
        const prospect = await tx.prospect.findUnique({
          where: { id: body.data.prospectId },
          select: { id: true },
        });
        if (!prospect) return null;
      }
      /*
       * `completedAt` est DÉRIVÉ du statut, jamais reçu du client.
       *
       * L'exposer en entrée rouvrirait exactement le défaut d'`actualEndDate` :
       * un champ libre qu'on peut poser sur une affaire jamais livrée, et donc
       * compter à 100 % du devis en acquis. Le fait doit rester la conséquence
       * d'une transition, pas une saisie.
       */
      const completedAt = nextCompletedAt(
        body.data.status,
        existing.completedAt,
        new Date(),
      );
      return tx.affaire.update({
        where: { id: params.data.id },
        data: {
          ...toPrismaData(body.data),
          ...(completedAt === undefined ? {} : { completedAt }),
        },
      });
    });
    if (!updated) return reply.code(404).send({ error: "affaire ou prospect inconnu" });
    // Ces réponses portent le nom du client et les montants : jamais en cache.
    void reply.header("cache-control", "private, no-store");
    return serializeAffaire(updated);
  });

  // PAS de DELETE : des pièces comptables sont rattachées à une affaire, et une
  // suppression les orphelinerait ou, pire, les emporterait. Archiver la range
  // sans rien détacher — c'est la seule sortie prévue.
  app.post("/affaires/:id/archiver", { preHandler: ownerRoute }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id" });
    const archived = await withTenant(request.tenantId, async (tx) => {
      const existing = await tx.affaire.findUnique({ where: { id: params.data.id } });
      if (!existing) return null;
      /*
       * L'archivage traverse la MÊME dérivation que le reste — une règle, un
       * seul endroit.
       *
       * Écrire `status: "ARCHIVEE"` en dur donnait le bon résultat aujourd'hui
       * (la branche `ARCHIVEE` ne touche à rien), mais c'était le seul chemin
       * d'écriture du statut hors de la fonction : le jour où la règle bouge,
       * les tests unitaires de `nextCompletedAt` resteraient verts pendant que
       * la route la plus utilisée pour archiver divergerait en silence.
       *
       * Ranger n'est pas défaire : c'est ce qui permet à une affaire terminée
       * puis archivée de rester dans l'acquis.
       */
      const completedAt = nextCompletedAt("ARCHIVEE", existing.completedAt, new Date());
      return tx.affaire.update({
        where: { id: params.data.id },
        data: {
          status: "ARCHIVEE",
          ...(completedAt === undefined ? {} : { completedAt }),
        },
      });
    });
    if (!archived) return reply.code(404).send({ error: "affaire inconnue" });
    void reply.header("cache-control", "private, no-store");
    return serializeAffaire(archived);
  });

  /*
   * CONTRATS RÉCURRENTS (4.2, bloc 2) — une brique GÉNÉRIQUE.
   *
   * Contrat d'entretien d'un paysagiste, contrat de maintenance, forfait
   * mensuel de prestation : même mécanique — un départ, un pas, une fin
   * éventuelle. Écrire trois moteurs parce que le vocabulaire diffère, ce
   * serait le `if (vertical === …)` que l'ADR-007 interdit, déguisé en feature.
   *
   * Même gabarit d'autorisation que les affaires : LECTURE ouverte aux membres
   * (savoir qu'un passage est dû fait partie du travail de terrain), ÉCRITURE
   * réservée au dirigeant (le montant par période est une donnée commerciale).
   */
  /**
   * La fiche visée existe-t-elle DANS CE TENANT ?
   *
   * La FK composite `(tenant_id, prospect_id)` rend déjà la fuite impossible
   * en base — mais elle la rend impossible en levant, et une violation de
   * contrainte remonterait en 500 opaque. Un contrôle explicite rend un 400
   * motivé : un refus est une RÉPONSE, pas une panne. `undefined` = le champ
   * n'est pas dans la requête, `null` = on détache volontairement.
   */
  async function prospectExists(
    tx: Prisma.TransactionClient,
    prospectId: string | null | undefined,
  ): Promise<boolean> {
    if (prospectId === null || prospectId === undefined) return true;
    return (await tx.prospect.findUnique({ where: { id: prospectId } })) !== null;
  }

  app.get("/contrats", { preHandler: businessRoute }, async (request, reply) => {
    // Nom de client et montants : jamais de cache partagé.
    void reply.header("cache-control", "private, no-store");
    const today = todayCivilIso();
    const rows = await withTenant(request.tenantId, (tx) =>
      tx.contrat.findMany({
        orderBy: [{ status: "asc" }, { label: "asc" }],
        take: CONTRATS_BRIEF_LIMIT,
      }),
    );
    return { contrats: rows.map((row) => serializeContrat(row, today)) };
  });

  app.post("/contrats", { preHandler: ownerRoute }, async (request, reply) => {
    const body = ContratCreateInput.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid body" });
    // Un terme antérieur au départ ne décrit aucun contrat : le refuser tout de
    // suite vaut mieux qu'un plan vide que personne ne saurait expliquer.
    if (
      body.data.startDate &&
      body.data.endDate &&
      body.data.endDate < body.data.startDate
    ) {
      return reply.code(400).send({ error: "la fin précède le début" });
    }
    const today = todayCivilIso();
    const created = await withTenant(request.tenantId, async (tx) => {
      if (!(await prospectExists(tx, body.data.prospectId))) return null;
      return tx.contrat.create({
        data: {
          tenantId: request.tenantId,
          ...toContratData(body.data),
          label: body.data.label,
          cadence: body.data.cadence,
        },
      });
    });
    if (created === null) return reply.code(400).send({ error: "prospect inconnu" });
    void reply.header("cache-control", "private, no-store");
    return reply.code(201).send(serializeContrat(created, today));
  });

  app.patch("/contrats/:id", { preHandler: ownerRoute }, async (request, reply) => {
    const params = z.object({ id: Uuid }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id" });
    const body = ContratUpdateInput.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid body" });

    const today = todayCivilIso();
    const updated = await withTenant(request.tenantId, async (tx) => {
      const existing = await tx.contrat.findUnique({ where: { id: params.data.id } });
      if (!existing) return null;
      if (!(await prospectExists(tx, body.data.prospectId))) return "prospect" as const;
      const startDate = body.data.startDate ?? toCivilDate(existing.startDate);
      const endDate =
        body.data.endDate === undefined ? toCivilDate(existing.endDate) : body.data.endDate;
      if (startDate && endDate && endDate < startDate) return "incoherent" as const;
      return tx.contrat.update({
        where: { id: params.data.id },
        data: toContratData(body.data),
      });
    });
    if (updated === null) return reply.code(404).send({ error: "contrat inconnu" });
    if (updated === "prospect") return reply.code(400).send({ error: "prospect inconnu" });
    if (updated === "incoherent") {
      return reply.code(400).send({ error: "la fin précède le début" });
    }
    void reply.header("cache-control", "private, no-store");
    return serializeContrat(updated, today);
  });

  /*
   * Matérialiser les échéances dues en AFFAIRES.
   *
   * JAMAIS AUTOMATIQUE, et c'est le point du ticket. Un générateur de fond qui
   * créerait des chantiers tout seul remplirait la base de travail que
   * personne n'a décidé de faire — et le patron découvrirait douze affaires un
   * lundi matin sans savoir d'où elles viennent. L'assistant PRÉPARE (le plan
   * est calculé et affiché), l'humain VALIDE (il clique ici).
   *
   * IDEMPOTENT par `lastOccurrenceDate` : deux clics ne créent pas deux fois la
   * même intervention. La borne du moteur (`MAX_DUE_OCCURRENCES`) tient aussi
   * ici, et la troncature est DITE dans la réponse.
   */
  app.post("/contrats/:id/occurrences", { preHandler: ownerRoute }, async (request, reply) => {
    const params = z.object({ id: Uuid }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id" });
    const today = todayCivilIso();
    const year = Number(today.slice(0, 4));

    const outcome = await withTenant(
      request.tenantId,
      async (tx) => {
        /*
         * VERROU DE LIGNE avant toute lecture, et ce n'est pas de la ceinture
         * et bretelles.
         *
         * `withTenant` n'impose aucun niveau d'isolation : on est en READ
         * COMMITTED. Deux POST parallèles — un double-clic suffit — lisaient
         * tous deux `lastOccurrenceDate = null` et créaient DEUX FOIS les
         * mêmes interventions. Le verrou du compteur de références sérialise
         * les requêtes mais ne rafraîchit pas un contrat déjà lu, donc il ne
         * protégeait rien ici. Le test « deux clics » est séquentiel : il ne
         * pouvait pas voir ce cas.
         *
         * `FOR UPDATE` fait attendre la seconde transaction, qui relit alors
         * un `lastOccurrenceDate` à jour et ne trouve plus rien à faire.
         */
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM contrats WHERE id = ${params.data.id}::uuid FOR UPDATE`;
        if (locked.length === 0) return { code: 404 as const, error: "contrat inconnu" };
        const contrat = await tx.contrat.findUnique({ where: { id: params.data.id } });
        if (!contrat) return { code: 404 as const, error: "contrat inconnu" };
        // Un contrat suspendu ou terminé ne génère rien : le refus est une
        // RÉPONSE motivée, pas un 200 avec une liste vide.
        if (contrat.status !== "ACTIF") {
          return { code: 409 as const, error: `contrat ${contrat.status.toLowerCase()}` };
        }
        const serialized = serializeContrat(contrat, today);
        const due = serialized.plan.due;
        if (due.length === 0) {
          return { code: 200 as const, created: [], truncated: false, reason: null };
        }

        const created: { id: string; reference: string; startDate: string }[] = [];
        for (const occurrence of due) {
          const reference = await nextAffaireReference(tx, request.tenantId, year);
          const affaire = await tx.affaire.create({
            data: {
              tenantId: request.tenantId,
              reference,
              // Le LIBELLÉ porte la date : « Entretien Dupont — 2026-07-15 ».
              // Douze affaires au même nom seraient indiscernables dans une
              // liste, et le patron ne saurait pas laquelle il vient de faire.
              label: `${contrat.label} — ${occurrence}`,
              clientName: contrat.clientName,
              /*
               * Le nom est recopié — donc le LIEN doit l'être aussi.
               *
               * Sans lui, une affaire générée ne connaissait que son contrat :
               * `DELETE /prospects/:id`, qui cherche par fiche, ne la voyait
               * pas, et l'identité recopiée survivait à l'effacement. Copier
               * l'identité sans copier le moyen de l'effacer, c'est fabriquer
               * de la donnée orpheline à chaque clic.
               */
              prospectId: contrat.prospectId,
              contratId: contrat.id,
              status: "ACCEPTEE",
              // Montant de LA PÉRIODE, pas du contrat : c'est ce qui empêche
              // la marge de la première intervention d'avaler l'année entière.
              quotedAmountCents: contrat.amountCents,
              vatRateBps: contrat.vatRateBps,
              startDate: toDbDateRequired(occurrence),
            },
          });
          created.push({ id: affaire.id, reference, startDate: occurrence });
        }

        // `lastOccurrenceDate` avance jusqu'à la DERNIÈRE réellement créée :
        // en cas de troncature, le reste sera rattrapé au clic suivant plutôt
        // que perdu.
        const derniere = created[created.length - 1];
        if (derniere) {
          await tx.contrat.update({
            where: { id: contrat.id },
            data: { lastOccurrenceDate: toDbDateRequired(derniere.startDate) },
          });
        }

        return {
          code: 200 as const,
          created,
          truncated: serialized.plan.truncated,
          reason: serialized.plan.reason,
        };
      },
      { timeoutMs: 30_000 },
    );

    if (outcome.code !== 200) {
      return reply.code(outcome.code).send({ error: outcome.error });
    }
    void reply.header("cache-control", "private, no-store");
    return reply.send({
      created: outcome.created,
      truncated: outcome.truncated,
      reason: outcome.reason,
    });
  });

  /*
   * F2 — photo → imputation. SUGGESTION, jamais écriture.
   *
   * Cette route ne crée rien : elle propose. Une imputation posée
   * automatiquement entrerait dans le calcul de marge sans qu'aucun humain
   * l'ait validée — un coût inventé décidant d'un chiffre montré au patron.
   * L'acceptation passe par la route d'imputation normale, en `CONFIRMEE` :
   * l'écart entre CONFIRMEE et MANUELLE est la mesure de F2.
   */
  app.get(
    "/classeur/documents/:id/affaires-suggerees",
    { preHandler: businessRoute },
    async (request, reply) => {
      void reply.header("cache-control", "private, no-store");
      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "invalid id" });

      const outcome = await withTenant(request.tenantId, async (tx) => {
        const document = await tx.classeurDocument.findUnique({
          where: { id: params.data.id },
          select: { id: true, extraction: true, affaireId: true },
        });
        if (!document) return null;

        const affaires = await tx.affaire.findMany({
          take: AFFAIRE_SUGGESTION_MAX_AFFAIRES,
          orderBy: [{ createdAt: "desc" }],
          where: { status: { notIn: ["ARCHIVEE", "PERDUE", "TERMINEE"] } },
          select: {
            id: true,
            reference: true,
            label: true,
            status: true,
            startDate: true,
            plannedEndDate: true,
            actualEndDate: true,
          },
        });

        // Aucune affaire ouverte : inutile de payer la lecture de l'historique
        // pour répondre « rien à proposer ». C'est le cas de tout tenant qui
        // n'utilise pas encore les affaires, donc le cas le plus fréquent.
        if (affaires.length === 0) {
          return {
            alreadyImputed: false,
            result: suggestAffaires({ supplierName: null, docDate: null }, [], []),
          };
        }

        // Historique : ce que CE tenant a rattaché lui-même. Dérivé à la
        // lecture, jamais stocké, jamais partagé — la mémoire d'un tenant ne
        // sort pas de son tenant (règle 7).
        //
        // BORNÉ, comme la mémoire fournisseur du classeur (`MEMORY_WINDOW`) :
        // sans `take`, un tenant à 10 000 imputations désérialiserait 10 000
        // extractions JSON à chaque clic, et un `IN` de cette taille finit par
        // dépasser la limite de paramètres de Postgres. Les rattachements
        // récents sont aussi les plus informatifs.
        const imputations = await tx.affaireImputation.findMany({
          take: AFFAIRE_SUGGESTION_HISTORY_WINDOW,
          orderBy: [{ createdAt: "desc" }],
          where: { targetType: "classeur_document", revokedAt: null },
          select: { targetId: true, affaireId: true },
        });
        const documents =
          imputations.length === 0
            ? []
            : await tx.classeurDocument.findMany({
                where: { id: { in: imputations.map((row) => row.targetId) } },
                select: { id: true, extraction: true },
              });
        const supplierOf = new Map(
          documents.map((row) => [row.id, extractionField(row.extraction, "supplierName")]),
        );

        const day = (date: Date | null): string | null =>
          date === null ? null : date.toISOString().slice(0, 10);

        return {
          alreadyImputed: document.affaireId !== null,
          result: suggestAffaires(
            {
              supplierName: extractionField(document.extraction, "supplierName"),
              docDate: extractionField(document.extraction, "docDate"),
            },
            affaires.map((affaire) => ({
              id: affaire.id,
              reference: affaire.reference,
              label: affaire.label,
              status: affaire.status,
              startDate: day(affaire.startDate),
              plannedEndDate: day(affaire.plannedEndDate),
              actualEndDate: day(affaire.actualEndDate),
            })),
            buildSupplierHistory(
              imputations.map((row) => ({
                supplierName: supplierOf.get(row.targetId) ?? null,
                affaireId: row.affaireId,
              })),
            ),
          ),
        };
      });

      if (!outcome) return reply.code(404).send({ error: "document inconnu" });
      // Une pièce déjà rattachée n'a pas besoin d'être suggérée : proposer de
      // la rattacher ailleurs inviterait à une double imputation.
      if (outcome.alreadyImputed) {
        return {
          kind: "abstention",
          why: "deja_rattachee",
          version: AFFAIRE_SUGGESTION_RULES_VERSION,
        };
      }
      return { ...outcome.result, version: AFFAIRE_SUGGESTION_RULES_VERSION };
    },
  );

  app.post("/affaires/:id/imputations", { preHandler: businessRoute }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id" });
    const body = AffaireImputeInput.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid body" });
    // Un montant sans base (HT/TTC) est un nombre dont on ignore ce qu'il
    // mesure : refusé ici comme en base.
    if (!imputationAmountIsCoherent(body.data)) {
      return reply.code(400).send({ error: "montant sans base HT/TTC" });
    }
    // `AUTO` = imputation posée sans validation humaine. Rien n'a le droit d'en
    // écrire une : elle entrerait dans le calcul de marge, et un coût que
    // personne n'a validé déciderait d'un chiffre montré au patron. La doc de
    // F2 le PROMET — le refus le rend vrai.
    if (body.data.source === "AUTO") {
      return reply.code(400).send({ error: "imputation automatique interdite sans validation" });
    }

    const outcome = await withTenant(request.tenantId, async (tx) => {
      const affaire = await tx.affaire.findUnique({ where: { id: params.data.id } });
      if (!affaire) return { kind: "not-found" as const };
      const active = await tx.affaireImputation.findFirst({
        where: { targetType: body.data.targetType, targetId: body.data.targetId, revokedAt: null },
      });
      // Une même dépense dans deux chantiers, ce sont deux marges fausses —
      // dans le sens flatteur, celui qu'on ne vérifie pas.
      if (active) return { kind: "conflict" as const, affaireId: active.affaireId };

      // La cible doit EXISTER, et sous RLS donc appartenir à ce tenant. Sans ce
      // contrôle, un identifiant inexistant (ou d'un autre tenant, invisible
      // ici) créait quand même l'imputation avec le montant fourni par
      // l'appelant : un coût FABRIQUÉ entrait dans la marge du dirigeant, et la
      // route répondait 201. Les transactions bancaires échappent au contrôle
      // — elles ne sont pas stockées — et c'est dit dans la doc.
      if (body.data.targetType === "classeur_document") {
        const document = await tx.classeurDocument.findUnique({
          where: { id: body.data.targetId },
          select: { id: true },
        });
        if (!document) return { kind: "unknown-target" as const };
      }
      if (body.data.targetType === "facture") {
        const invoice = await tx.fecInvoice.findUnique({
          where: { id: body.data.targetId },
          select: { id: true },
        });
        if (!invoice) return { kind: "unknown-target" as const };
      }

      const imputation = await tx.affaireImputation.create({
        data: {
          tenantId: request.tenantId,
          affaireId: affaire.id,
          targetType: body.data.targetType,
          targetId: body.data.targetId,
          source: body.data.source ?? "MANUELLE",
          subcontract: body.data.subcontract ?? false,
          amountCents:
            body.data.amountCents === null || body.data.amountCents === undefined
              ? null
              : BigInt(body.data.amountCents),
          amountBasis: body.data.amountBasis ?? null,
          createdBy: request.authSession.user.id,
        },
      });
      // Rattachement RÉTROACTIF : la pièce existante porte aussi le lien, pour
      // que l'écran classeur le montre sans jointure supplémentaire. PAS de
      // `.catch` muet : un échec ici doit annuler la transaction, sinon
      // l'imputation existerait sans que la pièce le sache.
      if (body.data.targetType === "classeur_document") {
        await tx.classeurDocument.update({
          where: { id: body.data.targetId },
          data: { affaireId: affaire.id },
        });
      }
      if (body.data.targetType === "facture") {
        await tx.fecInvoice.update({
          where: { id: body.data.targetId },
          data: { affaireId: affaire.id },
        });
      }
      return { kind: "ok" as const, imputation };
    });

    if (outcome.kind === "not-found") return reply.code(404).send({ error: "affaire inconnue" });
    if (outcome.kind === "unknown-target") {
      return reply.code(404).send({ error: "pièce inconnue" });
    }
    if (outcome.kind === "conflict") {
      return reply.code(409).send({ error: "pièce déjà imputée", affaireId: outcome.affaireId });
    }
    return reply.code(201).send({ id: outcome.imputation.id });
  });

  app.delete(
    "/affaires/:id/imputations/:imputationId",
    { preHandler: businessRoute },
    async (request, reply) => {
      const params = z
        .object({ id: z.string().uuid(), imputationId: z.string().uuid() })
        .safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "invalid id" });

      const revoked = await withTenant(request.tenantId, async (tx) => {
        const imputation = await tx.affaireImputation.findUnique({
          where: { id: params.data.imputationId },
        });
        if (!imputation || imputation.affaireId !== params.data.id) return null;
        if (imputation.revokedAt !== null) return imputation;
        // RÉVOQUER, pas supprimer : la ligne explique un chiffre a posteriori
        // et nourrira l'apprentissage de l'imputation automatique (F2).
        const updated = await tx.affaireImputation.update({
          where: { id: imputation.id },
          data: { revokedAt: new Date(), revokedBy: request.authSession.user.id },
        });
        // Le document a pu être supprimé entre-temps (droit à l'effacement) :
        // `updateMany` ne jette pas sur zéro ligne, là où `update` annulerait la
        // révocation. On détache ce qui existe encore, sans mentir sur le reste.
        if (imputation.targetType === "classeur_document") {
          await tx.classeurDocument.updateMany({
            where: { id: imputation.targetId },
            data: { affaireId: null },
          });
        }
        if (imputation.targetType === "facture") {
          await tx.fecInvoice.updateMany({
            where: { id: imputation.targetId },
            data: { affaireId: null },
          });
        }
        return updated;
      });
      if (!revoked) return reply.code(404).send({ error: "imputation inconnue" });
      return { revoked: true };
    },
  );

  return app;
}
