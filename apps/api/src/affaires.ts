import { splitRevenus } from "@nodaq/shared";
import type { RevenusSplit } from "@nodaq/shared";
import { z } from "zod";
import {
  computeAffaireMargin,
  type AffaireCostInput,
  type AffaireImputationInput,
  type AffaireMargin,
} from "@nodaq/shared";
import type { TenantClient } from "@nodaq/db";

/*
 * Affaires (ticket 4.1) — accès données et assemblage du calcul.
 *
 * Ce module ne décide RIEN sur les chiffres : il rassemble des entrées et
 * délègue à `computeAffaireMargin` (TS pur, testé contre des cas calculés à la
 * main). Le jour où une règle de marge change, elle change à un seul endroit.
 */

/** Statuts — l'ordre est celui du cycle de vie, il pilote aussi l'affichage. */
export const AFFAIRE_STATUSES = [
  "PROSPECT",
  "DEVIS_ENVOYE",
  "ACCEPTEE",
  "EN_COURS",
  "TERMINEE",
  "PERDUE",
  "ARCHIVEE",
] as const;

export const AFFAIRE_TARGET_TYPES = [
  "classeur_document",
  "transaction_bancaire",
  "facture",
  "charge",
] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Création — seul `label` est exigé : une affaire naît souvent d'un coup de fil. */
export const AffaireCreateInput = z.object({
  label: z.string().min(1).max(200),
  clientName: z.string().min(1).max(200).nullable().optional(),
  prospectId: z.string().uuid().nullable().optional(),
  status: z.enum(AFFAIRE_STATUSES).optional(),
  address: z.string().max(500).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  quotedAmountCents: z.number().int().min(0).nullable().optional(),
  vatRateBps: z.number().int().min(0).max(10_000).nullable().optional(),
  estimatedHours: z.number().int().min(0).nullable().optional(),
  hoursWorked: z.number().int().min(0).nullable().optional(),
  estimatedMaterialCents: z.number().int().min(0).nullable().optional(),
  depositsCents: z.number().int().min(0).nullable().optional(),
  retentionRateBps: z.number().int().min(0).max(10_000).nullable().optional(),
  retentionReleaseDate: isoDate.nullable().optional(),
  startDate: isoDate.nullable().optional(),
  plannedEndDate: isoDate.nullable().optional(),
  actualEndDate: isoDate.nullable().optional(),
});

export const AffaireUpdateInput = AffaireCreateInput.partial();

export const AffaireImputeInput = z.object({
  targetType: z.enum(AFFAIRE_TARGET_TYPES),
  targetId: z.string().min(1).max(200),
  source: z.enum(["AUTO", "CONFIRMEE", "MANUELLE"]).optional(),
  // `.min(0)` N'EST PAS DÉCORATIF : sans lui, une imputation à −5 000 € donnait
  // un coût matière négatif, donc une marge SUPÉRIEURE au devis, présentée comme
  // exacte — et c'était ouvert au rôle le moins privilégié. Un avoir se
  // modélise en révoquant une imputation, jamais par un coût négatif.
  // `.max()` borne la conversion BigInt -> Number côté lecture.
  amountCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  amountBasis: z.enum(["ht", "ttc"]).nullable().optional(),
  subcontract: z.boolean().optional(),
});

/** Un montant sans base, ou une base sans montant, ne veut rien dire. */
export function imputationAmountIsCoherent(input: {
  amountCents?: number | null | undefined;
  amountBasis?: "ht" | "ttc" | null | undefined;
}): boolean {
  const hasAmount = (input.amountCents ?? null) !== null;
  const hasBasis = (input.amountBasis ?? null) !== null;
  return hasAmount === hasBasis;
}

const toNumber = (value: bigint | null): number | null => (value === null ? null : Number(value));

interface AffaireRow {
  quotedAmountCents: bigint | null;
  hoursWorked: number | null;
  estimatedMaterialCents: bigint | null;
  depositsCents: bigint | null;
  retentionRateBps: number | null;
}

interface ImputationRow {
  targetType: string;
  amountCents: bigint | null;
  amountBasis: string | null;
  subcontract: boolean;
}

/**
 * Assemble les entrées du calcul.
 *
 * `hourlyCostCents` vient du profil tenant et vaut `null` tant qu'il n'a pas été
 * saisi : c'est ce `null` qui fera basculer la marge en borne supérieure plutôt
 * que de compter zéro heure de travail.
 */
