import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createLoadGuard,
  emitDomainEvent,
  EVENT_VIEWS,
  eventForTool,
  WRITE_TOOL_EVENTS,
  formatFreshness,
  FRESHNESS_RULES_VERSION,
  isStale,
  subscribeView,
  VIEW_KEYS,
  viewsFor,
  watchFreshness,
} from "../lib/freshness";

/*
 * Fraîcheur des données (ticket 2.21 A) — le bug : une écriture faite AILLEURS
 * (l'agent dans le chat, un autre onglet, un webhook, un collègue) laissait
 * l'écran afficher les anciens chiffres jusqu'à un rechargement manuel.
 *
 * « Un cockpit qui ment est pire qu'un cockpit vide. »
 *
 * La correspondance événement -> vues est une CONFIG VERSIONNÉE : un nouvel
 * écran déclare les événements qui le salissent, il n'a jamais à « penser » à
 * se rafraîchir.
 */

describe("correspondance événement -> vues (config versionnée)", () => {
  it("versionnée, et chaque événement salit au moins une vue", () => {
    expect(FRESHNESS_RULES_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const events = Object.keys(EVENT_VIEWS) as (keyof typeof EVENT_VIEWS)[];
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      // Un événement qui ne salit rien est un événement qu'on a oublié de
      // brancher : il passerait inaperçu exactement comme le bug d'origine.
      expect(EVENT_VIEWS[event].length).toBeGreaterThan(0);
      for (const view of EVENT_VIEWS[event]) {
        expect(VIEW_KEYS).toContain(view);
      }
    }
  });

  it("les agrégats DÉRIVÉS sont dans la correspondance, pas seulement les listes", () => {
    // Trésorerie, impayés, marge : ils se recalculent à la lecture, donc une
    // écriture les périme aussi. Les oublier, c'est laisser le cockpit
    // afficher un solde d'avant l'action.
    const afterValidation = viewsFor("action.validee");
    for (const derived of ["cockpit", "tresorerie", "impayes", "marge"] as const) {
      expect(afterValidation).toContain(derived);
    }
  });

  it("un outil d'écriture de l'agent porte un événement ; une lecture n'en porte pas", () => {
    // Le flux SSE ne transporte que des NOMS d'outils (minimisation 2.17) :
    // c'est assez pour savoir qu'une vue est périmée, sans faire voyager la
    // moindre donnée métier de plus.
    expect(eventForTool("draft_dunning")).toBe("action.preparee");
    expect(eventForTool("ocr_and_book_invoice")).toBe("action.preparee");
    expect(eventForTool("compute_treasury_forecast")).toBeNull();
    expect(eventForTool("outil_inconnu")).toBeNull();
  });

  it("tout outil d'agent qui ÉCRIT porte un événement (garde de dérive)", () => {
    // La liste des outils d'écriture vit dans le serveur MCP (`TOOL_POLICIES`,
    // `requiresValidation: true`). En ajouter un là-bas sans l'ajouter ici,
    // c'est recréer le bug pour ce seul outil — silencieusement. Le front ne
    // dépend pas du serveur MCP (et ne doit pas) : on lit donc sa source, ce
    // qui est une garde de CI, pas un couplage à l'exécution.
    const policies = readFileSync(
      join(import.meta.dirname, "..", "..", "..", "mcp-servers", "actions", "src", "server.ts"),
      "utf-8",
    );
    const block = policies.slice(policies.indexOf("export const TOOL_POLICIES"));
    const writeTools = [...block.matchAll(/(\w+): \{ requiresValidation: true \}/g)].map(
      (match) => match[1] as string,
    );
    expect(writeTools.length).toBeGreaterThan(0);
    const missing = writeTools.filter((tool) => !(tool in WRITE_TOOL_EVENTS));
    expect(missing, `outils d'écriture sans événement :\n${missing.join("\n")}`).toEqual([]);
  });
});

