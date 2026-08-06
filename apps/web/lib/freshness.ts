/*
 * Fraîcheur des données — LE BUS, côté navigateur.
 *
 * Le REGISTRE (vues, événements, correspondances) a migré dans
 * `@nodaq/shared/freshnessRules` : le bus d'événements serveur (4.4) en a
 * besoin à l'identique, et deux tables séparées auraient divergé au premier
 * ajout de vue — la panne de fraîcheur revenant par la porte de derrière, sous
 * une forme plus difficile à voir.
 *
 * Ce fichier garde tout ce qui ne peut PAS vivre côté serveur : abonnements
 * en mémoire, émission, minuteries, `document.visibilitychange`. Il réexporte
 * le registre pour que les écrans n'aient rien à changer — et pour qu'il reste
 * un seul chemin d'import côté web.
 */

export {
  EVENT_VIEWS,
  FRESHNESS_RULES_VERSION,
  MUTATION_EFFECTS,
  VIEW_KEYS,
  WRITE_TOOL_EVENTS,
  eventForTool,
  viewsFor,
} from "@nodaq/shared";
export type { DomainEvent, MutationEffect, ViewKey } from "@nodaq/shared";

import { viewsFor } from "@nodaq/shared";
import type { DomainEvent, ViewKey } from "@nodaq/shared";

// --- Bus d'invalidation -----------------------------------------------------

type Listener = () => void;

const listeners = new Map<ViewKey, Set<Listener>>();

/** Abonne un écran à une vue. Rend la fonction de désabonnement. */
export function subscribeView(view: ViewKey, listener: Listener): () => void {
  const set = listeners.get(view) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(view, set);
  return () => {
    set.delete(listener);
    // `listeners.get(view) === set` : un désabonnement rejoué après qu'un
    // nouvel abonné a installé un ensemble neuf effacerait des abonnés VIVANTS.
    // Non atteignable aujourd'hui, mais deux composants écoutent déjà la même
    // vue — une garde à un test coûte moins cher qu'un écran muet.
    if (set.size === 0 && listeners.get(view) === set) listeners.delete(view);
  };
}

/**
 * Signale qu'un événement de domaine a eu lieu : toutes les vues qu'il périme
 * se rafraîchissent.
 *
 * L'échec d'un abonné n'arrête pas les autres : un écran qui jette pendant
 * son refetch recréerait, pour tous les autres, le bug qu'on corrige.
 */
export function emitDomainEvent(event: DomainEvent): void {
  for (const view of viewsFor(event)) {
    for (const listener of listeners.get(view) ?? []) {
      try {
        listener();
      } catch {
        /* un écran cassé ne périme pas les autres */
      }
    }
  }
}

/**
 * Périme TOUTES les vues abonnées — le remède aux LACUNES du flux.
 *
 * Le relais serveur marque un événement « transmis » même si personne n'était
 * branché à cet instant, et il ne le représente jamais. Toute coupure du flux
 * — la reconnexion programmée toutes les 30 min, un redéploiement, un tunnel —
 * est donc une fenêtre pendant laquelle des invalidations sont émises pour
 * personne et PERDUES. Un écran ouvert resterait alors faux indéfiniment, sans
 * horloge ni bandeau : la panne du 2.21, reconstituée par le mécanisme censé
 * la corriger.
 *
 * Ne sachant pas ce qui a été manqué, on recharge tout : c'est la seule
 * réponse correcte, et c'est celle qu'on tient déjà au retour de focus.
 *
 * On copie les ensembles avant d'itérer : un écran qui se désabonne pendant
 * son propre rechargement muterait la collection en cours de parcours.
 */
export function refreshAllViews(): void {
  for (const set of [...listeners.values()]) {
    for (const listener of [...set]) {
      try {
        listener();
      } catch {
        /* un écran cassé ne périme pas les autres */
      }
    }
  }
}

// --- Horodatage « à jour il y a X » -----------------------------------------

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Âge lisible d'une donnée. PURE.
 *
 * `null` (jamais chargé) est DIT : laisser un écran muet ferait passer une
 * absence de données pour des données fraîches. Une horloge client en avance
 * est ramenée à « à l'instant » — « il y a −4 min » ferait douter de tout
 * l'écran pour un décalage qui n'est pas dans les données.
 */
export function formatFreshness(atMs: number | null, nowMs: number): string {
  if (atMs === null) return "jamais rafraîchi";
  const age = Math.max(0, nowMs - atMs);
  if (age < MINUTE) return "à jour à l'instant";
  if (age < HOUR) return `à jour il y a ${Math.floor(age / MINUTE)} min`;
  if (age < DAY) return `à jour il y a ${Math.floor(age / HOUR)} h`;
  return `à jour il y a ${Math.floor(age / DAY)} j`;
}

/** Donnée trop vieille pour être présentée sans réserve (`null` = périmée). */
export function isStale(atMs: number | null, nowMs: number, maxAgeMs: number): boolean {
  if (atMs === null) return true;
  return Math.max(0, nowMs - atMs) > maxAgeMs;
}

// --- Garde de concurrence ---------------------------------------------------

/**
 * Sérialise les chargements concurrents d'un même écran.
 *
 * Le bus, le retour de focus et le bouton « rafraîchir » peuvent lancer trois
 * chargements en même temps. Sans garde, leurs réponses arrivent dans le
 * désordre : l'écran retombe sur des données PLUS ANCIENNES et se déclare
 * « à jour à l'instant » — le cockpit qui ment, reconstitué par le correctif
 * censé le corriger.
 *
 * Seul le chargement le plus récent a le droit d'écrire : les précédents sont
 * ignorés, succès comme échec.
 */
export function createLoadGuard(): {
  run: (load: () => Promise<unknown>) => Promise<"a-jour" | "perime" | "echec">;
} {
  let generation = 0;
  return {
    run: async (load) => {
      const mine = ++generation;
      try {
        await load();
      } catch {
        return mine === generation ? "echec" : "perime";
      }
      // Un chargement dépassé n'a pas le droit de rajeunir l'horodatage.
      return mine === generation ? "a-jour" : "perime";
    },
  };
}

// --- Réveil au retour -------------------------------------------------------

interface EventTargetLike {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

/**
 * Rafraîchit au RETOUR : reprise de focus et reconnexion réseau.
 *
 * L'artisan verrouille son téléphone et revient dix minutes plus tard ; ou il
 * passe sous un tunnel. Sans ça, l'écran affiche l'état d'il y a dix minutes
 * sans le dire. `hidden` est injectable pour que ce soit testable hors DOM.
 */
export function watchFreshness(
  target: EventTargetLike,
  onWake: () => void,
  hidden: () => boolean = () =>
    typeof document !== "undefined" && document.visibilityState === "hidden",
  networkTarget: EventTargetLike = target,
): () => void {
  const onVisible = (): void => {
    // Le réveil, c'est le RETOUR : un onglet qu'on masque n'a rien à refetch.
    if (!hidden()) onWake();
  };
  // `visibilitychange` est émis sur `document` et REMONTE jusqu'à `window` :
  // écouter les deux, c'est deux rechargements complets à chaque alt-tab —
  // soit une vingtaine de requêtes serveur pour un simple retour d'onglet.
  // D'où deux cibles distinctes, et un seul abonnement par type.
  target.addEventListener("visibilitychange", onVisible);
  networkTarget.addEventListener("online", onWake);
  return () => {
    target.removeEventListener("visibilitychange", onVisible);
    networkTarget.removeEventListener("online", onWake);
  };
}
