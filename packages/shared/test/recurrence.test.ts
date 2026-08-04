import { describe, expect, it } from "vitest";
import {
  CADENCES,
  CADENCE_MONTHS,
  MAX_DUE_OCCURRENCES,
  planOccurrences,
  RECURRENCE_VERSION,
} from "../src/index.js";

/*
 * Récurrence des contrats (4.2, bloc 2).
 *
 * Le moteur est PUR : des dates entrent, des dates sortent. Zéro base, zéro
 * LLM, zéro horloge implicite — `todayIso` est toujours passé. C'est la seule
 * raison d'oser dire à un patron « vous avez trois passages en retard ».
 *
 * Ce que ces tests défendent, dans l'ordre : ne rien inventer quand on ne sait
 * pas, ne rien produire en double, et dire quand on tronque.
 */

const CONTRAT = {
  cadence: "mensuel" as const,
  startDate: "2026-01-15",
  endDate: null,
  lastOccurrenceDate: null,
};

describe("config versionnée datée", () => {
  it("porte une version datée et une cadence connue par cadence", () => {
    expect(RECURRENCE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}(\.\d+)?$/);
    expect(Object.keys(CADENCE_MONTHS).sort()).toEqual([...CADENCES].sort());
    for (const cadence of CADENCES) expect(CADENCE_MONTHS[cadence]).toBeGreaterThan(0);
  });
});

describe("ce qu'on REFUSE de planifier", () => {
  it("sans date de début, aucune échéance — et le motif est rendu", () => {
    /*
     * Un refus est une RÉPONSE motivée, jamais un tableau vide muet. Sans date
     * de début, il n'existe aucune façon de savoir quand le premier passage
     * était dû : deviner « à la création du contrat » inventerait des retards.
     */
    const plan = planOccurrences({ ...CONTRAT, startDate: null }, "2026-08-04");
    expect(plan.due).toEqual([]);
    expect(plan.next).toBeNull();
    expect(plan.reason).toContain("date de début");
  });

  it("un contrat qui commence PLUS TARD n'est jamais en retard", () => {
    const plan = planOccurrences({ ...CONTRAT, startDate: "2026-12-01" }, "2026-08-04");
    expect(plan.due).toEqual([]);
    // …mais la prochaine est annoncée : c'est une information, pas un vide.
    expect(plan.next).toBe("2026-12-01");
    expect(plan.ended).toBe(false);
  });
});

describe("les échéances dues", () => {
  it("un contrat mensuel jamais matérialisé doit TOUTES ses échéances passées", () => {
    // Départ le 15 janvier, on est le 4 août : 15/01 … 15/07 = 7 passages.
    const plan = planOccurrences(CONTRAT, "2026-08-04");
    expect(plan.due).toEqual([
      "2026-01-15",
      "2026-02-15",
      "2026-03-15",
      "2026-04-15",
      "2026-05-15",
      "2026-06-15",
      "2026-07-15",
    ]);
    expect(plan.next).toBe("2026-08-15");
  });

  it("l'échéance du JOUR est due, pas « à venir »", () => {
    // La frontière : un passage prévu aujourd'hui est à faire aujourd'hui.
    // Le ranger dans « à venir » le ferait disparaître du brief le seul jour
    // où il compte.
    const plan = planOccurrences(CONTRAT, "2026-03-15");
    expect(plan.due).toContain("2026-03-15");
    expect(plan.next).toBe("2026-04-15");
  });

  it("ce qui est DÉJÀ matérialisé ne revient pas", () => {
    /*
     * La propriété qui empêche le doublon : `lastOccurrenceDate` est la
     * dernière échéance transformée en affaire. Sans elle, chaque passage du
     * brief re-proposerait les mêmes interventions, et le patron finirait avec
     * douze chantiers pour un seul entretien.
     */
    const plan = planOccurrences({ ...CONTRAT, lastOccurrenceDate: "2026-05-15" }, "2026-08-04");
    expect(plan.due).toEqual(["2026-06-15", "2026-07-15"]);
  });

  it("chaque cadence avance de son pas", () => {
    const trimestriel = planOccurrences(
      { ...CONTRAT, cadence: "trimestriel" },
      "2026-08-04",
    );
    expect(trimestriel.due).toEqual(["2026-01-15", "2026-04-15", "2026-07-15"]);
    const annuel = planOccurrences({ ...CONTRAT, cadence: "annuel" }, "2026-08-04");
    expect(annuel.due).toEqual(["2026-01-15"]);
    expect(annuel.next).toBe("2027-01-15");
  });
});

