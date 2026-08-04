/*
 * Récurrence des contrats (ticket 4.2, bloc 2) — MOTEUR PUR.
 *
 * POURQUOI CETTE BRIQUE EST GÉNÉRIQUE. Un contrat d'entretien de paysagiste,
 * un contrat de maintenance, un forfait mensuel de prestation : c'est la même
 * mécanique — une date de départ, un pas, une fin éventuelle. Écrire trois
 * moteurs parce que le vocabulaire diffère, c'est le `if (vertical === …)` que
 * l'ADR-007 interdit, déguisé en feature.
 *
 * DÉTERMINISTE, comme `affaireMargin.ts` : des dates entrent, des dates
 * sortent. Zéro base, zéro LLM, zéro horloge implicite — `todayIso` est
 * TOUJOURS passé par l'appelant. C'est ce qui permet de tester chaque
 * frontière (fin de mois, année bissextile, jour J) contre des cas calculés à
 * la main, et c'est la seule raison d'oser dire à un patron « vous avez trois
 * passages en retard ».
 *
 * LES DATES SONT DES CHAÎNES `YYYY-MM-DD`, jamais des `Date`. Une échéance de
 * contrat est une date CIVILE : « le 15 du mois » ne dépend pas du fuseau de
 * celui qui regarde l'écran, et un `Date` la ferait glisser d'un jour selon
 * l'heure du serveur — le genre de bug qui ne se voit qu'en production, un
 * soir d'été.
 */

/** Bump à chaque changement de cadence ou de règle de calcul. */
export const RECURRENCE_VERSION = "2026-08-04";

export const CADENCES = ["mensuel", "trimestriel", "semestriel", "annuel"] as const;
export type Cadence = (typeof CADENCES)[number];

/** Pas de chaque cadence, en mois. Exhaustif par construction. */
export const CADENCE_MONTHS: Record<Cadence, number> = {
  mensuel: 1,
  trimestriel: 3,
  semestriel: 6,
  annuel: 12,
};

/**
 * Combien d'échéances en retard un seul plan peut porter.
 *
 * Sans borne, un contrat mensuel oublié depuis six ans proposerait
 * soixante-douze affaires d'un coup : une file de validation inutilisable, et
 * une base polluée par un clic. La borne est atteinte ⇒ `truncated`, et le
 * motif est rendu — un rattrapage silencieusement partiel laisserait croire
 * que tout est à jour.
 */
export const MAX_DUE_OCCURRENCES = 24;

export interface RecurrenceInput {
  readonly cadence: Cadence;
  /** Ancrage du calendrier. `null` = rien à planifier (refus motivé). */
  readonly startDate: string | null;
  /** Fin éventuelle, incluse. `null` = contrat sans terme. */
  readonly endDate: string | null;
  /** Dernière échéance DÉJÀ matérialisée en affaire. `null` = aucune. */
  readonly lastOccurrenceDate: string | null;
}