describe("garde de concurrence sur le chargement", () => {
  it("seule la réponse du DERNIER chargement horodate", async () => {
    // Bus + retour de focus + clic « rafraîchir » : trois chargements partent,
    // et le plus lent peut répondre en dernier avec des données PLUS VIEILLES.
    // Sans garde, l'écran les affiche en se déclarant « à jour à l'instant » —
    // le cockpit qui ment, reconstitué par le correctif censé le corriger.
    const guard = createLoadGuard();
    let releaseSlow: () => void = () => undefined;
    const slow = guard.run(() => new Promise<void>((resolve) => (releaseSlow = resolve)));
    const fast = guard.run(() => Promise.resolve());
    expect(await fast).toBe("a-jour");
    releaseSlow();
    expect(await slow).toBe("perime");
  });

  it("un échec du dernier chargement est DIT, pas confondu avec un succès", async () => {
    const guard = createLoadGuard();
    expect(await guard.run(() => Promise.reject(new Error("réseau")))).toBe("echec");
  });

  it("un échec dépassé ne dit rien : un chargement plus récent fait foi", async () => {
    // Sinon un refetch raté effacerait l'horodatage d'un chargement RÉUSSI
    // arrivé après lui.
    const guard = createLoadGuard();
    let failLate: (error: Error) => void = () => undefined;
    const stale = guard.run(() => new Promise<void>((_, reject) => (failLate = reject)));
    expect(await guard.run(() => Promise.resolve())).toBe("a-jour");
    failLate(new Error("réseau"));
    expect(await stale).toBe("perime");
  });
});

describe("bus d'invalidation", () => {
  it("réveille EXACTEMENT les vues concernées", () => {
    const cockpit = vi.fn();
    const classeur = vi.fn();
    const unsubCockpit = subscribeView("cockpit", cockpit);
    const unsubClasseur = subscribeView("classeur", classeur);
    try {
      emitDomainEvent("action.validee");
      expect(cockpit).toHaveBeenCalledTimes(1);
      // Valider une relance ne périme pas le classeur : rafraîchir tout à
      // chaque événement, c'est un cockpit qui clignote et des appels inutiles.
      expect(classeur).not.toHaveBeenCalled();

      emitDomainEvent("document.ajoute");
      expect(classeur).toHaveBeenCalledTimes(1);
    } finally {
      unsubCockpit();
      unsubClasseur();
    }
  });

  it("se désabonne vraiment : un écran démonté ne se rafraîchit plus", () => {
    const listener = vi.fn();
    subscribeView("cockpit", listener)();
    emitDomainEvent("action.validee");
    expect(listener).not.toHaveBeenCalled();
  });

  it("l'écoute d'une vue survit à l'échec d'un autre abonné", () => {
    // Un écran qui jette pendant son refetch ne doit pas empêcher les autres
    // de se rafraîchir — sinon un bug d'affichage recrée le bug de fraîcheur.
    const boom = vi.fn(() => {
      throw new Error("refetch cassé");
    });
    const sane = vi.fn();
    const unsubA = subscribeView("cockpit", boom);
    const unsubB = subscribeView("cockpit", sane);
    try {
      expect(() => emitDomainEvent("action.validee")).not.toThrow();
      expect(sane).toHaveBeenCalledTimes(1);
    } finally {
      unsubA();
      unsubB();
    }
  });
});

