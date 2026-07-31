import { describe, expect, it } from "vitest";
import {
  compileDataQuery,
  DATA_CATALOG_VERSION,
  DATASETS,
  describeCatalog,
  MAX_QUERY_LIMIT,
  visibleDatasets,
} from "../src/dataCatalog.js";

/*
 * Cockpit conversationnel (2.5). Le modèle ne produit pas de SQL : il remplit
 * une requête structurée que ce compilateur valide champ par champ. Les tests
 * portent donc sur ce qu'il REFUSE — un champ hors catalogue, un dataset
 * réservé, un opérateur qui n'a pas de sens, une période absurde.
 */

const OWNER = "owner";
const MEMBER = "member";

describe("catalogue", () => {
  it("versionné, chaque champ décrit", () => {
    expect(DATA_CATALOG_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const dataset of DATASETS) {
      expect(dataset.label.length).toBeGreaterThan(3);
      for (const field of [...dataset.dimensions, ...dataset.measures]) {
        expect(field.description.length).toBeGreaterThan(3);
      }
    }
  });

  it("un membre ne voit pas les datasets de dirigeant", () => {
    const ids = visibleDatasets(MEMBER).map((dataset) => dataset.id);
    expect(ids).not.toContain("factures_clients");
    expect(ids).not.toContain("immobilisations");
    expect(ids).toContain("stocks");
    // Et la description envoyée au modèle ne les mentionne pas non plus.
    expect(describeCatalog(MEMBER)).not.toContain("factures_clients");
    expect(describeCatalog(OWNER)).toContain("factures_clients");
  });

  it("un champ owner-only n'apparaît pas dans la description d'un membre", () => {
    // Coût unitaire d'achat = donnée stratégique (3.3).
    expect(describeCatalog(MEMBER)).not.toContain("cout_unitaire");
    expect(describeCatalog(OWNER)).toContain("cout_unitaire");
  });
});

describe("compilation — ce qui passe", () => {
  it("compte simple", () => {
    const result = compileDataQuery({ dataset: "documents", aggregate: "count" }, MEMBER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.model).toBe("classeurDocument");
    expect(result.plan.measureColumn).toBeNull();
  });

  it("somme groupée avec filtre et période", () => {
    const result = compileDataQuery(
      {
        dataset: "factures_clients",
        aggregate: "sum",
        measure: "montant",
        groupBy: "client",
        filters: [{ field: "reglee", op: "eq", value: false }],
        from: "2026-01-01",
        to: "2026-03-31",
        limit: 5,
      },
      OWNER,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.measureColumn).toBe("amountCents");
    expect(result.plan.groupByColumn).toBe("customerName");
    expect(result.plan.filters[0]).toEqual({ column: "settled", op: "eq", value: false });
    expect(result.plan.dateColumn).toBe("issuedDate");
    expect(result.plan.limit).toBe(5);
  });

  it("la limite est bornée, jamais illimitée", () => {
    const result = compileDataQuery(
      { dataset: "documents", aggregate: "count", limit: 10_000 },
      MEMBER,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.limit).toBe(MAX_QUERY_LIMIT);
  });
});

describe("compilation — ce qui est REFUSÉ", () => {
  it("dataset inconnu : refus motivé listant le possible", () => {
    const result = compileDataQuery({ dataset: "salaires", aggregate: "count" }, OWNER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("inconnu");
    expect(result.reason).toContain("documents");
  });

  it("dataset de dirigeant demandé par un membre : refus", () => {
    const result = compileDataQuery(
      { dataset: "factures_clients", aggregate: "count" },
      MEMBER,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("dirigeant");
  });

  it("champ owner-only demandé par un membre : refus, même sur un dataset ouvert", () => {
    const result = compileDataQuery(
      { dataset: "stocks", aggregate: "sum", measure: "cout_unitaire" },
      MEMBER,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("dirigeant");
  });

  it("champ hors catalogue : refus, jamais une colonne lue au hasard", () => {
    for (const spec of [
      { dataset: "stocks", aggregate: "sum" as const, measure: "photo" },
      { dataset: "stocks", aggregate: "count" as const, groupBy: "tenantId" },
      {
        dataset: "stocks",
        aggregate: "count" as const,
        filters: [{ field: "password", op: "eq" as const, value: "x" }],
      },
    ]) {
      const result = compileDataQuery(spec, OWNER);
      expect(result.ok).toBe(false);
    }
  });

  it("une somme sans grandeur est refusée", () => {
    const result = compileDataQuery({ dataset: "documents", aggregate: "sum" }, MEMBER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("grandeur");
  });

  it("un dataset sans grandeur le dit au lieu d'en inventer une", () => {
    const result = compileDataQuery(
      { dataset: "documents", aggregate: "sum", measure: "montant" },
      MEMBER,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("aucune grandeur");
  });

  it("opérateur incohérent avec le type du champ", () => {
    const numeric = compileDataQuery(
      {
        dataset: "stocks",
        aggregate: "count",
        filters: [{ field: "quantite", op: "contains", value: "5" }],
      },
      OWNER,
    );
    expect(numeric.ok).toBe(false);

    const wrongType = compileDataQuery(
      {
        dataset: "stocks",
        aggregate: "count",
        filters: [{ field: "quantite", op: "gt", value: "beaucoup" }],
      },
      OWNER,
    );
    expect(wrongType.ok).toBe(false);
  });

  it("date mal formée ou période absurde", () => {
    expect(
      compileDataQuery(
        { dataset: "factures_clients", aggregate: "count", from: "hier" },
        OWNER,
      ).ok,
    ).toBe(false);
    expect(
      compileDataQuery(
        { dataset: "factures_clients", aggregate: "count", from: "2026-03-31", to: "2026-01-01" },
        OWNER,
      ).ok,
    ).toBe(false);
  });

  it("période demandée sur un dataset qui n'en porte pas", () => {
    const result = compileDataQuery(
      { dataset: "stocks", aggregate: "count", from: "2026-01-01" },
      OWNER,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("période");
  });

  it("PURE : deux compilations identiques donnent le même plan", () => {
    const spec = { dataset: "stocks", aggregate: "sum" as const, measure: "quantite" };
    expect(compileDataQuery(spec, OWNER)).toEqual(compileDataQuery(spec, OWNER));
  });
});
