import { withTenant } from "@nodaq/db";
import type { QueryPlan } from "@nodaq/shared";

/*
 * Exécution d'une requête du cockpit conversationnel (ticket 2.5).
 *
 * Ce module ne reçoit JAMAIS de texte du modèle : il prend un `QueryPlan`
 * déjà compilé et validé par le catalogue (`compileDataQuery`, pur). Les
 * seules chaînes qu'il manipule sont des noms de colonnes issus du catalogue
 * et le nom d'un modèle Prisma issu d'une allowlist explicite ci-dessous.
 *
 * L'accès passe par `withTenant` : le tenant n'est pas un paramètre de la
 * requête, il est posé dans la transaction (RLS = dernier rempart).
 */

/** Forme minimale d'un delegate Prisma — l'allowlist ci-dessous fait la loi. */
interface Delegate {
  groupBy: (args: unknown) => Promise<unknown>;
  aggregate: (args: unknown) => Promise<unknown>;
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * Allowlist des modèles interrogeables. Un modèle absent d'ici n'est PAS
 * atteignable, même si un plan en portait le nom : c'est la dernière barrière
 * entre le catalogue et la base.
 */
function delegateOf(tx: Tx, model: string): Delegate | null {
  switch (model) {
    case "fecInvoice":
      return tx.fecInvoice as unknown as Delegate;
    case "classeurDocument":
      return tx.classeurDocument as unknown as Delegate;
    case "stockItem":
      return tx.stockItem as unknown as Delegate;
    case "stockMovement":
      return tx.stockMovement as unknown as Delegate;
    case "fixedAsset":
      return tx.fixedAsset as unknown as Delegate;
    default:
      return null;
  }
}

export interface QueryRow {
  /** Valeur de la dimension de regroupement (null = non renseignée). */
  group: string | null;
  /** `null` quand aucune ligne ne porte la grandeur : zéro serait un chiffre. */
  value: number | null;
  /** Nombre de lignes derrière la valeur — un total sur 1 ligne se voit. */
  rows: number;
}

export interface QueryOutcome {
  rows: QueryRow[];
  /** Vrai quand la limite a coupé le résultat : jamais un partiel présenté
   * comme un total. */
  truncated: boolean;
}

/** Convertit un agrégat Prisma (BigInt possible) en nombre JSON sûr. */
function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  return 0;
}

/** Lendemain d'un jour « AAAA-MM-JJ », en UTC. */
function nextDay(day: string): Date {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function buildWhere(plan: QueryPlan): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  for (const filter of plan.filters) {
    // Le TYPE catalogue tranche, jamais la forme de la valeur : un numéro de
    // facture « 2026-01-15 » est un texte, et le convertir en date le rendrait
    // introuvable — un zéro présenté comme un fait.
    const value =
      filter.kind === "date" && typeof filter.value === "string"
        ? new Date(`${filter.value}T00:00:00Z`)
        : filter.value;
    switch (filter.op) {
      case "eq":
        where[filter.column] = value;
        break;
      case "neq":
        where[filter.column] = { not: value };
        break;
      case "contains":
        // `mode: insensitive` : chercher « sogedis » doit trouver « SOGEDIS ».
        // `%` et `_` sont échappés : Prisma ne le fait pas, et un nom
        // contenant « % » deviendrait un joker (comptage faux).
        where[filter.column] = {
          contains: String(value).replace(/[\\%_]/g, (match) => `\\${match}`),
          mode: "insensitive",
        };
        break;
      default:
        where[filter.column] = { [filter.op]: value };
    }
  }
  if (plan.dateColumn && (plan.from || plan.to)) {
    where[plan.dateColumn] = {
      ...(plan.from ? { gte: new Date(`${plan.from}T00:00:00Z`) } : {}),
      // Borne haute EXCLUSIVE au jour suivant : `lte 23:59:59` perdait la
      // dernière seconde du jour sur une colonne horodatée.
      ...(plan.to ? { lt: nextDay(plan.to) } : {}),
    };
  }
  return where;
}