export function buildCostInput(
  affaire: AffaireRow,
  imputations: readonly ImputationRow[],
  invoicedCents: number,
  hourlyCostCents: number | null,
): AffaireCostInput {
  return {
    quotedAmountCents: toNumber(affaire.quotedAmountCents),
    imputations: imputations.map(
      (row): AffaireImputationInput => ({
        targetType: row.targetType as AffaireImputationInput["targetType"],
        amountCents: toNumber(row.amountCents),
        amountBasis: (row.amountBasis as "ht" | "ttc" | null) ?? null,
        subcontract: row.subcontract,
      }),
    ),
    hoursWorked: affaire.hoursWorked,
    hourlyCostCents,
    invoicedCents,
    // Les factures dérivées du FEC somment les DÉBITS du compte 411 : c'est du
    // TTC. Le devis, lui, est du HT. Le moteur refusera donc de soustraire l'un
    // de l'autre et le dira, au lieu de sous-estimer le reste à facturer
    // d'environ la TVA — ce qui ferait arrêter de facturer trop tôt.
    invoicedBasis: "ttc",
    // « Non renseigné » vaut zéro DANS LE CALCUL (on n'invente pas d'acompte),
    // mais l'écran, lui, doit distinguer les deux : il lit le champ, pas ceci.
    depositsCents: toNumber(affaire.depositsCents) ?? 0,
    retentionRateBps: affaire.retentionRateBps,
    estimatedMaterialCents: toNumber(affaire.estimatedMaterialCents),
  };
}

/** Charge une affaire et calcule sa marge. `null` si elle n'existe pas (ou autre tenant). */
export async function loadAffaireMargin(
  tx: TenantClient,
  affaireId: string,
  hourlyCostCents: number | null,
): Promise<{ margin: AffaireMargin; invoicedCents: number } | null> {
  const affaire = await tx.affaire.findUnique({ where: { id: affaireId } });
  if (!affaire) return null;
  const [imputations, invoices] = await Promise.all([
    // `source: AUTO` exclu par ceinture ET bretelles : la route d'imputation le
    // refuse déjà, mais si une ligne AUTO apparaissait un jour (import, futur
    // outil d'agent), elle ne doit pas entrer dans une marge sans validation.
    tx.affaireImputation.findMany({
      where: { affaireId, revokedAt: null, source: { not: "AUTO" } },
    }),
    tx.fecInvoice.findMany({ where: { affaireId } }),
  ]);
  const invoicedCents = invoices.reduce((total, invoice) => total + Number(invoice.amountCents), 0);
  return {
    margin: computeAffaireMargin(buildCostInput(affaire, imputations, invoicedCents, hourlyCostCents)),
    invoicedCents,
  };
}

/** Sérialisation d'une affaire — les BigInt ne passent pas JSON.stringify. */
export function serializeAffaire(affaire: {
  id: string;
  reference: string;
  label: string;
  clientName: string | null;
  prospectId: string | null;
  status: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  quotedAmountCents: bigint | null;
  vatRateBps: number | null;
  estimatedHours: number | null;
  hoursWorked: number | null;
  estimatedMaterialCents: bigint | null;
  depositsCents: bigint | null;
  retentionRateBps: number | null;
  retentionReleaseDate: Date | null;
  startDate: Date | null;
  plannedEndDate: Date | null;
  actualEndDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  const day = (date: Date | null): string | null => date?.toISOString().slice(0, 10) ?? null;
  return {
    id: affaire.id,
    reference: affaire.reference,
    label: affaire.label,
    clientName: affaire.clientName,
    prospectId: affaire.prospectId,
    status: affaire.status,
    address: affaire.address,
    latitude: affaire.latitude,
    longitude: affaire.longitude,
    quotedAmountCents: toNumber(affaire.quotedAmountCents),
    vatRateBps: affaire.vatRateBps,
    estimatedHours: affaire.estimatedHours,
    hoursWorked: affaire.hoursWorked,
    estimatedMaterialCents: toNumber(affaire.estimatedMaterialCents),
    depositsCents: toNumber(affaire.depositsCents),
    retentionRateBps: affaire.retentionRateBps,
    retentionReleaseDate: day(affaire.retentionReleaseDate),
    startDate: day(affaire.startDate),
    plannedEndDate: day(affaire.plannedEndDate),
    actualEndDate: day(affaire.actualEndDate),
    createdAt: affaire.createdAt.toISOString(),
    updatedAt: affaire.updatedAt.toISOString(),
  };
}

/** Champs de date à convertir avant écriture Prisma. */
export function toPrismaData(input: z.infer<typeof AffaireUpdateInput>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (
      (key === "retentionReleaseDate" ||
        key === "startDate" ||
        key === "plannedEndDate" ||
        key === "actualEndDate") &&
      typeof value === "string"
    ) {
      data[key] = new Date(`${value}T00:00:00.000Z`);
    } else if (
      (key === "quotedAmountCents" ||
        key === "estimatedMaterialCents" ||
        key === "depositsCents") &&
      typeof value === "number"
    ) {
      data[key] = BigInt(value);
    } else {
      data[key] = value;
    }
  }
  return data;
}

