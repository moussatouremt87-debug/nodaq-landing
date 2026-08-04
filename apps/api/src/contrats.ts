import { z } from "zod";
import { CADENCES, planOccurrences } from "@nodaq/shared";
import type { RecurrencePlan } from "@nodaq/shared";

/*
 * Contrats récurrents (ticket 4.2, bloc 2) — sérialisation et validation.
 *
 * Le MOTEUR est dans `@nodaq/shared` (`recurrence.ts`), pur et testé contre
 * des cas calculés à la main. Ce fichier ne fait que la frontière : valider ce
 * qui entre, rendre ce qui sort, et calculer le plan à la LECTURE — jamais le
 * stocker. Un plan stocké devient faux le lendemain sans que personne l'écrive.
 */

export const CONTRAT_STATUSES = ["ACTIF", "SUSPENDU", "TERMINE"] as const;

/**
 * Aujourd'hui, en date CIVILE FRANÇAISE — jamais `toISOString()`.
 *
 * Entre minuit et 2 h à Paris, `toISOString().slice(0, 10)` rend la VEILLE.
 * Le brief calcule déjà sa date ainsi ; s'en écarter ici ferait que, deux
 * heures par nuit, le brief annonce une échéance due que la liste des contrats
 * et la matérialisation refusent encore de voir. Une seule horloge civile pour
 * tout le produit.
 */
export function todayCivilIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(now);
}

/**
 * Date civile `YYYY-MM-DD`. Jamais un `Date` : voir l'en-tête de `recurrence.ts`.
 *
 * La forme NE SUFFIT PAS. `new Date("2026-02-30")` ne lève pas : JS reporte au
 * 2 mars, silencieusement — un contrat « tous les 30 février » serait accepté
 * puis planifierait des passages en mars. Et `"2026-13-45"` donne un
 * `Invalid Date` qui remonterait en 500 Prisma au lieu d'un 400 motivé. On
 * vérifie donc que la date EXISTE, pas seulement qu'elle en a l'air.
 */
const CivilDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date attendue au format YYYY-MM-DD")
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    if (year === undefined || month === undefined || day === undefined) return false;
    const probe = new Date(Date.UTC(year, month - 1, day));
    // Recomposée : si le calendrier a « corrigé » l'entrée, ce n'est pas une date.
    return (
      probe.getUTCFullYear() === year &&
      probe.getUTCMonth() === month - 1 &&
      probe.getUTCDate() === day
    );
  }, "date inexistante au calendrier");

export const ContratCreateInput = z
  .object({
    label: z.string().trim().min(1).max(200),
    clientName: z.string().trim().min(1).max(200).nullable().optional(),
    cadence: z.enum(CADENCES),
    /*
     * Montant HT PAR PÉRIODE, jamais le total du contrat — et c'est la borne
     * qui empêche la marge de mentir. Un contrat à 200 €/mois enregistré
     * comme « 2 400 € » se retrouverait devisé en entier sur la PREMIÈRE
     * intervention générée : une marge flatteuse sur un chantier, et onze
     * chantiers à zéro. Une marge trop belle est pire qu'une absence de marge.
     */
    amountCents: z.number().int().min(0).nullable().optional(),
    vatRateBps: z.number().int().min(0).max(10_000).nullable().optional(),
    startDate: CivilDate.nullable().optional(),
    endDate: CivilDate.nullable().optional(),
    notes: z.string().trim().max(2_000).nullable().optional(),
  })
  .strict();

export const ContratUpdateInput = ContratCreateInput.partial()
  .extend({
    status: z.enum(CONTRAT_STATUSES).optional(),
    /*
     * REMBOBINAGE explicite du curseur de matérialisation.
     *
     * Sans ce champ, une affaire générée par erreur puis archivée ne pouvait
     * plus jamais être régénérée : le curseur avait avancé, et rien ne le
     * disait. `null` remet le contrat à zéro — toutes les échéances passées
     * redeviennent dues.
     *
     * C'est une porte volontairement ouverte : elle permet de recréer des
     * doublons si on s'en sert mal. Le curseur n'avance jamais tout seul et ne
     * recule jamais tout seul non plus ; c'est une décision humaine dans les
     * deux sens.
     */
    lastOccurrenceDate: CivilDate.nullable().optional(),
  })
  .strict();

