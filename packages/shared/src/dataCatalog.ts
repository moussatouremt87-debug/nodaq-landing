/*
 * Cockpit conversationnel (ticket 2.5) — « combien j'ai dépensé chez Sogedis
 * ce trimestre ? » répondu sur les données RÉELLES du tenant.
 *
 * LE choix d'architecture du ticket : le modèle n'écrit JAMAIS de SQL. Il
 * produit une requête STRUCTURÉE contre un catalogue fermé (les datasets
 * ci-dessous), qu'un compilateur PUR valide champ par champ avant qu'une
 * ligne de base ne soit lue. Le texte libre d'un modèle — influençable par
 * une photo, un e-mail ou un avis client déjà présents dans le produit — ne
 * doit jamais devenir une clause `WHERE`.
 *
 * Ce que cela ferme, par construction et pas par filtrage :
 *  - injection SQL : il n'y a pas de SQL à injecter ;
 *  - exfiltration inter-tenant : l'exécution passe par `withTenant`, et le
 *    tenant n'est pas un paramètre de requête ;
 *  - fuite par colonne : un champ absent du catalogue est un REFUS motivé,
 *    jamais une colonne lue « au cas où » ;
 *  - fuite par rôle : un dataset ou un champ réservé au dirigeant est refusé
 *    à un membre, même si le modèle le demande gentiment.
 */

/** Version du catalogue — à bumper à chaque ajout de dataset ou de champ. */
export const DATA_CATALOG_VERSION = "2026-08-02";

export type FieldKind = "text" | "number" | "boolean" | "date";

export interface CatalogField {
  /** Nom exposé au modèle (stable, en français métier). */
  name: string;
  /** Colonne Prisma correspondante. */
  column: string;
  kind: FieldKind;
  /** Réservé au dirigeant (ex. coût unitaire — doctrine 3.3). */
  ownerOnly?: boolean;
  description: string;
}

export interface Dataset {
  id: string;
  label: string;
  /** Modèle Prisma interrogé (l'exécuteur ne connaît que ce nom). */
  model: string;
  /** Dataset entier réservé au dirigeant (CA, immobilisations…). */
  ownerOnly: boolean;
  /** Module du registre 3.11 qui porte ce jeu de données. Éteint, le dataset
   * sort du catalogue exposé au modèle ET est refusé à la compilation —
   * sinon le chat resterait une porte ouverte sur un module désactivé. */
  module?: string;
  /** Champ de date utilisé par un filtre de période. */
  dateField?: string;
  dimensions: CatalogField[];
  measures: CatalogField[];
}

