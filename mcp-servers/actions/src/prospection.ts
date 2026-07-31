/*
 * CRM & prospection (ticket 2.12).
 *
 * C'est le premier ticket qui stocke les données de personnes qui ne sont PAS
 * clientes — des gens qui n'ont rien signé, parfois rien demandé. Le risque
 * n'est donc ni l'injection (2.7) ni l'affirmation (2.11) : c'est la
 * **légitimité de la détention**.
 *
 * Trois gardes STRUCTURELLES, pas trois options d'affichage :
 *
 *  1. **Provenance obligatoire.** Une fiche sans origine déclarée n'existe
 *     pas (`source` est un enum fermé, exigé à la création). Sans elle, on ne
 *     peut ni informer la personne (art. 14) ni justifier l'intérêt légitime.
 *  2. **Opposition = exclusion, pas un filtre.** Un prospect opposé est retiré
 *     de TOUTE liste de relance par le moteur lui-même. Le mettre en option
 *     d'affichage laisserait une requête bien tournée le faire ressortir.
 *  3. **Rétention dite.** Au-delà de la durée de conservation (config
 *     versionnée datée, sourcée CNIL), la fiche est SIGNALÉE — le produit ne
 *     purge jamais en silence, et ne garde jamais sans le dire.
 *
 * Et, en continuité de 2.11 : « à relancer » est une règle DÉTERMINISTE
 * (jours écoulés vs seuil par étape), jamais un jugement de modèle. Le dernier
 * contact est DÉRIVÉ du journal append-only (doctrine 2.9/2.16b) : un champ
 * `lastContactAt` modifiable mentirait tôt ou tard.
 */

import { z } from "zod";
import { INTERACTION_KINDS, PROSPECT_SOURCES, PROSPECT_STAGES } from "@nodaq/shared";
import type { InteractionKind, ProspectSource, ProspectStage } from "@nodaq/shared";

// Vocabulaire partagé avec les routes et les CHECK de la base (@nodaq/shared) :
// une étape acceptée à l'écriture mais inconnue ici rendrait une fiche
// invisible dans le pipeline sans que personne le voie.
export { INTERACTION_KINDS, PROSPECT_SOURCES, PROSPECT_STAGES };
export type { InteractionKind, ProspectSource, ProspectStage };

/** Règles de prospection — un seuil qui bouge change qui est relancé. */
export const PROSPECTION_RULES_VERSION = "2026-07-31";


/**
 * Seuils de relance, en JOURS depuis le dernier contact. Étapes terminales
 * absentes : un dossier gagné ou perdu ne se relance pas.
 */
export const FOLLOWUP_AFTER_DAYS: Partial<Record<ProspectStage, number>> = {
  nouveau: 7,
  contacte: 14,
  qualifie: 21,
  devis_envoye: 10,
};

/**
 * Durée de conservation d'un prospect en base, en MOIS, à compter du dernier
 * contact. La CNIL retient 3 ans pour la prospection commerciale.
 *
 * Source : CNIL, « Durées de conservation — prospection commerciale »
 * (https://www.cnil.fr/fr/conservation-des-donnees), consultée le 2026-07-31.
 */
export const RETENTION_MONTHS = 36;

/** La même durée en jours — c'est elle qui est comparée, et c'est elle que
 * l'écran doit annoncer (mois "de 30 jours" : 36 mois = 1 080 jours). */
export const RETENTION_DAYS = RETENTION_MONTHS * 30;

export const ProspectRecord = z.object({
  id: z.string(),
  name: z.string(),
  company: z.string().nullish(),
  stage: z.enum(PROSPECT_STAGES),
  source: z.enum(PROSPECT_SOURCES),
  optedOut: z.boolean(),
  createdAt: z.string(),
});
export type ProspectRecord = z.infer<typeof ProspectRecord>;

export const InteractionRecord = z.object({
  prospectId: z.string(),
  kind: z.enum(INTERACTION_KINDS),
  occurredAt: z.string(),
});
export type InteractionRecord = z.infer<typeof InteractionRecord>;

export type FollowupVerdict =
  /** Jamais contacté depuis la création, au-delà du seuil de l'étape. */
  | "jamais_contacte"
  /** Dernier contact plus ancien que le seuil de l'étape. */
  | "a_relancer"
  /** Contact récent : rien à faire. */
  | "en_cours"
  /** Étape terminale : gagné ou perdu, hors pipeline actif. */
  | "termine";

export interface ProspectFollowup {
  id: string;
  name: string;
  company: string | null;
  stage: ProspectStage;
  source: ProspectSource;
  /** Dernier contact DÉRIVÉ du journal, `null` si aucun. */
  lastContactAt: string | null;
  /** Jours depuis le dernier contact, ou depuis la création si aucun. */
  daysSinceContact: number;
  thresholdDays: number | null;
  verdict: FollowupVerdict;
  /** Phrase française CHIFFRÉE — le modèle relaie, il ne juge pas. */
  reason: string;
}

