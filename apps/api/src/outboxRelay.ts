import { prisma, withTenant } from "@nodaq/db";
import type { DomainEvent } from "@nodaq/shared";

/*
 * Bus d'événements (4.4, PR A) — LE RELAIS et ses abonnés.
 *
 * CONTRAINTE DE DÉPLOIEMENT — UNE SEULE RÉPLIQUE D'API.
 *
 * Le registre d'abonnés ET le relais vivent dans le processus. Avec deux
 * instances, l'instance A dépêche à SES abonnés puis marque `delivered_at` :
 * les navigateurs connectés à l'instance B ne reçoivent jamais rien, et
 * AUCUN compteur ne le dirait. Ce serait le bug 2.21 restauré, invisible.
 *
 * C'est le prix de l'écart ci-dessous, et il est payable aujourd'hui : le
 * déploiement est mono-réplique. Le jour où il faudra scaler, ce n'est pas le
 * relais qu'il faudra dupliquer mais le canal — `LISTEN/NOTIFY` PostgreSQL
 * suffirait, sans introduire Redis. Tant que ce n'est pas fait, monter à deux
 * répliques casse la fraîcheur SANS RIEN CASSER D'AUTRE, donc sans alerte :
 * d'où cet avertissement ici plutôt que dans un ticket.
 *
 * PAS DE FILE DISTRIBUÉE, et c'est un écart assumé au ticket. Redis tourne
 * dans `docker-compose` mais aucun paquet du dépôt ne s'y connecte, alors que
 * le produit a déjà trois ordonnanceurs en processus (`push.ts`,
 * `retention.ts`, `server.ts`) avec le même patron éprouvé. L'outbox donne
 * l'atomicité et le rejeu — les deux propriétés que le ticket exige d'une
 * file. Une file s'introduira le jour où un consommateur devra tourner HORS de
 * l'API : c'est une décision d'exploitation, pas une dépendance de ce ticket.
 *
 * LIVRAISON AU MOINS UNE FOIS, jamais au plus une fois. On dépêche PUIS on
 * marque : un crash entre les deux rejoue l'événement. L'inverse — marquer
 * puis dépêcher — perdrait l'événement au même endroit, et un écran resterait
 * faux sans que personne ne le sache. Le consommateur d'invalidation est
 * idempotent par nature (recharger deux fois rend la même chose), donc c'est
 * le bon sens du compromis.
 */

/** Ce qui part vers un abonné : de quoi RELIRE, jamais de quoi lire. */
export interface OutboxDelivery {
  readonly id: string;
  readonly type: DomainEvent;
  readonly objectType: string;
  readonly objectId: string | null;
  readonly occurredAt: string;
}

type Subscriber = (delivery: OutboxDelivery) => void;

/**
 * Événements réservés au DIRIGEANT.
 *
 * Le bus était clé par tenant seulement : tout membre recevait tout. Sans
 * conséquence tant que seul `pending_action` est émis (la file est ouverte aux
 * membres), mais le registre accepte déjà `rh.modifie` — et les routes `/rh/*`
 * sont owner-only parce qu'elles portent des données de salariés. Le jour où
 * le moteur de règles émet, un membre apprendrait l'identifiant d'un salarié
 * modifié et la chronologie des changements RH : une fuite par CANAL
 * AUXILIAIRE, sans qu'aucune route n'ait été ouverte.
 *
 * On borne donc AVANT que ces émetteurs existent. La liste suit les gardes
 * `ownerRoute` du produit : trésorerie, marge, RH, revenus, coûts.
 */
const OWNER_ONLY_EVENTS: ReadonlySet<string> = new Set([
  "rh.modifie",
  "cout.modifie",
  "immobilisation.modifiee",
  "echeance.modifiee",
]);

interface Registration {
  readonly deliver: Subscriber;
  /** Rôle de l'abonné, relu à chaque revalidation — jamais figé à la connexion. */
  role: string;
}

const subscribers = new Map<string, Set<Registration>>();

/**
 * Abonne une connexion (SSE) aux événements d'UN tenant.
 *
 * La clé est le `tenantId` résolu par la chaîne d'autorisation, jamais un
 * identifiant venu du client : c'est ce qui empêche un abonné d'écouter le
 * bus d'une autre organisation. Le registre est en mémoire du processus — un
 * abonné ne survit pas à un redémarrage, et n'a pas à y survivre : sa
 * connexion non plus.
 */