describe("horodatage « à jour il y a X »", () => {
  const NOW = Date.UTC(2026, 7, 2, 12, 0, 0);

  it("dit l'âge en clair, du plus frais au plus vieux", () => {
    expect(formatFreshness(NOW - 5_000, NOW)).toBe("à jour à l'instant");
    expect(formatFreshness(NOW - 3 * 60_000, NOW)).toBe("à jour il y a 3 min");
    expect(formatFreshness(NOW - 2 * 3_600_000, NOW)).toBe("à jour il y a 2 h");
    expect(formatFreshness(NOW - 3 * 86_400_000, NOW)).toBe("à jour il y a 3 j");
  });

  it("jamais chargé : le DIT, au lieu de laisser croire à des données fraîches", () => {
    expect(formatFreshness(null, NOW)).toBe("jamais rafraîchi");
  });

  it("horloge en avance : ramené à « à l'instant », jamais un âge négatif", () => {
    // Décalage d'horloge client/serveur : « à jour il y a -4 min » ferait
    // douter de tout l'écran pour un défaut qui n'est pas dans les données.
    expect(formatFreshness(NOW + 4 * 60_000, NOW)).toBe("à jour à l'instant");
  });

  it("périmé au-delà du seuil : le sait, pour pouvoir le dire", () => {
    expect(isStale(NOW - 30_000, NOW, 60_000)).toBe(false);
    expect(isStale(NOW - 120_000, NOW, 60_000)).toBe(true);
    // Jamais chargé = périmé : l'écran ne doit pas se taire.
    expect(isStale(null, NOW, 60_000)).toBe(true);
  });
});

describe("réveil au retour (focus, reconnexion)", () => {
  function fakeTarget() {
    const handlers = new Map<string, Set<() => void>>();
    return {
      addEventListener: (type: string, fn: () => void) => {
        const set = handlers.get(type) ?? new Set();
        set.add(fn);
        handlers.set(type, set);
      },
      removeEventListener: (type: string, fn: () => void) => {
        handlers.get(type)?.delete(fn);
      },
      fire: (type: string) => {
        for (const fn of handlers.get(type) ?? []) fn();
      },
      count: (type: string) => handlers.get(type)?.size ?? 0,
    };
  }

  it("rafraîchit au retour de focus ET à la reconnexion réseau", () => {
    // L'artisan verrouille son téléphone et revient dix minutes plus tard :
    // sans ça, l'écran affiche l'état d'il y a dix minutes sans le dire.
    const target = fakeTarget();
    const onWake = vi.fn();
    const stop = watchFreshness(target, onWake);
    target.fire("visibilitychange");
    target.fire("online");
    expect(onWake).toHaveBeenCalledTimes(2);
    stop();
    // Démonté : plus aucun écouteur laissé derrière (fuite mémoire ET
    // refetch fantôme sur un écran qui n'existe plus).
    expect(target.count("visibilitychange")).toBe(0);
    expect(target.count("online")).toBe(0);
    target.fire("online");
    expect(onWake).toHaveBeenCalledTimes(2);
  });

  it("chaque événement n'est écouté que sur SA cible, une seule fois", () => {
    // `visibilitychange` est émis sur `document` et REMONTE jusqu'à `window` ;
    // `online` n'existe que sur `window`. Écouter les deux types sur les deux
    // cibles doublait chaque alt-tab — une vingtaine de requêtes serveur pour
    // un simple retour d'onglet.
    const doc = fakeTarget();
    const win = fakeTarget();
    const onWake = vi.fn();
    const stop = watchFreshness(doc, onWake, () => false, win);
    expect(doc.count("visibilitychange")).toBe(1);
    expect(doc.count("online")).toBe(0);
    expect(win.count("online")).toBe(1);
    expect(win.count("visibilitychange")).toBe(0);
    doc.fire("visibilitychange");
    win.fire("online");
    expect(onWake).toHaveBeenCalledTimes(2);
    stop();
    expect(doc.count("visibilitychange")).toBe(0);
    expect(win.count("online")).toBe(0);
  });

  it("onglet masqué : ne rafraîchit pas (le réveil, c'est le RETOUR)", () => {
    const target = fakeTarget();
    const onWake = vi.fn();
    const stop = watchFreshness(target, onWake, () => true);
    target.fire("visibilitychange");
    expect(onWake).not.toHaveBeenCalled();
    stop();
  });
});