/** `YYYY-MM-DD` depuis une colonne `@db.Date`, sans passer par le fuseau local. */
export function toCivilDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/**
 * `@db.Date` depuis une date civile — **midi UTC**, jamais minuit.
 *
 * Minuit UTC reculerait d'un jour dès qu'un fuseau négatif entre en jeu, et
 * une échéance « le 15 » deviendrait « le 14 » pour la moitié de la planète.
 * Midi laisse douze heures de marge de part et d'autre.
 */
export function toDbDateRequired(value: string): Date {
  return new Date(`${value}T12:00:00.000Z`);
}

/** Variante tolérante, pour les champs facultatifs d'une mise à jour Prisma. */
export function toDbDate(value: string | null | undefined): Date | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return toDbDateRequired(value);
}

export interface ContratRow {
  id: string;
  label: string;
  clientName: string | null;
  cadence: string;
  amountCents: bigint | null;
  vatRateBps: number | null;
  startDate: Date | null;
  endDate: Date | null;
  lastOccurrenceDate: Date | null;
  status: string;
  notes: string | null;
}

const toNumber = (value: bigint | null): number | null =>
  value === null ? null : Number(value);

/**
 * Le contrat + son PLAN, calculé à la lecture.
 *
 * Le plan n'est pas persisté : il dépend de la date du jour, donc une valeur
 * stockée serait fausse dès le lendemain — et fausse en silence, ce qui est
 * pire qu'absente. `lastOccurrenceDate`, elle, est un FAIT (une affaire a été
 * créée) : c'est la seule chose qui mérite d'être écrite.
 */
export function serializeContrat(contrat: ContratRow, todayIso: string) {
  const plan: RecurrencePlan = planOccurrences(
    {
      cadence: contrat.cadence as (typeof CADENCES)[number],
      startDate: toCivilDate(contrat.startDate),
      endDate: toCivilDate(contrat.endDate),
      lastOccurrenceDate: toCivilDate(contrat.lastOccurrenceDate),
    },
    todayIso,
  );
  return {
    id: contrat.id,
    label: contrat.label,
    clientName: contrat.clientName,
    cadence: contrat.cadence,
    amountCents: toNumber(contrat.amountCents),
    vatRateBps: contrat.vatRateBps,
    startDate: toCivilDate(contrat.startDate),
    endDate: toCivilDate(contrat.endDate),
    lastOccurrenceDate: toCivilDate(contrat.lastOccurrenceDate),
    status: contrat.status,
    notes: contrat.notes,
    /*
     * Un contrat SUSPENDU ou TERMINÉ ne doit rien : sa suspension est une
     * décision humaine, et continuer à lui compter des retards en ferait une
     * décision sans effet.
     *
     * Neutralisé ENTIÈREMENT, motif compris : garder un `reason` de troncature
     * sur un plan vidé ferait dire à l'écran « tronqué à 24 échéances » sous
     * une liste vide — un message qui ne correspond plus à rien de rendu.
     */
    plan:
      contrat.status === "ACTIF"
        ? plan
        : { due: [], next: plan.next, truncated: false, ended: plan.ended, reason: null },
  };
}

export type SerializedContrat = ReturnType<typeof serializeContrat>;

export interface ContratsEchusSummary {
  readonly contrats: number;
  readonly echeances: number;
  readonly plusAncienne: string | null;
}

/**
 * Ce que les contrats doivent, pour le brief du matin. PURE.
 *
 * Seuls les contrats ACTIFS comptent : un contrat suspendu ou terminé qui
 * ferait grossir le compteur du brief transformerait une décision humaine
 * (suspendre) en alerte quotidienne, et le brief qu'on cesse d'ouvrir est
 * celui qui hurle au loup.
 */
export function summarizeDueContracts(
  rows: readonly ContratRow[],
  todayIso: string,
): ContratsEchusSummary {
  let contrats = 0;
  let echeances = 0;
  let plusAncienne: string | null = null;
  for (const row of rows) {
    if (row.status !== "ACTIF") continue;
    const plan = serializeContrat(row, todayIso).plan;
    if (plan.due.length === 0) continue;
    contrats += 1;
    echeances += plan.due.length;
    const oldest = plan.due[0];
    if (oldest !== undefined && (plusAncienne === null || oldest < plusAncienne)) {
      plusAncienne = oldest;
    }
  }
  return { contrats, echeances, plusAncienne };
}

/** Champs Prisma d'une création/mise à jour, dates converties. */
export function toContratData(
  input: z.infer<typeof ContratUpdateInput>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (key === "startDate" || key === "endDate" || key === "lastOccurrenceDate") {
      data[key] = toDbDate(value as string | null);
      continue;
    }
    data[key] = value;
  }
  return data;
}
