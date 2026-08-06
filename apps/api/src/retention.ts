import { prisma, withTenant } from "@nodaq/db";
import type { Prisma } from "@nodaq/db";
import { conversationCutoff, retentionVerdict } from "@nodaq/shared";

/**
 * Horizon des événements TRANSMIS. Court : leur seule utilité résiduelle est
 * le diagnostic d'un incident récent, et ils portent des identifiants d'objets
 * qui ont pu être effacés depuis.
 */
export const OUTBOX_RETENTION_DAYS = 7;
import type { RetentionCandidate } from "@nodaq/shared";

/*
 * Rétention de la file de validation (RGPD art. 5.1.e — limitation de la
 * conservation).
 *
 * CE QUI MANQUAIT. Le produit réduisait le contenu d'une action à DEUX
 * moments : quand elle est décidée (`reduceFinishedPayload`,
 * `reduceQuotePayload`) et quand sa source est effacée (purge FEC, classeur,
 * prospect — ticket art. 17). Restait un trou que la revue de la dictée a
 * nommé : une proposition **jamais décidée, dont la source n'est jamais
 * effacée**, gardait son payload indéfiniment. Un brouillon de relance nomme
 * un client et son montant dû ; une dictée en porte le verbatim intégral.
 *
 * Ce n'est pas propre à la dictée : c'est vrai de tous les types d'action,
 * depuis toujours. D'où un balayage, et pas une rustine dans un ticket.
 *
 * TROIS PROPRIÉTÉS NON NÉGOCIABLES :
 *
 * - le balayage passe par `withTenant`, tenant par tenant. Il serait tentant
 *   d'écrire un seul `updateMany` global avec le client admin — ce serait la
 *   seule écriture du produit à contourner la RLS, dans le job le moins
 *   surveillé ;
 * - un tenant en erreur n'arrête jamais les autres, et l'erreur remonte par
 *   son NOM seulement : le message pourrait citer un payload ;
 * - **le balayage AVANCE**. Aucune ligne ne peut occuper indéfiniment sa
 *   place de tête (voir la pagination par curseur ci-dessous) : rien n'est
 *   supprimé de `pending_actions`, donc une borne de lecture posée sur les N
 *   plus anciennes se serait remplie de lignes déjà traitées, et tout ce qui
 *   arrive ensuite aurait échappé à la rétention pour toujours, en silence.
 */

/** Ce qu'un passage a fait, par tenant — compteurs seulement. */
export interface RetentionSweepResult {
  readonly rejected: number;
  readonly reduced: number;
  /** Lignes EXAMINÉES (pas modifiées) — le dénominateur des deux ci-dessus. */
  readonly scanned: number;
  /** Types hors catalogue rencontrés : signalés, jamais détruits. */
  readonly unclassified: readonly string[];
  /**
   * Transcriptions d'agent SUPPRIMÉES (art. 5.1.e).
   *
   * `agent_conversations.messages` porte le fil complet, résultats d'outils
   * compris : noms de clients, montants dus, libellés de compte. Et son seul
   * usage — reprendre la conversation — meurt avec l'onglet, l'identifiant
   * n'étant persisté nulle part. Ces lignes devenaient donc illisibles à vie
   * sans que rien ne les efface.
   */
  readonly conversationsSupprimees: number;
  /**
   * Des transcriptions dormantes restent, la borne du passage étant atteinte.
   * Distinct de `truncated`, qui ne parle que des propositions : un seul
   * drapeau enverrait chercher au mauvais endroit.
   */
  readonly conversationsTruncated: boolean;
  /**
   * Événements TRANSMIS supprimés (art. 5.1.e).
   *
   * `outbox` ne perdait jamais une ligne : le relais posait `delivered_at` et
   * s'arrêtait là. La table grossissait donc sans fin, en conservant les
   * `object_id` d'objets par ailleurs effacés — « effacer une source efface ce
   * qui en DÉRIVE » vaut aussi pour un journal d'événements.
   */
  readonly outboxSupprimes: number;
  /**
   * Le balayage s'est arrêté sur sa borne : des lignes n'ont PAS été
   * examinées. Ce qui n'est pas calculé est DIT — un balayage tronqué qui se
   * tairait laisserait croire que le tenant est à jour.
   */
  readonly truncated: boolean;
}

