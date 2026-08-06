import { prisma, withTenant } from "@nodaq/db";
import type { DomainEvent } from "@nodaq/shared";

/*
 * Bus d'événements (4.4, PR A) — LE RELAIS et ses abonnés.
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

const subscribers = new Map<string, Set<Subscriber>>();

/**
 * Abonne une connexion (SSE) aux événements d'UN tenant.
 *
 * La clé est le `tenantId` résolu par la chaîne d'autorisation, jamais un
 * identifiant venu du client : c'est ce qui empêche un abonné d'écouter le
 * bus d'une autre organisation. Le registre est en mémoire du processus — un
 * abonné ne survit pas à un redémarrage, et n'a pas à y survivre : sa
 * connexion non plus.
 */
export function subscribeOutbox(tenantId: string, subscriber: Subscriber): () => void {
  const set = subscribers.get(tenantId) ?? new Set<Subscriber>();
  set.add(subscriber);
  subscribers.set(tenantId, set);
  return () => {
    set.delete(subscriber);
    // `subscribers.get(tenantId) === set` : un désabonnement rejoué après
    // qu'un nouvel abonné a installé un ensemble neuf effacerait des abonnés
    // VIVANTS — même garde que le bus côté navigateur.
    if (set.size === 0 && subscribers.get(tenantId) === set) subscribers.delete(tenantId);
  };
}

/** Nombre d'abonnés d'un tenant — pour les tests et la journalisation. */
export function outboxSubscriberCount(tenantId: string): number {
  return subscribers.get(tenantId)?.size ?? 0;
}

/** Page de relais. Bornée pour la même raison que la rétention : une page = une transaction. */
export const OUTBOX_RELAY_PAGE_SIZE = 200;

/** Coût borné d'un passage, par tenant. */
export const OUTBOX_RELAY_MAX_PAGES = 50;

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
      for (const subscriber of subscribers.get(tenantId) ?? []) {
        try {
          subscriber(delivery);
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
      if (relayed > 0 || failed > 0) {
        options.onRelay?.({ relayed, truncated, tenants: tenants.length, failed });
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