describe("les fins de mois, là où l'arithmétique de dates ment", () => {
  it("le 31 devient le dernier jour des mois plus courts, sans déborder", () => {
    /*
     * `new Date(2026, 0, 31)` + 1 mois donne le 3 mars en JS — le mois de
     * février « déborde ». Un contrat au 31 générerait alors des passages qui
     * dérivent d'un mois sur l'autre. On borne au dernier jour du mois.
     */
    const plan = planOccurrences(
      { ...CONTRAT, startDate: "2026-01-31" },
      "2026-05-01",
    );
    expect(plan.due).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("le jour d'ancrage n'est pas PERDU après un mois court", () => {
    // Le piège du bornage naïf : après un 28 février, un moteur qui repart du
    // dernier résultat resterait au 28 pour toujours. L'ancrage est la date de
    // début, jamais l'occurrence précédente.
    const plan = planOccurrences({ ...CONTRAT, startDate: "2026-01-31" }, "2026-04-01");
    expect(plan.due).toContain("2026-03-31");
  });

  it("le 29 février d'une année bissextile ne se perd pas non plus", () => {
    const plan = planOccurrences(
      { ...CONTRAT, cadence: "annuel", startDate: "2024-02-29" },
      "2026-03-01",
    );
    expect(plan.due).toEqual(["2024-02-29", "2025-02-28", "2026-02-28"]);
  });
});

describe("la fin du contrat", () => {
  it("rien n'est dû après la date de fin, et le contrat est DIT terminé", () => {
    const plan = planOccurrences(
      { ...CONTRAT, endDate: "2026-04-20" },
      "2026-08-04",
    );
    expect(plan.due).toEqual(["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15"]);
    expect(plan.next).toBeNull();
    expect(plan.ended).toBe(true);
  });

  it("une fin À VENIR ne termine rien", () => {
    const plan = planOccurrences({ ...CONTRAT, endDate: "2026-12-31" }, "2026-08-04");
    expect(plan.ended).toBe(false);
    expect(plan.next).toBe("2026-08-15");
  });
});

describe("ce qui n'est pas calculé est DIT", () => {
  it("un contrat dormant depuis des années est TRONQUÉ, et le dit", () => {
    /*
     * Sans borne, un contrat mensuel oublié depuis six ans proposerait
     * soixante-douze affaires d'un coup — une file de validation inutilisable,
     * et une base polluée par un clic. Avec une borne muette, le patron
     * croirait avoir tout rattrapé. Donc : borné ET dit.
     */
    const plan = planOccurrences({ ...CONTRAT, startDate: "2019-01-15" }, "2026-08-04");
    expect(plan.due.length).toBe(MAX_DUE_OCCURRENCES);
    expect(plan.truncated).toBe(true);
    expect(plan.reason).toContain("tronqué");
    // Les PLUS ANCIENNES d'abord : ce sont elles qu'on rattrape en premier.
    expect(plan.due[0]).toBe("2019-01-15");
  });

  it("un plan complet n'est PAS marqué tronqué", () => {
    const plan = planOccurrences(CONTRAT, "2026-08-04");
    expect(plan.truncated).toBe(false);
    expect(plan.reason).toBeNull();
  });
});

describe("les silences que le moteur ne s'autorise pas", () => {
  it("un plan qui ne propose RIEN dit toujours pourquoi", () => {
    /*
     * L'invariant, plutôt qu'un chemin de code : quel que soit le cas, un plan
     * sans échéance à proposer porte un motif. C'est la version testable de
     * « un refus est une RÉPONSE motivée », et elle survit à une refonte du
     * moteur — un test sur la branche exacte ne survivrait pas.
     *
     * Cas balayés : pas de date de début, date du jour illisible, et une année
     * à deux chiffres (« 0226-01-15 » au lieu de « 2026-01-15 » — la frappe
     * arrive), qui sort par la troncature et non par la borne dure.
     */
    const cas = [
      { ...CONTRAT, startDate: null },
      { ...CONTRAT, startDate: "0226-01-15" },
    ];
    for (const contrat of cas) {
      const plan = planOccurrences(contrat, "2026-08-04");
      const proposeQuelqueChose = plan.due.length > 0 || plan.next !== null;
      expect({ contrat: contrat.startDate, muet: !proposeQuelqueChose && plan.reason === null })
        .toEqual({ contrat: contrat.startDate, muet: false });
    }
    // Date du jour illisible : le moteur ne devine pas « aujourd'hui ».
    const horloge = planOccurrences(CONTRAT, "pas-une-date");
    expect(horloge.due).toEqual([]);
    expect(horloge.reason).not.toBeNull();
  });

  it("l'avance rapide ne change PAS le résultat, seulement le chemin", () => {
    /*
     * L'optimisation saute les occurrences déjà matérialisées. Elle serait
     * fausse si elle sautait une occurrence encore due : ce cas compare un
     * contrat très ancien partiellement rattrapé au résultat attendu, calculé
     * à la main.
     */
    const plan = planOccurrences(
      { ...CONTRAT, startDate: "2006-01-15", lastOccurrenceDate: "2026-05-15" },
      "2026-08-04",
    );
    expect(plan.due).toEqual(["2026-06-15", "2026-07-15"]);
    expect(plan.next).toBe("2026-08-15");
    expect(plan.truncated).toBe(false);
  });

  it("l'avance rapide respecte encore les fins de mois", () => {
    // Le risque d'une avance rapide : atterrir sur un mois court et perdre le
    // jour d'ancrage. L'ancrage reste la date de début, donc le 31 revient.
    const plan = planOccurrences(
      { ...CONTRAT, startDate: "2006-01-31", lastOccurrenceDate: "2026-01-31" },
      "2026-04-01",
    );
    expect(plan.due).toEqual(["2026-02-28", "2026-03-31"]);
  });
});