/**
 * Une page = une transaction courte. Pas de « tout le tenant en un seul
 * `withTenant` » : ce serait la plus longue transaction du produit, elle
 * dépasserait le timeout par défaut sur les gros arriérés, et le rollback
 * annulerait le passage ENTIER — donc les tenants les plus en retard seraient
 * précisément ceux qu'on ne balaierait jamais.
 */
export const RETENTION_PAGE_SIZE = 200;

/** Coût borné d'un passage, par tenant. Atteinte ⇒ `truncated: true`. */
export const RETENTION_MAX_PAGES = 250;

const PAGE_TIMEOUT_MS = 30_000;

/**
 * Ce que devient un payload réduit : **rien du précédent**.
 *
 * Même forme que `reduceDerivedProposals` (art. 17), délibérément. La
 * tentation était d'en garder « ce qui n'identifie personne » — la provenance,
 * le nombre de lignes. Aucun écran ne les lit : une action réduite est
 * toujours décidée (rejeter et réduire vont ensemble), et le détail n'est
 * ouvrable que sur les actions en attente. Garder un champ dont personne ne
 * fait rien, c'est garder une donnée sans finalité — exactement ce que
 * l'article 5.1.e interdit.
 *
 * Ne survit donc que ce qui explique la ligne : qu'elle a été réduite, et
 * pourquoi. `reducedAt` porte en plus une fonction technique — c'est le
 * marqueur, écrit par ce seul balayage, sur lequel la lecture s'exclut
 * elle-même (voir `readPage`).
 */
function reducedPayload(reason: string, now: Date): Prisma.InputJsonValue {
  return { reduced: true, reducedReason: reason, reducedAt: now.toISOString() };
}

/** Une ligne candidate. Le PAYLOAD n'est jamais lu — voir `readPage`. */
interface RetentionRow {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/*
 * LECTURE EN SQL EXPLICITE, et ce n'est pas un caprice.
 *
 * Deux raisons, dans cet ordre.
 *
 * 1. `payload->'reducedAt' IS NULL` ne s'exprime pas en Prisma. Les deux
 *    formulations disponibles — `not: true` et `NOT: { equals: true }` —
 *    produisent une comparaison SQL ordinaire, or sur une ligne où la clé est
 *    ABSENTE, `payload->'…'` vaut NULL : `NULL <> 'true'` vaut NULL, donc la
 *    ligne est écartée. Écartées, elles l'étaient TOUTES, c'est-à-dire
 *    exactement celles qu'il fallait traiter — constaté en test, `scanned`
 *    tombait à zéro et rien n'était plus jamais réduit.
 *
 *    Ce filtre est ce qui fait RÉTRÉCIR la tête de file. Le curseur seul
 *    suffisait à traverser un passage, pas à empêcher la famine : passé
 *    `maxPages × pageSize` lignes, chaque passage aurait re-balayé la même
 *    tête et plus rien de récent n'aurait été examiné.
 *
 *    LE MARQUEUR EST `reducedAt`, PAS `reduced`, et la nuance porte tout le
 *    filet de l'article 5.1.e. `reduced: true` est écrit par CINQ endroits
 *    (table complète dans `docs/retention-file-validation.md`), et un seul
 *    réduit jusqu'au bout — celui-ci. `reduceFinishedPayload` laisse
 *    `invoiceNumber`, `grossCents`, `label` sur un `submit_einvoice`, et
 *    `prospectId`/`stage` sur une relance prospect — y compris après une
 *    OPPOSITION ; `reduceQuotePayload` laisse `source`/`lines` ;
 *    `rejectProspectDrafts` laisse `prospectId`. Filtrer sur `reduced` aurait
 *    rendu ces résidus structurellement inatteignables : la borne d'un an ne
 *    les aurait jamais revus, alors qu'elle existe précisément pour eux.
 *    `reducedAt` n'est écrit que par ce balayage, donc lui seul s'exclut
 *    lui-même.
 *
 * 2. On ne charge plus le payload du tout. Le verdict ne dépend que du type,
 *    du statut et des dates ; faire transiter des brouillons nominatifs et
 *    des verbatims de dictée par la mémoire d'une tâche de fond pour n'en
 *    lire qu'un booléen était du contenu sensible manipulé sans finalité.
 *
 * La RLS s'applique identiquement : on est dans `withTenant`, sous `app_user`.
 */
async function readPage(
  tx: Prisma.TransactionClient,
  at: { createdAt: Date; id: string } | null,
): Promise<RetentionRow[]> {
  const rows =
    at === null
      ? await tx.$queryRaw<
          { id: string; type: string; status: string; created_at: Date; updated_at: Date }[]
        >`SELECT id, type, status, created_at, updated_at
            FROM pending_actions
           WHERE (payload->'reducedAt') IS NULL
           ORDER BY created_at ASC, id ASC
           LIMIT ${RETENTION_PAGE_SIZE}`
      : await tx.$queryRaw<
          { id: string; type: string; status: string; created_at: Date; updated_at: Date }[]
        >`SELECT id, type, status, created_at, updated_at
            FROM pending_actions
           WHERE (payload->'reducedAt') IS NULL
             AND (created_at, id) > (${at.createdAt}, ${at.id}::uuid)
           ORDER BY created_at ASC, id ASC
           LIMIT ${RETENTION_PAGE_SIZE}`;
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/** Reste-t-il une ligne à examiner après ce curseur ? Une seule ligne suffit. */
async function hasMore(
  tenantId: string,
  at: { createdAt: Date; id: string } | null,
): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const rows =
      at === null
        ? await tx.$queryRaw<{ one: number }[]>`SELECT 1 AS one
              FROM pending_actions
             WHERE (payload->'reducedAt') IS NULL
             LIMIT 1`
        : await tx.$queryRaw<{ one: number }[]>`SELECT 1 AS one
              FROM pending_actions
             WHERE (payload->'reducedAt') IS NULL
               AND (created_at, id) > (${at.createdAt}, ${at.id}::uuid)
             LIMIT 1`;
    return rows.length > 0;
  });
}