export interface RecurrencePlan {
  /** Échéances échues et non matérialisées, des plus anciennes aux plus récentes. */
  readonly due: readonly string[];
  /** Prochaine échéance à venir, ou `null` si le contrat est terminé. */
  readonly next: string | null;
  /** La borne a été atteinte : il RESTE des échéances non listées. */
  readonly truncated: boolean;
  /** Le terme est dépassé : plus rien ne sera dû. */
  readonly ended: boolean;
  /** Français, non nul dès qu'il y a quelque chose à expliquer (refus, troncature). */
  readonly reason: string | null;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface CivilDate {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number;
}

function parse(iso: string): CivilDate | null {
  const match = DATE_RE.exec(iso);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

const pad = (value: number): string => String(value).padStart(2, "0");
const format = (date: CivilDate): string =>
  `${String(date.year).padStart(4, "0")}-${pad(date.month)}-${pad(date.day)}`;

/** Dernier jour du mois — la seule règle de calendrier dont ce moteur a besoin. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Ordre civil, sans passer par `Date` : comparer `YYYY-MM-DD` suffit. */
const isAfter = (a: string, b: string): boolean => a > b;
const isSameOrBefore = (a: string, b: string): boolean => a <= b;

/**
 * Ajoute `months` mois à l'ANCRAGE, en bornant au dernier jour du mois.
 *
 * L'ancrage est toujours la date de DÉBUT, jamais l'occurrence précédente, et
 * c'est essentiel : un contrat au 31 janvier donne le 28 février, puis doit
 * revenir au 31 mars. Un moteur qui itérerait à partir du résultat précédent
 * resterait bloqué au 28 pour toujours — le jour d'ancrage serait perdu au
 * premier mois court.
 */
function addMonths(anchor: CivilDate, months: number): CivilDate {
  const total = anchor.year * 12 + (anchor.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return { year, month, day: Math.min(anchor.day, daysInMonth(year, month)) };
}

/**
 * Ce qu'un contrat doit, et quand tombe la suite. PURE.
 *
 * `due` contient les échéances échues (jour J COMPRIS — un passage prévu
 * aujourd'hui est à faire aujourd'hui, le ranger dans « à venir » le ferait
 * disparaître du brief le seul jour où il compte) et non encore matérialisées.
 */
export function planOccurrences(input: RecurrenceInput, todayIso: string): RecurrencePlan {
  const empty = { due: [], next: null, truncated: false, ended: false } as const;

  const anchor = input.startDate === null ? null : parse(input.startDate);
  if (anchor === null) {
    // Un refus est une RÉPONSE : sans ancrage, il n'existe aucune façon de
    // savoir quand le premier passage était dû, et le supposer inventerait
    // des retards que personne n'a promis.
    return { ...empty, reason: "contrat sans date de début — aucune échéance calculable" };
  }
  if (parse(todayIso) === null) {
    return { ...empty, reason: "date du jour illisible — aucune échéance calculable" };
  }

  const end = input.endDate;
  const last = input.lastOccurrenceDate;
  const due: string[] = [];
  let next: string | null = null;
  let truncated = false;

  const step = CADENCE_MONTHS[input.cadence];

  /*
   * AVANCE RAPIDE jusqu'à la première occurrence qui puisse compter.
   *
   * Sans elle, un contrat mensuel démarré il y a vingt ans repartait de son
   * ancrage à CHAQUE lecture : ~240 itérations par contrat, multipliées par
   * les contrats actifs du tenant, à chaque ouverture du brief. Le résultat
   * était juste, le coût gratuit.
   *
   * On saute au mois de la borne la plus tardive entre la dernière échéance
   * matérialisée et l'ancrage — puis on RECULE d'un pas, pour ne jamais
   * dépasser une occurrence que la boucle devait examiner. C'est une
   * optimisation qui ne peut donc pas changer le résultat, seulement le
   * chemin ; les tests de bord (fin de mois, jour J) la couvrent déjà.
   */
  const floor = last !== null && isAfter(last, format(anchor)) ? parse(last) : anchor;
  let startIndex = 0;
  if (floor !== null) {
    const months = (floor.year - anchor.year) * 12 + (floor.month - anchor.month);
    startIndex = Math.max(0, Math.floor(months / step) - 1);
  }
  /*
   * Borne DURE de boucle, indépendante de `MAX_DUE_OCCURRENCES` : celle-ci
   * borne ce qu'on RENVOIE, celle-là garantit qu'on s'arrête. Une date de
   * début aberrante (an 1900) ne doit pas faire tourner une boucle des
   * milliers de fois dans une requête HTTP.
   */
  const HARD_STOP = 4_000;
  /*
   * La boucle s'est-elle arrêtée d'elle-même, ou a-t-elle épuisé sa borne ?
   *
   * FILET, et il faut le dire honnêtement : aucun cas connu n'atteint cette
   * branche aujourd'hui. Une date d'ancrage aberrante (« 0226-01-15 » au lieu
   * de « 2026-01-15 ») remplit `due` et sort par la TRONCATURE, qui porte déjà
   * son motif. Le filet existe pour qu'une évolution du moteur — un pas plus
   * grand, un filtre supplémentaire — ne puisse pas rendre un plan vide et
   * muet sans que personne s'en aperçoive : c'est le « zéro muet » que la
   * doctrine proscrit, et il ne doit pas pouvoir revenir par une porte de
   * derrière.
   */
  let exhausted = true;
  for (let index = startIndex; index < startIndex + HARD_STOP; index += 1) {
    const occurrence = format(addMonths(anchor, index * step));
    if (end !== null && isAfter(occurrence, end)) {
      exhausted = false;
      break;
    }

    if (isSameOrBefore(occurrence, todayIso)) {
      // Échue. Ne la compter que si elle n'a pas déjà été matérialisée.
      if (last === null || isAfter(occurrence, last)) {
        if (due.length >= MAX_DUE_OCCURRENCES) {
          truncated = true;
          exhausted = false;
          break;
        }
        due.push(occurrence);
      }
      continue;
    }
    next = occurrence;
    exhausted = false;
    break;
  }

  if (exhausted) {
    return {
      due,
      next: null,
      truncated: false,
      ended: false,
      reason:
        "date de début trop ancienne pour être planifiée — vérifiez-la (une année à deux chiffres ?)",
    };
  }

  // Terminé = il existe un terme, et plus aucune échéance ne l'attend après
  // aujourd'hui. `next === null` seul ne suffirait pas : la troncature aussi
  // laisse `next` vide, et un contrat tronqué n'est pas un contrat fini.
  const ended = end !== null && !isAfter(end, todayIso) && !truncated;

  return {
    due,
    next: truncated ? null : next,
    truncated,
    ended,
    reason: truncated
      ? `plan tronqué à ${MAX_DUE_OCCURRENCES} échéances — il en reste à rattraper`
      : null,
  };
}