export function subscribeOutbox(
  tenantId: string,
  subscriber: Subscriber,
  /*
   * Défaut FAIL-CLOSED. `"owner"` par défaut faisait qu'un futur appelant
   * omettant le rôle recevait les événements RH : une garde dont l'oubli
   * ouvre est une garde à l'envers.
   */
  role = "member",
): { unsubscribe: () => void; setRole: (role: string) => void } {
  const registration: Registration = { deliver: subscriber, role };
  const set = subscribers.get(tenantId) ?? new Set<Registration>();
  set.add(registration);
  subscribers.set(tenantId, set);
  const unsubscribe = (): void => {
    set.delete(registration);
    // `subscribers.get(tenantId) === set` : un désabonnement rejoué après
    // qu'un nouvel abonné a installé un ensemble neuf effacerait des abonnés
    // VIVANTS — même garde que le bus côté navigateur.
    if (set.size === 0 && subscribers.get(tenantId) === set) subscribers.delete(tenantId);
  };
  // Le rôle peut CHANGER pendant la vie du flux (promotion, rétrogradation) :
  // le figer à la connexion rejouerait, sur un canal long, le défaut que
  // `requireMembership` corrige à chaque requête ailleurs.
  return { unsubscribe, setRole: (next: string) => (registration.role = next) };
}

/** Nombre d'abonnés d'un tenant — pour les tests et la journalisation. */
export function outboxSubscriberCount(tenantId: string): number {
  return subscribers.get(tenantId)?.size ?? 0;
}

/** Page de relais. Bornée pour la même raison que la rétention : une page = une transaction. */
export const OUTBOX_RELAY_PAGE_SIZE = 200;

/** Coût borné d'un passage, par tenant. */
export const OUTBOX_RELAY_MAX_PAGES = 50;

/*
 * PAS DE VERROU CONSULTATIF, et c'est un refus motivé.
 *
 * La revue demandait un `pg_try_advisory_lock` pour empêcher deux répliques de
 * relayer. Essayé, puis RETIRÉ : un verrou consultatif est lié à la SESSION
 * PostgreSQL, et Prisma répartit les requêtes sur un pool. Rien ne garantit
 * que la prise et le relâchement tombent sur la même connexion — un
 * relâchement émis ailleurs échoue silencieusement, le verrou fuit, et le
 * relais s'arrête DÉFINITIVEMENT au premier tour. C'est-à-dire un mode de
 * défaillance pire que le danger gardé, et déclenché en fonctionnement normal
 * plutôt qu'en cas de mauvaise configuration.
 *
 * La bonne réponse est un bail en base (propriétaire + expiration, revendiqué
 * par un UPDATE conditionnel) ou un canal partagé (`LISTEN/NOTIFY`), qui rend
 * le verrou inutile en supprimant le besoin d'unicité. Les deux dépassent
 * cette PR. En attendant, la contrainte mono-réplique est écrite ci-dessus et
 * journalisée au démarrage : dite plutôt que gardée, mais dite.
 */

export interface OutboxRelayResult {
  readonly relayed: number;
  /** Des événements restent à transmettre : la borne du passage est atteinte. */
  readonly truncated: boolean;
}

/**
 * Transmet les événements non encore relayés d'un tenant.
 *
 * TOUS LES TENANTS SONT TRAITÉS, y compris ceux dont personne n'écoute. Ne
 * traiter que les tenants abonnés laisserait un arriéré grossir sans fin chez
 * les autres, et le premier abonné à se connecter recevrait trois jours
 * d'invalidations d'un coup. Un écran fermé n'a rien à périmer : il relira au
 * moment où il s'ouvrira. Marquer transmis sans abonné est donc la sémantique
 * juste, pas un raccourci.
 *
 * `deliveredAt` NE SERT QUE CE CONSOMMATEUR. Le moteur de règles (PR B) aura
 * ses propres besoins de garantie — un seul drapeau ne peut pas servir deux
 * consommateurs qui n'avancent pas au même rythme. Il lui faudra son curseur ;
 * l'écrire ici serait le peindre dans un coin.
 */
export async function relayTenantOutbox(
  tenantId: string,
  options: { readonly maxPages?: number; readonly pageSize?: number } = {},
): Promise<OutboxRelayResult> {
  const maxPages = options.maxPages ?? OUTBOX_RELAY_MAX_PAGES;
  const pageSize = options.pageSize ?? OUTBOX_RELAY_PAGE_SIZE;
  let relayed = 0;
  let truncated = false;

  for (let page = 0; page < maxPages; page += 1) {
    const batch = await withTenant(tenantId, (tx) =>
      tx.outboxEvent.findMany({
        where: { deliveredAt: null },
        // `id` en second critère : à égalité d'horodatage, l'ordre serait
        // sinon non déterministe, et un rejeu ne rendrait pas la même page.
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
        take: pageSize,
      }),
    );
    if (batch.length === 0) break;

    for (const event of batch) {
      const delivery: OutboxDelivery = {
        id: event.id,
        type: event.type as DomainEvent,
        objectType: event.objectType,
        objectId: event.objectId,
        occurredAt: event.occurredAt.toISOString(),
      };
      const ownerOnly = OWNER_ONLY_EVENTS.has(event.type);
      for (const registration of subscribers.get(tenantId) ?? []) {
        if (ownerOnly && registration.role !== "owner") continue;
        try {
          registration.deliver(delivery);
        } catch {
          /* une connexion morte n'empêche pas les autres d'être servies */
        }
      }
    }

    // DÉPÊCHÉ PUIS MARQUÉ : un crash ici rejoue, il ne perd pas.
    const { count } = await withTenant(tenantId, (tx) =>
      tx.outboxEvent.updateMany({
        where: { id: { in: batch.map((event) => event.id) } },
        data: { deliveredAt: new Date() },
      }),
    );
    relayed += count;

    if (batch.length < pageSize) break;
    if (page === maxPages - 1) {
      const reste = await withTenant(tenantId, (tx) =>
        tx.outboxEvent.findFirst({ where: { deliveredAt: null }, select: { id: true } }),
      );
      truncated = reste !== null;
    }
  }

  return { relayed, truncated };
}