/**
 * Applique la politique de rétention à UN tenant.
 *
 * IDEMPOTENT, et il faut savoir PAR QUOI : par le filtre
 * `payload->'reducedAt' IS NULL` de `readPage`/`hasMore`, et par lui seul.
 * `retentionVerdict` ne sait plus rien de la réduction — sa garde « déjà
 * réduite » portait sur un champ que ce fichier codait à `false` en dur, donc
 * elle ne protégeait rien. Retirer le filtre SQL en croyant la règle pure
 * protégée casserait d'un coup l'idempotence ET la propriété anti-famine.
 */
export async function sweepTenantRetention(
  tenantId: string,
  now = new Date(),
  options: {
    /**
     * Réglable pour que la troncature soit TESTABLE : sans ça, il faudrait
     * 50 000 lignes pour éprouver le seul chemin qui décide qu'un tenant reste
     * en retard, et personne ne l'écrirait.
     */
    readonly maxPages?: number;
    /**
     * Point d'interception entre la LECTURE d'une page et ses écritures.
     * Jamais passé en production — il n'existe que pour rendre éprouvable la
     * garde d'écriture conditionnelle ci-dessous.
     *
     * Sans lui, remplacer `where: { id, status, updatedAt }` par
     * `where: { id }` laissait toute la suite verte, alors que la régression
     * protégée est silencieuse ET destructive : le balayage écrase le
     * brouillon qu'un humain vient d'enregistrer. Une propriété que le doc
     * appelle « le clic humain gagne » ne peut pas reposer sur une relecture.
     *
     * La course est réelle et non simulée : la lecture ne pose aucun verrou
     * (pas de `FOR UPDATE`), donc une transaction concurrente peut bel et bien
     * s'intercaler ici et valider avant que l'écriture ne parte.
     *
     * CONTRAINTE D'USAGE : il est attendu PENDANT la transaction de page, sous
     * son délai de 30 s. N'y jamais ouvrir de `withTenant` ni rien qui prenne
     * une connexion du même pool — une page tient déjà la sienne, et un
     * callback qui en demanderait une seconde peut épuiser le pool.
     */
    readonly onPageRead?: () => Promise<void>;
    /** Réglable pour que l'horizon soit testable sans attendre trente jours. */
    readonly conversationRetentionDays?: number;
    /**
     * Réglable pour que la TRONCATURE des transcriptions soit éprouvable :
     * sans ça, il faudrait semer deux cents fils pour toucher la seule branche
     * qui décide qu'un tenant reste en retard, et personne ne l'écrirait.
     */
    readonly conversationPageSize?: number;
  } = {},
): Promise<RetentionSweepResult> {
  const maxPages = options.maxPages ?? RETENTION_MAX_PAGES;
  const conversationDays = options.conversationRetentionDays;
  const conversationPageSize = options.conversationPageSize ?? RETENTION_PAGE_SIZE;
  let rejected = 0;
  let reduced = 0;
  let scanned = 0;
  let truncated = false;
  const unclassified = new Set<string>();

  /*
   * PAGINATION PAR CURSEUR sur `(createdAt, id)`, et c'est la propriété qui
   * fait tenir tout le reste.
   *
   * `pending_actions` ne perd jamais de ligne : réduire ne supprime pas. Une
   * lecture « les 1 000 plus anciennes » se serait donc figée sur une tête de
   * file composée de lignes déjà réduites et de types hors catalogue — ces
   * derniers gardant leur place À VIE puisqu'on refuse de les détruire. Passé
   * ce seuil, plus rien de neuf n'aurait jamais été examiné, sans une erreur
   * ni un compteur pour le dire.
   *
   * Le curseur, lui, avance quoi qu'il arrive. `(createdAt, id)` parce que
   * `createdAt` seul n'est pas unique (un import en crée plusieurs dans la
   * même milliseconde) et qu'un curseur non strictement ordonné saute des
   * lignes.
   */
  type Cursor = { createdAt: Date; id: string };
  type Page = { size: number; last: Cursor | null };
  let cursor: Cursor | null = null;

  for (let page = 0; ; page += 1) {
    if (page >= maxPages) {
      // Ne PAS crier au loup : `truncated` n'est vrai que s'il reste vraiment
      // quelque chose. Un tenant dont le nombre de lignes tombe pile sur
      // `maxPages × pageSize` est complet, et un avertissement de famine émis
      // à tort dévalue le seul signal qui compte.
      truncated = await hasMore(tenantId, cursor);
      break;
    }

    const at = cursor;
    const batch: Page = await withTenant(
      tenantId,
      async (tx): Promise<Page> => {
        const actions = await readPage(tx, at);
        if (options.onPageRead) await options.onPageRead();

        for (const action of actions) {
          const candidate: RetentionCandidate = {
            type: action.type,
            status: action.status,
            // Dernière trace humaine. `updatedAt` est en principe ≥
            // `createdAt` ; le max protège des lignes écrites avant que la
            // colonne existe, dont la valeur pourrait être antérieure.
            lastActivityAt:
              action.updatedAt > action.createdAt ? action.updatedAt : action.createdAt,
          };
          const verdict = retentionVerdict(candidate, now);

          if (verdict.action === "garder") continue;
          if (verdict.action === "signaler") {
            unclassified.add(action.type);
            continue;
          }

          /*
           * Écriture CONDITIONNELLE sur ce qui a été LU — statut ET
           * `updatedAt`. Le statut seul ne suffisait pas : deux routes
           * réécrivent une action en la laissant `pending` (reprise du
           * brouillon, rattachement à un chantier). Une reprise arrivée entre
           * la lecture et l'écriture serait passée à travers le filtre, et le
           * balayage aurait écrasé le texte que le dirigeant venait
           * d'enregistrer. `updatedAt` bouge à chacune de ces écritures : le
           * comparer rend la course visible, et le clic humain gagne.
           */
          const { count } = await tx.pendingAction.updateMany({
            where: { id: action.id, status: action.status, updatedAt: action.updatedAt },
            data: {
              ...(verdict.action === "rejeter_et_reduire" ? { status: "rejected" } : {}),
              payload: reducedPayload(verdict.reason, now),
            },
          });
          if (count === 0) continue;
          if (verdict.action === "rejeter_et_reduire") rejected += 1;
          else reduced += 1;
        }

        return { size: actions.length, last: actions.at(-1) ?? null };
      },
      { timeoutMs: PAGE_TIMEOUT_MS },
    );

    scanned += batch.size;
    if (batch.last === null || batch.size < RETENTION_PAGE_SIZE) break;
    cursor = { createdAt: batch.last.createdAt, id: batch.last.id };
  }

  /*
   * TRANSCRIPTIONS D'AGENT — supprimées, pas réduites.
   *
   * Une `pending_action` garde sa ligne parce qu'elle porte la trace d'une
   * DÉCISION humaine. Une transcription n'en porte aucune : les actions
   * qu'elle a préparées vivent dans la file avec leur propre trace, et la
   * métadonnée d'exécution est déjà tracée hors base. Garder une ligne vidée
   * n'apporterait qu'un compteur — une donnée sans finalité, ce que l'article
   * 5.1.e interdit précisément.
   *
   * PAGINÉ, comme le reste. `deleteMany` sur un arriéré de plusieurs dizaines
   * de milliers de fils serait la plus longue transaction du produit, et son
   * rollback annulerait le passage entier — donc les tenants les plus en
   * retard seraient exactement ceux qu'on ne balaierait jamais. Ici la
   * pagination n'a pas besoin de curseur : chaque page RETIRE ses lignes, donc
   * la suivante avance par construction.
   */
  const seuil =
    conversationDays === undefined ? conversationCutoff(now) : conversationCutoff(now, conversationDays);
  const outboxSeuil = new Date(now.getTime() - OUTBOX_RETENTION_DAYS * 86_400_000);
  let conversationsSupprimees = 0;
  let conversationsTruncated = false;
  for (let page = 0; page < maxPages; page += 1) {
    const supprimees = await withTenant(
      tenantId,
      (tx) =>
        tx.$executeRaw`
          DELETE FROM agent_conversations
          WHERE id IN (
            SELECT id FROM agent_conversations
            WHERE updated_at < ${seuil}
            ORDER BY updated_at ASC
            LIMIT ${conversationPageSize}
          )`,
      { timeoutMs: PAGE_TIMEOUT_MS },
    );
    conversationsSupprimees += supprimees;
    if (supprimees < conversationPageSize) break;
    /*
     * Borne atteinte : reste-t-il vraiment du travail ?
     *
     * Un drapeau posé sur « la dernière page était pleine » criait au loup
     * quand le nombre de lignes éligibles tombait pile sur un multiple de la
     * page. On SONDE — une ligne suffit. Et le drapeau est distinct de celui
     * des propositions : partagé, il ferait journaliser « des actions n'ont
     * pas été examinées » pour un arriéré de transcriptions, c'est-à-dire
     * envoyer chercher au mauvais endroit.
     */
    if (page === maxPages - 1) {
      const reste = await withTenant(tenantId, (tx) =>
        tx.agentConversation.findFirst({
          where: { updatedAt: { lt: seuil } },
          select: { id: true },
        }),
      );
      conversationsTruncated = reste !== null;
    }
  }

  /*
   * Un événement TRANSMIS a fini son office : il n'a plus d'abonné à servir,
   * et le rejeu ne remonte jamais au-delà de la dernière page. Les
   * non-transmis ne sont JAMAIS supprimés — les effacer serait perdre une
   * invalidation qu'on n'a pas encore su livrer.
   */
  let outboxSupprimes = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const supprimes = await withTenant(
      tenantId,
      (tx) =>
        tx.$executeRaw`
          DELETE FROM outbox
          WHERE id IN (
            SELECT id FROM outbox
            WHERE delivered_at IS NOT NULL AND delivered_at < ${outboxSeuil}
            ORDER BY delivered_at ASC
            LIMIT ${RETENTION_PAGE_SIZE}
          )`,
      { timeoutMs: PAGE_TIMEOUT_MS },
    );
    outboxSupprimes += supprimes;
    if (supprimes < RETENTION_PAGE_SIZE) break;
  }

  return {
    rejected,
    reduced,
    scanned,
    outboxSupprimes,
    unclassified: [...unclassified],
    truncated,
    conversationsSupprimees,
    conversationsTruncated,
  };
}