export interface ProspectionPlan {
  rulesVersion: string;
  /** Compte par étape, prospects opposés EXCLUS. */
  pipeline: Record<ProspectStage, number>;
  /** À relancer, du plus ancien contact au plus récent. */
  followups: ProspectFollowup[];
  /**
   * Fiches au-delà de la durée de conservation : à purger, jamais en silence.
   * IDS SEULEMENT — l'écran a déjà les noms, et c'est le seul endroit du plan
   * où une personne serait nommée à côté d'un verdict de suppression.
   */
  retentionAlerts: { id: string; daysSinceContact: number }[];
  /**
   * Prospects opposés à la prospection : comptés, JAMAIS listés. Le compte
   * prouve que l'exclusion a eu lieu ; la liste rouvrirait la porte.
   */
  optedOutCount: number;
  /**
   * Fiches OPPOSÉES elles aussi périmées (audit 2.12). Sorties du pipeline,
   * elles échappaient à toute alerte : conservées indéfiniment sans jamais
   * être signalées, l'exact contraire de « ne jamais garder sans le dire ».
   * Un compte suffit — les nommer contredirait l'exclusion.
   */
  expiredOptedOutCount: number;
  /** Fiches ignorées faute de données lisibles (étape ou date invalide). */
  unusableCount: number;
  label: string;
}

const DAY_MS = 86_400_000;

function parseDay(value: string): number | null {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function daysBetween(from: number, to: number): number {
  return Math.max(0, Math.floor((to - from) / DAY_MS));
}

/**
 * Construit le plan de prospection. PURE : aucune I/O, l'horloge est un
 * paramètre.
 *
 * Les prospects opposés sont écartés AVANT toute construction de liste : ils
 * ne peuvent pas réapparaître par un tri, un filtre ou une pagination.
 */
export function buildProspectionPlan(
  prospects: readonly ProspectRecord[],
  interactions: readonly InteractionRecord[],
  now: Date,
): ProspectionPlan {
  const nowMs = now.getTime();

  // Dernier contact par prospect, DÉRIVÉ du journal append-only. Rien n'est
  // stocké : un champ mis à jour à la main finit par mentir.
  const lastContact = new Map<string, number>();
  for (const interaction of interactions) {
    const at = parseDay(interaction.occurredAt);
    if (at === null) continue;
    const previous = lastContact.get(interaction.prospectId);
    if (previous === undefined || at > previous) lastContact.set(interaction.prospectId, at);
  }

  const pipeline = Object.fromEntries(
    PROSPECT_STAGES.map((stage) => [stage, 0]),
  ) as Record<ProspectStage, number>;
  const followups: ProspectFollowup[] = [];
  const retentionAlerts: ProspectionPlan["retentionAlerts"] = [];
  let optedOutCount = 0;
  let expiredOptedOutCount = 0;
  let unusableCount = 0;

  for (const prospect of prospects) {
    const createdAt = parseDay(prospect.createdAt);
    if (createdAt === null) {
      unusableCount += 1;
      continue;
    }
    const contactedAt = lastContact.get(prospect.id) ?? null;
    // Rétention : comptée depuis le dernier contact (ou la création si la
    // personne n'a jamais été contactée), comme la recommandation CNIL.
    const daysSinceContact = daysBetween(contactedAt ?? createdAt, nowMs);
    const expired = daysSinceContact >= RETENTION_DAYS;

    // Opposition (art. 21) : sortie IMMÉDIATE de toute liste de relance.
    // Aucune branche en aval ne peut la remettre dedans — c'est la seule
    // garantie qui tienne. Elle reste comptée dans l'expiration : sortir du
    // pipeline ne doit pas valoir droit d'être conservée pour toujours.
    if (prospect.optedOut) {
      optedOutCount += 1;
      if (expired) expiredOptedOutCount += 1;
      continue;
    }
    pipeline[prospect.stage] += 1;

    if (expired) retentionAlerts.push({ id: prospect.id, daysSinceContact });

    const thresholdDays = FOLLOWUP_AFTER_DAYS[prospect.stage] ?? null;
    let verdict: FollowupVerdict;
    let reason: string;
    if (thresholdDays === null) {
      verdict = "termine";
      reason = `Dossier ${prospect.stage} : hors du pipeline actif, aucune relance proposée.`;
    } else if (daysSinceContact < thresholdDays) {
      verdict = "en_cours";
      reason =
        `Dernier contact il y a ${daysSinceContact} jour(s) — sous le seuil de ` +
        `${thresholdDays} jours pour l'étape « ${prospect.stage} ».`;
    } else if (contactedAt === null) {
      verdict = "jamais_contacte";
      reason =
        `Fiche créée il y a ${daysSinceContact} jour(s), AUCUN contact consigné — ` +
        `seuil de l'étape « ${prospect.stage} » : ${thresholdDays} jours.`;
    } else {
      verdict = "a_relancer";
      reason =
        `Dernier contact il y a ${daysSinceContact} jour(s), au-delà du seuil de ` +
        `${thresholdDays} jours pour l'étape « ${prospect.stage} ».`;
    }

    if (verdict === "a_relancer" || verdict === "jamais_contacte") {
      followups.push({
        id: prospect.id,
        name: prospect.name,
        company: prospect.company ?? null,
        stage: prospect.stage,
        source: prospect.source,
        lastContactAt: contactedAt === null ? null : new Date(contactedAt).toISOString(),
        daysSinceContact,
        thresholdDays,
        verdict,
        reason,
      });
    }
  }

  // Le plus ancien d'abord : c'est celui qu'on perd.
  followups.sort((a, b) => b.daysSinceContact - a.daysSinceContact);
  retentionAlerts.sort((a, b) => b.daysSinceContact - a.daysSinceContact);

  return {
    rulesVersion: PROSPECTION_RULES_VERSION,
    pipeline,
    followups,
    retentionAlerts,
    optedOutCount,
    expiredOptedOutCount,
    unusableCount,
    label:
      "Relances proposées sur un délai écoulé, pas sur une intention supposée. " +
      "Un prospect opposé à la prospection n'apparaît dans aucune liste.",
  };
}
