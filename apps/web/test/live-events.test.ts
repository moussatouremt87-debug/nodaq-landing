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
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;
  constructor(
    readonly url: string,
    readonly init?: { withCredentials?: boolean },
  ) {
    FakeEventSource.last = this;
  }
  close(): void {
    this.closed = true;
  }
  deliver(data: string): void {
    this.onmessage?.({ data } as MessageEvent<string>);
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