/*
 * F4 — la marge de CHAQUE affaire, pour le cockpit.
 *
 * Le patron ne veut pas ouvrir douze fiches : il veut savoir, en ouvrant son
 * cockpit, lequel de ses chantiers perd de l'argent. Mais un classement mélange
 * des choses qui ne se comparent pas — une marge exacte, un plafond, et une
 * affaire dont on ne sait rien. Trier les trois ensemble ferait passer
 * « inconnu » pour « va bien », ce qui est exactement le mensonge que 4.1
 * refuse. D'où trois groupes SÉPARÉS, et un compteur pour ceux qu'on ne sait
 * pas chiffrer.
 */

/** Bornes de lecture : une vue de cockpit doit avoir un coût borné. */
export const AFFAIRES_MARGIN_SCAN_LIMIT = 100;

export interface AffaireMarginRow {
  readonly id: string;
  readonly reference: string;
  readonly label: string;
  readonly status: string;
  readonly margin: AffaireMargin;
}

export interface AffairesMarginsView {
  /** Marge connue (exacte ou plafond) et NÉGATIVE, ou budget matière dépassé. */
  readonly aSurveiller: readonly AffaireMarginRow[];
  /** Marge EXACTE et positive. Rien d'autre n'a le droit d'être « dans le vert ». */
  readonly chiffrables: readonly AffaireMarginRow[];
  /**
   * Plafond positif : « au mieux X », marge réelle INCONNUE.
   *
   * Ce groupe existe parce que le ranger avec les saines était une faute — et
   * c'est le flux NOMINAL du produit : coût horaire non renseigné, heures
   * inconnues ou pièces en TTC suffisent à produire un plafond proche du devis
   * entier, pendant que la marge réelle est négative. Compté avec les
   * rentables, ça donnait « 3 chantiers dans le vert » sur trois chantiers dont
   * on ne sait rien.
   */
  readonly sousReserve: readonly AffaireMarginRow[];
  /** Ni marge ni plafond : comptées et NOMMÉES, jamais classées comme saines. */
  readonly nonChiffrables: readonly AffaireMarginRow[];
  /** Affaires ouvertes au-delà de la borne de lecture — dit, jamais tu. */
  readonly ignorees: number;
}

/**
 * Marge « au pire connu » d'une affaire, ou `null` si rien n'est chiffrable.
 *
 * EXPORTÉE parce que le brief du matin (F5) doit décider « en perte » avec
 * EXACTEMENT cette règle : la réécrire ailleurs, c'est garantir qu'un jour la
 * carte du cockpit et le brief se contrediront sur le même chantier.
 */
export function comparableMargin(margin: AffaireMargin): number | null {
  if (margin.kind === "marge") return margin.marginCents;
  // Un PLAFOND négatif est une information forte : même au mieux, ce chantier
  // perd de l'argent. Un plafond positif, lui, ne dit rien de la réalité.
  if (margin.kind === "marge_borne_superieure") return margin.upperBoundCents;
  return null;
}

/**
 * Un chantier sur lequel il faut regarder maintenant.
 *
 * LIMITE : le dépassement de budget matière ne peut PAS se déclencher sur une
 * affaire sans devis (`couts_seuls`), le moteur rendant avant d'avoir calculé
 * l'écart. Ces affaires sortent en `nonChiffrables`, où elles sont nommées —
 * mais leur dérive de budget, elle, n'est pas détectée.
 */
function needsAttention(margin: AffaireMargin): boolean {
  const value = comparableMargin(margin);
  if (value !== null && value < 0) return true;
  if (margin.kind === "marge" || margin.kind === "marge_borne_superieure") {
    // Dépassement du budget matière : le chantier peut encore être rentable et
    // déjà déraper. C'est le signal qui arrive assez tôt pour agir.
    return (margin.budgetGap?.deltaCents ?? 0) > 0;
  }
  return false;
}

/**
 * Calcule la marge de toutes les affaires ouvertes, en trois requêtes au total
 * (affaires, imputations, factures) — jamais une requête par affaire.
 */
