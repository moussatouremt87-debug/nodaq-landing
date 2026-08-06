import { describe, expect, it, vi } from "vitest";
import { EVENT_VIEWS } from "../lib/freshness";

/*
 * Écoute du bus serveur (4.4, PR A).
 *
 * Ce qui est éprouvé ici n'est pas « le flux marche » — ça, c'est l'affaire du
 * navigateur — mais les deux décisions qui le rendent SÛR : ne rien propager
 * qu'on ne connaisse pas, et ne jamais laisser une trame casser l'écoute des
 * suivantes.
 */

class FakeEventSource {
  static last: FakeEventSource | null = null;
  static opened = 0;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  /** 0 CONNECTING · 1 OPEN · 2 CLOSED — mêmes valeurs que la spécification. */
  readyState = 0;
  closed = false;
  constructor(
    readonly url: string,
    readonly init?: { withCredentials?: boolean },
  ) {
    FakeEventSource.last = this;
    FakeEventSource.opened += 1;
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  deliver(data: string): void {
    this.onmessage?.({ data } as MessageEvent<string>);
  }
  /** Le navigateur a établi la connexion (première fois ou reprise). */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  /** Abandon DÉFINITIF : statut != 200 (429, 401…). */
  giveUp(): void {
    this.readyState = 2;
    this.onerror?.();
  }
  /** Coupure transitoire : `EventSource` reprend seul. */
  blip(): void {
    this.readyState = 0;
    this.onerror?.();
  }
}

async function withFakeSource(
  run: (source: FakeEventSource, emitted: string[]) => void | Promise<void>,
): Promise<void> {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.resetModules();
  const emitted: string[] = [];
  const freshness = await import("../lib/freshness");
  const spy = vi.spyOn(freshness, "emitDomainEvent").mockImplementation((event) => {
    emitted.push(event);
  });
  try {
    const { startLiveEvents } = await import("../lib/liveEvents");
    const stop = startLiveEvents();
    const source = FakeEventSource.last;
    if (!source) throw new Error("flux non ouvert");
    await run(source, emitted);
    stop();
    expect(source.closed).toBe(true);
  } finally {
    spy.mockRestore();
    vi.unstubAllGlobals();
  }
}

describe("le flux réinjecte dans le bus local", () => {
  it("un événement CONNU périme les vues", async () => {
    await withFakeSource((source, emitted) => {
      source.deliver(JSON.stringify({ type: "action.validee" }));
      expect(emitted).toContain("action.validee");
    });
  });

  it("un événement INCONNU est ignoré, et n'interrompt pas les suivants", async () => {
    /*
     * Le serveur peut être en avance sur le navigateur pendant un déploiement
     * progressif. Réinjecter un type absent du registre lèverait dans
     * `viewsFor` — et une exception dans le gestionnaire tue l'écoute pour
     * TOUS les événements suivants, y compris ceux qu'on sait traiter.
     */
    await withFakeSource((source, emitted) => {
      source.deliver(JSON.stringify({ type: "evenement.du.futur" }));
      source.deliver(JSON.stringify({ type: "stock.modifie" }));
      expect(emitted).not.toContain("evenement.du.futur");
      expect(emitted).toContain("stock.modifie");
    });
  });

  it("une trame ILLISIBLE ne coupe pas l'écoute", async () => {
    await withFakeSource((source, emitted) => {
      source.deliver("{ pas du json");
      source.deliver(JSON.stringify({ type: "prospect.modifie" }));
      expect(emitted).toContain("prospect.modifie");
    });
  });

  it("le filtre est DÉRIVÉ du registre, jamais recopié", async () => {
    /*
     * Une liste écrite à la main divergerait au premier ajout d'événement, et
     * les nouveaux seraient silencieusement ignorés — la panne de fraîcheur
     * déplacée d'un cran. On vérifie donc que TOUS les événements du registre
     * passent le filtre, pas seulement ceux auxquels on a pensé.
     */
    await withFakeSource((source, emitted) => {
      for (const type of Object.keys(EVENT_VIEWS)) {
        source.deliver(JSON.stringify({ type }));
      }
      expect(emitted.sort()).toEqual(Object.keys(EVENT_VIEWS).sort());
    });
  });

  it("la connexion porte les cookies — sinon la session n'existe pas", async () => {
    await withFakeSource((source) => {
      expect(source.init?.withCredentials).toBe(true);
      expect(source.url).toContain("/events");
    });
  });
});

/*
 * LACUNES DU FLUX — ce que le quatrième passage du gate a trouvé.
 *
 * Le relais serveur marque un événement « transmis » même quand PERSONNE n'est
 * branché, et ne le représente jamais. Chaque intervalle sans flux — la
 * reconnexion programmée toutes les 30 min, un redéploiement, un tunnel, un
 * 429 — était donc une fenêtre d'invalidations définitivement perdues, pendant
 * laquelle un écran OUVERT affichait des chiffres faux sans horloge ni
 * bandeau. La panne du 2.21, refabriquée par le mécanisme censé la corriger.
 */
describe("une lacune du flux ne laisse pas un écran mentir", () => {
  it("TOUTE ouverture recharge toutes les vues", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.resetModules();
    const freshness = await import("../lib/freshness");
    const spy = vi.spyOn(freshness, "refreshAllViews").mockImplementation(() => undefined);
    try {
      const { startLiveEvents } = await import("../lib/liveEvents");
      const stop = startLiveEvents();
      const source = FakeEventSource.last;
      if (!source) throw new Error("flux non ouvert");

      // Première ouverture : les écrans ont pu charger AVANT que le flux ne
      // soit prêt — la fenêtre existe aussi là.
      source.open();
      expect(spy).toHaveBeenCalledTimes(1);

      // Reprise après coupure : c'est le cas qui perdait des invalidations
      // toutes les trente minutes, par conception.
      source.open();
      expect(spy).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      spy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("un abandon DÉFINITIF (429) est retenté — sinon l'onglet reste muet à vie", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers();
    vi.resetModules();
    try {
      const { startLiveEvents } = await import("../lib/liveEvents");
      FakeEventSource.opened = 0;
      const stop = startLiveEvents("/backend/events", 1_000);
      const premier = FakeEventSource.last;
      if (!premier) throw new Error("flux non ouvert");
      expect(FakeEventSource.opened).toBe(1);

      // Une coupure transitoire : `EventSource` reprend seul. Ouvrir un
      // second flux ici en laisserait deux vivants sur le même onglet.
      premier.blip();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(FakeEventSource.opened).toBe(1);

      // Un statut != 200 (le plafond de flux rend 429) : `EventSource` passe
      // en CLOSED et ne rouvre JAMAIS. Or le refus est transitoire — il suffit
      // qu'un autre onglet se ferme.
      premier.giveUp();
      await vi.advanceTimersByTimeAsync(1_100);
      expect(FakeEventSource.opened).toBe(2);
      stop();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("après l'arrêt, aucune reprise ne rouvre le flux", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers();
    vi.resetModules();
    try {
      const { startLiveEvents } = await import("../lib/liveEvents");
      FakeEventSource.opened = 0;
      const stop = startLiveEvents("/backend/events", 1_000);
      const source = FakeEventSource.last;
      if (!source) throw new Error("flux non ouvert");
      source.giveUp();
      // Changement d'organisation active, démontage de la coquille : la reprise
      // programmée rouvrirait un flux sur le tenant PRÉCÉDENT.
      stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(FakeEventSource.opened).toBe(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
