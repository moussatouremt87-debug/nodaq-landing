import { classifyAccount, UNMAPPED_CATEGORY } from "@nodaq/shared";
import type { FecEntry } from "./parse.js";

/*
 * Dérivation des charges depuis un FEC (ticket 2.8).
 *
 * Sans cela, la marge reposerait sur une saisie manuelle mensuelle — que
 * personne ne tient à jour, et dont l'oubli fait justement paraître la marge
 * meilleure qu'elle n'est. Le FEC, lui, est déjà importé (2.14) et contient
 * les charges réelles.
 *
 * Le rattachement compte -> poste vit dans `@nodaq/shared` (config versionnée
 * datée sourcée PCG), pas ici : c'est lui qui décide de ce qui entre dans une
 * marge, et il est partagé avec le moteur de marge.
 *
 * DONNÉE CONFIDENTIELLE (2.14) : cette fonction ne renvoie que des AGRÉGATS
 * (mois, poste, montant). Aucun libellé d'écriture, aucun tiers, aucune ligne
 * du journal n'en sort — ils n'ont rien à faire dans une marge, et encore
 * moins dans un log.
 */

export interface DerivedCharge {
  /** "YYYY-MM" — mois de l'écriture. */
  month: string;
  /** Identifiant de poste (`COST_CATEGORIES`). */
  category: string;
  /** Montant en centimes : débit − crédit (un avoir réduit la charge). */
  amountCents: number;
}

export interface ChargeDerivation {
  /**
   * Charges par (mois, poste). Le poste technique `non_rattachees` y figure
   * comme les autres : c'est une charge RÉELLE dont on ignore le niveau, et le
   * moteur de marge s'en sert pour refuser d'annoncer un résultat complet.
   */
  charges: DerivedCharge[];
  /** Écritures de classe 6 volontairement écartées (dotations, IS…). */
  excludedCount: number;
  /**
   * Écritures de classe 6 qu'aucun poste ne couvre. Comptées SÉPARÉMENT des
   * exclusions : confondre les deux faisait disparaître une charge réelle en
   * silence (audit 2.8).
   */
  unmappedCount: number;
}

/**
 * Agrège les écritures de classe 6 par (mois, poste). PURE.
 *
 * Un poste dont le total est NÉGATIF (avoirs supérieurs aux achats sur le
 * mois) est conservé tel quel : le corriger à zéro fabriquerait une charge qui
 * n'existe pas, et gonflerait la marge.
 */
export function deriveCharges(entries: readonly FecEntry[]): ChargeDerivation {
  const totals = new Map<string, number>();
  let excludedCount = 0;
  let unmappedCount = 0;

  for (const entry of entries) {
    const classified = classifyAccount(entry.compteNum);
    if (classified.kind === "hors_charges") continue;
    if (classified.kind === "exclu") {
      // Hors marge PAR DÉCISION (dotations, financier, exceptionnel, IS).
      excludedCount += 1;
      continue;
    }
    const month = entry.ecritureDate.slice(0, 7);
    // Le parseur rejette déjà tout fichier dont une date est non conforme :
    // pas de branche « date illisible » ici, elle serait morte.
    const category =
      classified.kind === "poste" ? classified.category.id : UNMAPPED_CATEGORY;
    if (classified.kind === "non_rattache") unmappedCount += 1;
    const key = `${month}|${category}`;
    totals.set(key, (totals.get(key) ?? 0) + entry.debitCents - entry.creditCents);
  }

  const charges = [...totals.entries()]
    .map(([key, amountCents]) => {
      const [month = "", category = ""] = key.split("|");
      return { month, category, amountCents };
    })
    // Ordre déterministe : deux imports du même fichier donnent le même
    // résultat, ligne pour ligne.
    .sort((a, b) => a.month.localeCompare(b.month) || a.category.localeCompare(b.category));

  return { charges, excludedCount, unmappedCount };
}