export interface RetentionSweepOptions {
  /** Cadence (défaut : 24 h — la rétention se compte en jours). */
  intervalMs?: number;
  /**
   * Délai avant le PREMIER passage (défaut : 30 s). Il existe pour ne pas
   * disputer le démarrage de l'API, pas pour retarder la rétention.
   */
  startDelayMs?: number;
  /**
   * Reçoit le NOM de l'erreur et le tenant concerné — jamais le message, qui
   * pourrait citer un payload. Un identifiant de tenant est un UUID opaque :
   * sans lui, un tenant dont la rétention échoue à chaque passage serait
   * indiscernable d'un tenant propre, et le resterait indéfiniment.
   */
  onError?: (name: string, tenantId?: string) => void;
  /** Compte rendu d'un passage — compteurs et types, jamais de contenu. */
  onSweep?: (
    result: RetentionSweepResult & {
      tenants: number;
      failed: number;
      /**
       * Tenants dont le passage s'est arrêté sur sa borne, NOMMÉS.
       *
       * Même raison que le `tenantId` sur `onError` : un tenant affamé
       * seulement compté « quelque part » est signalé mais introuvable, donc
       * jamais réparé. Ce sont des UUID opaques, pas des données.
       */
      truncatedTenants: readonly string[];
    },
  ) => void;
}