export const DATASETS: readonly Dataset[] = [
  {
    id: "factures_clients",
    label: "Factures clients (import FEC)",
    model: "fecInvoice",
    // CA et noms de clients : donnée de dirigeant, comme partout ailleurs.
    ownerOnly: true,
    dateField: "date_emission",
    dimensions: [
      { name: "client", column: "customerName", kind: "text", description: "Nom du client" },
      { name: "reglee", column: "settled", kind: "boolean", description: "Facture réglée" },
      { name: "numero", column: "number", kind: "text", description: "Numéro de facture" },
      {
        name: "date_emission",
        column: "issuedDate",
        kind: "date",
        description: "Date d'émission",
      },
      { name: "date_echeance", column: "dueDate", kind: "date", description: "Date d'échéance" },
    ],
    measures: [
      { name: "montant", column: "amountCents", kind: "number", description: "Montant TTC" },
      {
        name: "reste_du",
        column: "residualCents",
        kind: "number",
        description: "Reste dû EXIGIBLE (retenue de garantie exclue)",
      },
      {
        // US-8 : sans cette mesure, « combien me doit-on ? » tairait la
        // retenue — le reste dû n'en tient plus compte, et le montant du
        // marché ne dit pas ce qui est encore retenu.
        //
        // Le libellé porte sa limite : c'est la retenue CONSTATÉE sur la
        // pièce. Une libération comptabilisée séparément n'y est pas déduite
        // (elle n'est rattachable à aucune facture) — le solde en cours se lit
        // sur l'écran Connecteurs. Dire la limite dans le catalogue, c'est la
        // dire au modèle : il la relaie au lieu d'affirmer un montant net.
        name: "retenue_constatee_sur_la_facture",
        column: "retainedCents",
        kind: "number",
        description:
          "Retenue de garantie constatée sur la facture (due, pas encore exigible) — " +
          "une libération comptabilisée sous une autre pièce n'en est pas déduite",
      },
    ],
  },
  {
    id: "documents",
    label: "Documents du classeur",
    model: "classeurDocument",
    ownerOnly: false,
    dateField: "date_ajout",
    dimensions: [
      { name: "type", column: "docType", kind: "text", description: "Type de document" },
      { name: "statut", column: "status", kind: "text", description: "Statut de traitement" },
      { name: "date_ajout", column: "createdAt", kind: "date", description: "Date d'ajout" },
    ],
    measures: [],
  },
  {
    id: "stocks",
    label: "Articles en stock",
    model: "stockItem",
    ownerOnly: false,
    module: "stocks",
    dimensions: [
      { name: "article", column: "name", kind: "text", description: "Nom de l'article" },
      { name: "unite", column: "unit", kind: "text", description: "Unité" },
      { name: "reference", column: "sku", kind: "text", description: "Référence (SKU)" },
    ],
    measures: [
      { name: "quantite", column: "quantity", kind: "number", description: "Quantité en stock" },
      {
        name: "seuil_alerte",
        column: "alertThreshold",
        kind: "number",
        description: "Seuil d'alerte",
      },
      {
        name: "cout_unitaire",
        column: "unitCostCents",
        kind: "number",
        // Prix d'achat matière = donnée stratégique (3.3).
        ownerOnly: true,
        description: "Coût unitaire d'achat",
      },
    ],
  },
  {
    id: "mouvements_stock",
    label: "Mouvements de stock",
    model: "stockMovement",
    ownerOnly: false,
    module: "stocks",
    dateField: "date",
    dimensions: [
      { name: "motif", column: "reason", kind: "text", description: "Motif du mouvement" },
      { name: "date", column: "createdAt", kind: "date", description: "Date du mouvement" },
    ],
    measures: [
      { name: "variation", column: "delta", kind: "number", description: "Variation de quantité" },
    ],
  },
  {
    id: "immobilisations",
    label: "Immobilisations",
    model: "fixedAsset",
    ownerOnly: true,
    module: "immobilisations",
    dateField: "date_mise_en_service",
    dimensions: [
      { name: "categorie", column: "category", kind: "text", description: "Catégorie fiscale" },
      { name: "methode", column: "method", kind: "text", description: "Méthode d'amortissement" },
      { name: "statut", column: "status", kind: "text", description: "Statut du bien" },
      {
        name: "date_mise_en_service",
        column: "inServiceDate",
        kind: "date",
        description: "Date de mise en service",
      },
    ],
    measures: [
      { name: "base", column: "baseCents", kind: "number", description: "Base amortissable" },
    ],
  },
];

export const AGGREGATES = ["count", "sum", "avg", "min", "max"] as const;
export type Aggregate = (typeof AGGREGATES)[number];

export const FILTER_OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains"] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export interface QueryFilter {
  field: string;
  op: FilterOperator;
  value: string | number | boolean;
}

/**
 * Requête telle que le MODÈLE la produit — donc une entrée externe : chaque
 * optionnel accepte explicitement `undefined`, et rien n'est supposé.
 */
export interface DataQuerySpec {
  dataset: string;
  aggregate: Aggregate;
  /** Requis pour tout agrégat sauf `count`. */
  measure?: string | undefined;
  /** Une dimension de regroupement au plus (V1). */
  groupBy?: string | undefined;
  filters?: QueryFilter[] | undefined;
  /** Bornes de période sur le champ de date du dataset ("YYYY-MM-DD"). */
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
}

/** Plan exécutable : que des noms de colonnes du catalogue, jamais du texte libre. */
export interface QueryPlan {
  dataset: Dataset;
  model: string;
  aggregate: Aggregate;
  measureColumn: string | null;
  groupByColumn: string | null;
  filters: {
    column: string;
    /** Type catalogue du champ — l'exécuteur ne devine PAS d'après la forme
     * de la valeur (« 2026-01-15 » peut être un numéro de facture). */
    kind: FieldKind;
    op: FilterOperator;
    value: string | number | boolean;
  }[];
  dateColumn: string | null;
  from: string | null;
  to: string | null;
  limit: number;
  /** Libellés pour restituer la réponse en français. */
  labels: { dataset: string; measure: string | null; groupBy: string | null };
}