export async function loadAffairesMargins(
  tx: TenantClient,
  hourlyCostCents: number | null,
  limit: number = AFFAIRES_MARGIN_SCAN_LIMIT,
): Promise<AffairesMarginsView> {
  const openStatuses = ["EN_COURS", "ACCEPTEE"];
  const total = await tx.affaire.count({ where: { status: { in: openStatuses } } });
  const affaires = await tx.affaire.findMany({
    take: limit,
    orderBy: [{ createdAt: "desc" }],
    where: { status: { in: openStatuses } },
  });
  if (affaires.length === 0) {
    return { aSurveiller: [], chiffrables: [], sousReserve: [], nonChiffrables: [], ignorees: 0 };
  }

  const ids = affaires.map((affaire) => affaire.id);
  const [imputations, invoices] = await Promise.all([
    tx.affaireImputation.findMany({
      where: { affaireId: { in: ids }, revokedAt: null, source: { not: "AUTO" } },
    }),
    tx.fecInvoice.findMany({ where: { affaireId: { in: ids } } }),
  ]);

  const byAffaire = new Map<string, typeof imputations>();
  for (const imputation of imputations) {
    const list = byAffaire.get(imputation.affaireId) ?? [];
    list.push(imputation);
    byAffaire.set(imputation.affaireId, list);
  }
  const invoicedByAffaire = new Map<string, number>();
  for (const invoice of invoices) {
    if (invoice.affaireId === null) continue;
    invoicedByAffaire.set(
      invoice.affaireId,
      (invoicedByAffaire.get(invoice.affaireId) ?? 0) + Number(invoice.amountCents),
    );
  }

  const rows: AffaireMarginRow[] = affaires.map((affaire) => ({
    id: affaire.id,
    reference: affaire.reference,
    label: affaire.label,
    status: affaire.status,
    margin: computeAffaireMargin(
      buildCostInput(
        affaire,
        byAffaire.get(affaire.id) ?? [],
        invoicedByAffaire.get(affaire.id) ?? 0,
        hourlyCostCents,
      ),
    ),
  }));

  const aSurveiller = rows
    .filter((row) => needsAttention(row.margin))
    // Le pire en premier : c'est celui sur lequel on peut encore agir.
    .sort((a, b) => (comparableMargin(a.margin) ?? 0) - (comparableMargin(b.margin) ?? 0));
  // « Dans le vert » exige une marge EXACTE. Un plafond positif ne dit rien de
  // la réalité — le commentaire de `comparableMargin` le disait déjà, le tri ne
  // le respectait pas.
  const chiffrables = rows
    .filter((row) => !needsAttention(row.margin) && row.margin.kind === "marge")
    .sort((a, b) => (comparableMargin(a.margin) ?? 0) - (comparableMargin(b.margin) ?? 0));
  const sousReserve = rows
    .filter((row) => !needsAttention(row.margin) && row.margin.kind === "marge_borne_superieure")
    .sort((a, b) => (comparableMargin(a.margin) ?? 0) - (comparableMargin(b.margin) ?? 0));
  const nonChiffrables = rows.filter((row) => comparableMargin(row.margin) === null);

  return {
    aSurveiller,
    chiffrables,
    sousReserve,
    nonChiffrables,
    // Une troncature silencieuse ferait disparaître des chantiers d'un écran
    // censé les surveiller.
    ignorees: Math.max(0, total - affaires.length),
  };
}

/**
 * Borne de lecture du découpage des revenus (4.2 bloc 3).
 *
 * Généreuse à dessein : la troncature sacrifierait D'ABORD l'acquis. Les
 * affaires terminées sont les plus anciennes, donc les premières coupées par
 * un `createdAt desc` — le chiffre du travail livré serait rogné pendant que
 * l'engagé, récent, resterait complet. Atteinte ⇒ DITE, et `exact` tombe.
 */
export const AFFAIRES_REVENUS_SCAN_LIMIT = 5_000;

export interface RevenusSplitView extends RevenusSplit {
  /** Affaires non examinées faute de place — jamais une troncature muette. */
  readonly ignorees: number;
}

/**
 * Charge de quoi séparer encaissé, engagé et acquis.
 *
 * TROIS CHOIX QUI COMPTENT.
 *
 * 1. **Requête distincte de celle des marges.** `loadAffairesMargins` ne
 *    regarde que les affaires ouvertes (`EN_COURS`, `ACCEPTEE`), alors que
 *    l'acquis vit précisément dans les terminées. Réutiliser la même aurait
 *    donné un acquis structurellement nul — un chiffre faux qui ne se serait
 *    jamais fait remarquer, puisqu'il aurait eu l'air d'un démarrage
 *    tranquille.
 *
 * 2. **Les archivées sont chargées**, pour que ranger une affaire livrée ne
 *    fasse pas baisser le chiffre d'affaires acquis d'un exercice.
 *
 * 3. **Le réglé des factures est agrégé sur TOUT le tenant**, pas seulement
 *    sur les factures rattachées à une affaire. Le rattachement est nullable
 *    et l'absence de rattachement est le cas MAJORITAIRE : ne compter que les
 *    factures rattachées afficherait « encaissé » sur une fraction de
 *    l'encaissé, sous un libellé qui promet le compte en banque.
 */