/** Clé d'agrégat Prisma correspondant à l'agrégat demandé. */
function aggregateKey(plan: QueryPlan): "_count" | "_sum" | "_avg" | "_min" | "_max" {
  return `_${plan.aggregate}` as "_count" | "_sum" | "_avg" | "_min" | "_max";
}

/**
 * Exécute le plan sous le tenant de session. Renvoie des LIGNES CHIFFRÉES —
 * jamais un texte : la mise en français est faite par l'agent, à partir de
 * ces valeurs.
 */
export async function runDataQuery(tenantId: string, plan: QueryPlan): Promise<QueryOutcome> {
  const where = buildWhere(plan);
  const key = aggregateKey(plan);
  const selection =
    plan.aggregate === "count"
      ? { _count: { _all: true, id: true } }
      : { [key]: { [plan.measureColumn as string]: true }, _count: { _all: true } };

  return withTenant(tenantId, async (tx) => {
    const delegate = delegateOf(tx, plan.model);
    // Un plan citant un modèle hors allowlist ne peut pas exister (le
    // catalogue est fermé) — mais la barrière reste, fail-closed.
    if (!delegate) throw new Error("unknown dataset");

    if (plan.groupByColumn) {
      // Tri par l'AGRÉGAT côté base : « les plus gros » doit couper sur la
      // valeur, pas sur l'ordre alphabétique — sinon un top 5 tronqué serait
      // un top 5 arbitraire présenté comme un classement.
      // `_count: { <colonne> }` compterait les NON-NULS : sur une dimension
      // nullable, le groupe « non renseigné » aurait un compte de 0, partirait
      // en dernier et sauterait au `take` — le plus gros groupe tu, à rebours
      // de la doctrine « non-attribuées comptées jamais tues » (3.4).
      // Le tri se fait sur `id` — clé primaire, donc JAMAIS nulle, donc
      // COUNT(id) = COUNT(*). Prisma exige une colonne ici, et prendre la
      // dimension regroupée compterait ses non-nuls.
      const orderBy =
        plan.aggregate === "count"
          ? { _count: { id: "desc" } }
          : { [key]: { [plan.measureColumn as string]: "desc" } };
      const raw = (await delegate.groupBy({
        by: [plan.groupByColumn],
        where,
        ...selection,
        orderBy,
        // Une limite de plus : si elle coupe, on le DIT (`truncated`).
        take: plan.limit + 1,
      })) as Record<string, unknown>[];
      const truncated = raw.length > plan.limit;
      const rows = raw.slice(0, plan.limit).map((entry) => {
        const group = entry[plan.groupByColumn as string];
        const bucket = entry[key] as Record<string, unknown> | number | undefined;
        const value =
          plan.aggregate === "count"
            ? toNumber((entry._count as Record<string, unknown> | undefined)?.["_all"])
            : toNumber(
                typeof bucket === "object" && bucket !== null
                  ? (bucket as Record<string, unknown>)[plan.measureColumn as string]
                  : 0,
              );
        return {
          group: group === null || group === undefined ? null : String(group),
          value,
          rows: toNumber(
            typeof entry._count === "number"
              ? entry._count
              : (entry._count as Record<string, unknown> | undefined)?.["_all"],
          ),
        };
      });
      // Tri décroissant sur la valeur : « les plus gros » est la question
      // qu'on pose 9 fois sur 10.
      rows.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
      return { rows, truncated };
    }

    const raw = (await delegate.aggregate({ where, ...selection })) as Record<string, unknown>;
    const bucket = raw[key] as Record<string, unknown> | undefined;
    const total = toNumber((raw._count as Record<string, unknown> | undefined)?.["_all"]);
    const value =
      plan.aggregate === "count"
        ? total
        : total === 0
          ? // Aucune ligne : la somme n'est pas « 0 €», elle n'existe pas.
            null
          : toNumber(
              typeof bucket === "object" && bucket !== null
                ? bucket[plan.measureColumn as string]
                : 0,
            );
    return { rows: [{ group: null, value, rows: total }], truncated: false };
  });
}