export type CompileResult =
  | { ok: true; plan: QueryPlan }
  | { ok: false; reason: string };

export const MAX_QUERY_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Datasets lisibles par un rôle, modules éteints exclus — sert aussi à guider
 * le modèle. Le gating est à DEUX niveaux, comme le reste du 2.5 : le rôle et
 * le module. Un dataset qu'on refuserait à l'exécution n'a rien à faire dans
 * la description : le modèle le proposerait, et l'utilisateur ne comprendrait
 * pas le refus.
 */
export function visibleDatasets(
  role: string,
  inactiveModules: ReadonlySet<string> = new Set(),
): Dataset[] {
  return DATASETS.filter(
    (dataset) =>
      (!dataset.ownerOnly || role === "owner") &&
      (dataset.module === undefined || !inactiveModules.has(dataset.module)),
  );
}

function findField(dataset: Dataset, name: string): CatalogField | undefined {
  return [...dataset.dimensions, ...dataset.measures].find((field) => field.name === name);
}

/**
 * Compile une requête en langage structuré vers un plan exécutable. PURE.
 *
 * Tout ce qui n'est pas explicitement au catalogue est REFUSÉ avec un motif
 * lisible — le refus est une réponse valide, et il est renvoyé au modèle pour
 * qu'il reformule plutôt que d'inventer un chiffre.
 */