export async function loadRevenusSplit(
  tx: TenantClient,
  limit: number = AFFAIRES_REVENUS_SCAN_LIMIT,
): Promise<RevenusSplitView> {
  /*
   * TOUS les statuts, y compris `PERDUE` et `DEVIS_ENVOYE`.
   *
   * L'acquis et l'engagé n'en retiennent qu'une partie, mais l'ENCAISSÉ
   * DÉCLARÉ se compte quel que soit le statut : un acompte reçu sur une
   * affaire finalement perdue est quand même sur le compte. Ne charger que
   * les statuts « utiles » rendait cet invariant — écrit dans le moteur et
   * dans le doc — inatteignable depuis la route.
   */
  const statuses = [
    "PROSPECT",
    "DEVIS_ENVOYE",
    "ACCEPTEE",
    "EN_COURS",
    "TERMINEE",
    "PERDUE",
    "ARCHIVEE",
  ];
  const total = await tx.affaire.count({ where: { status: { in: statuses } } });
  const affaires = await tx.affaire.findMany({
    take: limit,
    // `id` en second critère : à égalité de `createdAt`, l'ensemble tronqué
    // serait sinon non déterministe, et le chiffre varierait d'un appel à
    // l'autre à la borne.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    where: { status: { in: statuses } },
    select: {
      status: true,
      quotedAmountCents: true,
      depositsCents: true,
    },
  });

  /*
   * RÉGLÉ = facturé − résiduel, moins la RETENUE ENCORE DÉTENUE.
   *
   * Deux pièges, et le second a coûté une revue.
   *
   * 1. `residualCents` exclut la retenue par construction (la dérivation FEC
   *    la sort du reste dû), donc `facturé − résiduel` la CONTIENT. Sans
   *    correction, une facture de 10 000 € avec 500 € de retenue ressortirait
   *    à 10 000 € encaissés le jour où le client en verse 9 500.
   *
   * 2. Mais soustraire `fec_invoices.retained_cents` LIGNE À LIGNE est faux
   *    aussi : c'est « la retenue portée par cette pièce », pas la retenue
   *    encore due. Une libération se comptabilise souvent sous sa PROPRE
   *    pièce, et la facture d'origine garde son `retained_cents` à vie — les
   *    500 € seraient amputés pour toujours, même une fois versés.
   *
   * On soustrait donc le SOLDE du compte 4117, que le ticket 2.20 a déjà
   * calculé et stocké sur l'import (`fec_imports.retained_cents`) exactement
   * pour cette raison : un solde n'a rien à rattacher, il est juste par
   * construction.
   */
  const regle = await tx.$queryRaw<{ paid: bigint | null }[]>`
    SELECT SUM(amount_cents - residual_cents)::bigint AS paid FROM fec_invoices`;
  const dernierImport = await tx.fecImport.findFirst({
    orderBy: { importedAt: "desc" },
    select: { retainedCents: true },
  });
  /*
   * `null` et non `0` quand aucun FEC n'a jamais été importé.
   *
   * Un zéro se lirait « rien n'est rentré » à côté d'un acquis non nul, alors
   * que la vraie réponse est « je n'ai pas de source comptable ». C'est la
   * différence entre un chiffre et une absence de chiffre.
   */
  const encaisseFactureCents =
    dernierImport === null
      ? null
      : Math.max(0, Number(regle[0]?.paid ?? 0n) - Number(dernierImport.retainedCents));

  const split = splitRevenus(
    affaires.map((affaire) => ({
      status: affaire.status,
      quotedAmountCents:
        affaire.quotedAmountCents === null ? null : Number(affaire.quotedAmountCents),
      depositsCents: Number(affaire.depositsCents ?? 0),
    })),
    encaisseFactureCents,
  );

  const ignorees = Math.max(0, total - affaires.length);
  // `exact` est recalculé ICI : le moteur pur ne connaît pas la troncature, et
  // rendre `{ exact: true, ignorees: 500 }` ferait lire « exact » sur un
  // chiffre amputé à tout consommateur autre que l'écran.
  return { ...split, ignorees, exact: split.exact && ignorees === 0 };
}