/**
 * UN passage complet du relais — découverte des tenants comprise.
 *
 * Exporté parce que c'est le seul chemin qui exerce la DÉCOUVERTE, et que
 * c'est précisément là que la régression la plus grave de ce ticket s'était
 * logée : une requête `SELECT DISTINCT tenant_id FROM outbox` hors
 * `withTenant` rendait zéro ligne (table scellée, `app_user` NOBYPASSRLS),
 * donc le relais ne transmettait plus rien — sans qu'un seul journal le dise.
 * Tous les tests appelaient `relayTenantOutbox(tenantId)` avec un tenant déjà
 * connu : aucun ne passait par ici.
 */
export async function runOutboxRelayOnce(
  onError: (name: string, tenantId?: string) => void = () => undefined,
): Promise<OutboxRelayResult & { tenants: number; failed: number }> {
  {
    /*
     * `tenants` — PLAN AUTH, sans RLS. C'est ce que lisent déjà `push.ts` et
     * `retention.ts`, les deux ordonnanceurs pris pour modèle. Interroger
     * `outbox` ici contournerait une table scellée et, en pratique, ne
     * rendrait rien du tout.
     */
    /*
     * COÛT ASSUMÉ : un `withTenant` par tenant à chaque passage, même pour un
     * tenant sans événement — soit, à mille tenants et 2 s d'intervalle,
     * plusieurs centaines de transactions par seconde dont l'essentiel ne rend
     * rien. La version qui « optimisait » en interrogeant `outbox` directement
     * a été retirée : hors `withTenant`, la RLS rendait ZÉRO ligne et le
     * relais ne transmettait plus rien, en silence.
     *
     * La bonne optimisation passe par un compteur non transactionnel hors du
     * plan métier (une table de réveil en plan auth, ou `LISTEN/NOTIFY`), pas
     * par un contournement de la RLS. Tant qu'elle n'est pas faite, le
     * dépassement d'intervalle se verrait au journal ci-dessus.
     */
    const tenants = await prisma.tenant.findMany({ select: { id: true } });
    let relayed = 0;
    let failed = 0;
    let truncated = false;
    for (const tenant of tenants) {
      try {
        const result = await relayTenantOutbox(tenant.id);
        relayed += result.relayed;
        truncated ||= result.truncated;
      } catch (error) {
        // Un tenant cassé n'arrête pas les autres — mais jamais en silence.
        failed += 1;
        onError(error instanceof Error ? error.name : "unknown", tenant.id);
      }
    }
    return { relayed, truncated, tenants: tenants.length, failed };
  }
}

export interface OutboxRelayOptions {
  /** Cadence. Le critère du ticket est « moins de 5 s » : 2 s laisse la marge. */
  intervalMs?: number;
  /** Reçoit le NOM de l'erreur et le tenant — jamais le message, qui pourrait citer une donnée. */
  onError?: (name: string, tenantId?: string) => void;
  onRelay?: (result: OutboxRelayResult & { tenants: number; failed: number }) => void;
}

/**
 * Ordonnanceur en processus, même patron que `startRetentionSweep` : timer
 * `unref()` (il ne retient jamais le process), passage non réentrant, et
 * chaque rejet attrapé — une tâche de fond ne doit pas pouvoir tuer l'API par
 * `unhandledRejection`.
 */
export function startOutboxRelay(options: OutboxRelayOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? 2_000;
  const onError = options.onError ?? (() => undefined);
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await runOutboxRelayOnce(onError);
      /*
       * UN PASSAGE QUI NE DÉCOUVRE AUCUN TENANT EST ANORMAL, et c'est
       * exactement le silence qui a caché la pire régression de ce ticket : la
       * découverte aveuglée par la RLS rendait zéro tenant, donc zéro
       * événement relayé, donc aucun journal. Le bug a été corrigé ; le
       * silence qui l'a rendu indétectable ne l'était pas.
       *
       * Un produit vivant a toujours au moins un tenant. Zéro veut dire que la
       * découverte est cassée, pas que personne n'écrit.
       */
      if (result.tenants === 0) {
        onError("outbox relay: aucun tenant découvert — la découverte est cassée");
      }
      if (result.relayed > 0 || result.failed > 0 || result.tenants === 0) {
        options.onRelay?.(result);
      }
    } catch (error) {
      onError(error instanceof Error ? error.name : "unknown");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
