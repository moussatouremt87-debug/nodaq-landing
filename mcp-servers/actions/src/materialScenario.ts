import { z } from "zod";

/*
 * Material price scenarios (ticket 3.3) — deterministic and explainable, same
 * philosophy as treasury/salesForecast: the stock referential (quantities ×
 * replacement unit costs) valued at current prices, then re-valued under a
 * what-if price scenario ("copper +10%", "everything +5%"). Pure functions —
 * the caller feeds stock items read under withTenant. External price feeds
 * (LME, indices) are a future connector; V1 prices are the tenant's own
 * replacement costs.
 */

export const ScenarioItem = z.object({
  name: z.string(),
  unit: z.string(),
  quantity: z.number().int().min(0),
  unitCostCents: z.number().int().min(0),
});
export type ScenarioItem = z.infer<typeof ScenarioItem>;

/** Bounded on purpose: -90%..+500% — a typo must not produce absurd figures. */
const ChangePct = z.number().min(-90).max(500);

export const PriceScenario = z.object({
  /** Applied to every item unless a per-item override matches. */
  globalChangePct: ChangePct.optional(),
  /** Per-item overrides, matched on the EXACT item name. */
  items: z.array(z.object({ itemName: z.string().min(1), changePct: ChangePct })).max(50).optional(),
});
export type PriceScenario = z.infer<typeof PriceScenario>;

export interface ScenarioLine {
  name: string;
  unit: string;
  quantity: number;
  unitCostCents: number;
  changePct: number;
  newUnitCostCents: number;
  valueCents: number;
  newValueCents: number;
  deltaCents: number;
}

export interface ScenarioResult {
  lines: ScenarioLine[];
  totals: {
    valueCents: number;
    newValueCents: number;
    deltaCents: number;
    deltaPct: number | null;
  };
  /** Scenario item names that matched no stock item (typos surfaced, never silent). */
  unmatched: string[];
}

/**
 * Values the stock under a price scenario. Items with no cost recorded value
 * at 0 and stay visible — the caller can tell "no data" from "worthless".
 */
export function simulateMaterialPrices(
  items: ScenarioItem[],
  scenario: PriceScenario,
): ScenarioResult {
  const parsedItems = z.array(ScenarioItem).max(1000).parse(items);
  const parsedScenario = PriceScenario.parse(scenario);
  const overrides = new Map(
    (parsedScenario.items ?? []).map((entry) => [entry.itemName, entry.changePct]),
  );
  const matched = new Set<string>();

  const lines: ScenarioLine[] = parsedItems.map((item) => {
    let changePct = parsedScenario.globalChangePct ?? 0;
    const override = overrides.get(item.name);
    if (override !== undefined) {
      changePct = override;
      matched.add(item.name);
    }
    const newUnitCostCents = Math.max(0, Math.round(item.unitCostCents * (1 + changePct / 100)));
    const valueCents = item.quantity * item.unitCostCents;
    const newValueCents = item.quantity * newUnitCostCents;
    return {
      name: item.name,
      unit: item.unit,
      quantity: item.quantity,
      unitCostCents: item.unitCostCents,
      changePct,
      newUnitCostCents,
      valueCents,
      newValueCents,
      deltaCents: newValueCents - valueCents,
    };
  });

  const valueCents = lines.reduce((sum, line) => sum + line.valueCents, 0);
  const newValueCents = lines.reduce((sum, line) => sum + line.newValueCents, 0);
  const deltaCents = newValueCents - valueCents;
  return {
    lines,
    totals: {
      valueCents,
      newValueCents,
      deltaCents,
      deltaPct: valueCents > 0 ? Math.round((deltaCents / valueCents) * 1000) / 10 : null,
    },
    unmatched: (parsedScenario.items ?? [])
      .map((entry) => entry.itemName)
      .filter((name) => !matched.has(name)),
  };
}