export function compileDataQuery(
  spec: DataQuerySpec,
  role: string,
  inactiveModules: ReadonlySet<string> = new Set(),
): CompileResult {
  // Ce compilateur est LE point de validation (il est exporté et peut être
  // appelé sans la couche Zod du serveur MCP) : il ne suppose donc rien de
  // ses entrées, pas même que l'agrégat fasse partie des agrégats.
  if (!(AGGREGATES as readonly string[]).includes(spec.aggregate)) {
    return { ok: false, reason: `agrégat inconnu — disponibles : ${AGGREGATES.join(", ")}` };
  }
  const dataset = DATASETS.find((entry) => entry.id === spec.dataset);
  if (!dataset) {
    const available = visibleDatasets(role, inactiveModules)
      .map((entry) => entry.id)
      .join(", ");
    return { ok: false, reason: `jeu de données inconnu — disponibles : ${available}` };
  }
  if (dataset.ownerOnly && role !== "owner") {
    return { ok: false, reason: `« ${dataset.label} » est réservé au dirigeant` };
  }
  // Module éteint (3.11) : refus MOTIVÉ, pas un jeu vide qui se lirait comme
  // « vous n'avez pas de stock ».
  if (dataset.module !== undefined && inactiveModules.has(dataset.module)) {
    return {
      ok: false,
      reason: `« ${dataset.label} » dépend du module « ${dataset.module} », désactivé pour cette entreprise`,
    };
  }

  let measureColumn: string | null = null;
  let measureLabel: string | null = null;
  if (spec.aggregate !== "count") {
    if (!spec.measure) {
      return { ok: false, reason: `l'agrégat « ${spec.aggregate} » exige une grandeur` };
    }
    const field = dataset.measures.find((entry) => entry.name === spec.measure);
    if (!field) {
      const available = dataset.measures
        .filter((entry) => !entry.ownerOnly || role === "owner")
        .map((entry) => entry.name)
        .join(", ");
      return {
        ok: false,
        reason: available
          ? `grandeur inconnue pour « ${dataset.label} » — disponibles : ${available}`
          : `« ${dataset.label} » ne porte aucune grandeur chiffrable`,
      };
    }
    if (field.ownerOnly && role !== "owner") {
      return { ok: false, reason: `« ${field.description} » est réservé au dirigeant` };
    }
    measureColumn = field.column;
    measureLabel = field.description;
  }

  let groupByColumn: string | null = null;
  let groupByLabel: string | null = null;
  if (spec.groupBy) {
    const field = dataset.dimensions.find((entry) => entry.name === spec.groupBy);
    if (!field) {
      const available = dataset.dimensions
        .filter((entry) => !entry.ownerOnly || role === "owner")
        .map((entry) => entry.name)
        .join(", ");
      return { ok: false, reason: `regroupement inconnu — disponibles : ${available}` };
    }
    if (field.ownerOnly && role !== "owner") {
      return { ok: false, reason: `« ${field.description} » est réservé au dirigeant` };
    }
    groupByColumn = field.column;
    groupByLabel = field.description;
  }

  const filters: QueryPlan["filters"] = [];
  for (const filter of spec.filters ?? []) {
    if (!(FILTER_OPERATORS as readonly string[]).includes(filter.op)) {
      return { ok: false, reason: `opérateur de filtre inconnu : « ${String(filter.op)} »` };
    }
    const field = findField(dataset, filter.field);
    if (!field) {
      return { ok: false, reason: `filtre sur un champ inconnu : « ${filter.field} »` };
    }
    if (field.ownerOnly && role !== "owner") {
      return { ok: false, reason: `« ${field.description} » est réservé au dirigeant` };
    }
    // Un `contains` sur un nombre ou une date n'a pas de sens et ouvrirait la
    // porte à des comparaisons de chaînes sur des colonnes typées.
    if (filter.op === "contains" && field.kind !== "text") {
      return { ok: false, reason: `« contient » ne s'applique qu'à un texte` };
    }
    if (field.kind === "number" && typeof filter.value !== "number") {
      return { ok: false, reason: `« ${field.description} » attend un nombre` };
    }
    if (field.kind === "boolean" && typeof filter.value !== "boolean") {
      return { ok: false, reason: `« ${field.description} » attend oui ou non` };
    }
    if (field.kind === "date" && (typeof filter.value !== "string" || !DAY.test(filter.value))) {
      return { ok: false, reason: `« ${field.description} » attend une date AAAA-MM-JJ` };
    }
    filters.push({ column: field.column, kind: field.kind, op: filter.op, value: filter.value });
  }

  let dateColumn: string | null = null;
  if (spec.from || spec.to) {
    if (!dataset.dateField) {
      return { ok: false, reason: `« ${dataset.label} » ne porte pas de période interrogeable` };
    }
    const field = dataset.dimensions.find((entry) => entry.name === dataset.dateField);
    if (!field) return { ok: false, reason: "période indisponible sur ce jeu de données" };
    if (spec.from && !DAY.test(spec.from)) return { ok: false, reason: "date de début invalide" };
    if (spec.to && !DAY.test(spec.to)) return { ok: false, reason: "date de fin invalide" };
    if (spec.from && spec.to && spec.to < spec.from) {
      return { ok: false, reason: "période invalide (fin avant début)" };
    }
    // Un filtre explicite sur la MÊME colonne serait écrasé par la période :
    // le chiffre rendu serait plus large que demandé, sans un mot.
    if (filters.some((entry) => entry.column === field.column)) {
      return {
        ok: false,
        reason: `« ${field.description} » est déjà filtré : utilisez la période OU le filtre`,
      };
    }
    dateColumn = field.column;
  }

  // `NaN` traverserait Math.min/Math.max sans broncher et deviendrait un
  // `take` invalide : une limite non entière retombe sur le défaut.
  const requested = Number.isInteger(spec.limit) ? (spec.limit as number) : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(requested, 1), MAX_QUERY_LIMIT);
  return {
    ok: true,
    plan: {
      dataset,
      model: dataset.model,
      aggregate: spec.aggregate,
      measureColumn,
      groupByColumn,
      filters,
      dateColumn,
      from: spec.from ?? null,
      to: spec.to ?? null,
      limit,
      labels: { dataset: dataset.label, measure: measureLabel, groupBy: groupByLabel },
    },
  };
}

/** Description du catalogue destinée au modèle (pas de valeurs, que la forme). */
export function describeCatalog(
  role: string,
  inactiveModules: ReadonlySet<string> = new Set(),
): string {
  return visibleDatasets(role, inactiveModules)
    .map((dataset) => {
      const dimensions = dataset.dimensions
        .filter((field) => !field.ownerOnly || role === "owner")
        .map((field) => field.name)
        .join(", ");
      const measures = dataset.measures
        .filter((field) => !field.ownerOnly || role === "owner")
        .map((field) => field.name)
        .join(", ");
      return `- ${dataset.id} (${dataset.label}) : dimensions [${dimensions}]${
        measures ? ` ; grandeurs [${measures}]` : " ; aucune grandeur"
      }`;
    })
    .join("\n");
}