/**
 * Ordonnanceur en processus, même patron que `startPushSweep` : timer
 * `unref()` (il ne retient jamais le process), passage non réentrant, et
 * chaque rejet attrapé — une tâche de fond ne doit pas pouvoir tuer l'API par
 * `unhandledRejection`.
 *
 * UN PASSAGE AU DÉMARRAGE, en plus du timer. « Inconditionnel » ne veut rien
 * dire si le balayage n'a lieu qu'au bout de 24 heures : une API redéployée
 * plus souvent que ça — le cas normal en phase de livraison — n'aurait jamais
 * balayé une seule fois, et personne ne l'aurait vu. Le refaire à chaque
 * démarrage ne coûte qu'une lecture, puisque le passage est idempotent : une
 * action déjà réduite rend « garder ».
 */
export function startRetentionSweep(options: RetentionSweepOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? 24 * 60 * 60_000;
  const onError = options.onError ?? (() => undefined);
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const tenants = await prisma.tenant.findMany({ select: { id: true } });
      let rejected = 0;
      let reduced = 0;
      let scanned = 0;
      let conversationsSupprimees = 0;
      let conversationsTruncated = false;
      let outboxSupprimes = 0;
      let failed = 0;
      let truncated = false;
      const truncatedTenants: string[] = [];
      const unclassified = new Set<string>();
      for (const tenant of tenants) {
        try {
          const result = await sweepTenantRetention(tenant.id, now);
          rejected += result.rejected;
          reduced += result.reduced;
          scanned += result.scanned;
          conversationsSupprimees += result.conversationsSupprimees;
          conversationsTruncated ||= result.conversationsTruncated;
          outboxSupprimes += result.outboxSupprimes;
          truncated ||= result.truncated;
          if (result.truncated) truncatedTenants.push(tenant.id);
          for (const type of result.unclassified) unclassified.add(type);
        } catch (error) {
          /*
           * Un tenant cassé n'arrête pas les autres — mais jamais en silence,
           * et jamais sans dire LEQUEL. Un échec seulement compté « quelque
           * part » laisse la rétention d'un tenant tomber à chaque passage
           * sans que personne puisse le retrouver.
           */
          failed += 1;
          onError(error instanceof Error ? error.name : "Error", tenant.id);
        }
      }
      // Ce qui est fait est DIT : un balayage qui rejette des propositions
      // sans laisser de trace serait indistinguable d'une perte de données.
      options.onSweep?.({
        rejected,
        reduced,
        scanned,
        conversationsSupprimees,
        conversationsTruncated,
        outboxSupprimes,
        truncated,
        truncatedTenants,
        failed,
        unclassified: [...unclassified],
        tenants: tenants.length,
      });
    } finally {
      running = false;
    }
  };

  const run = (): void => {
    void tick().catch((error: unknown) =>
      onError(error instanceof Error ? error.name : "Error"),
    );
  };

  const first = setTimeout(run, options.startDelayMs ?? 30_000);
  first.unref();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
