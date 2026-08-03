import type { TenantClient } from "./index.js";

/*
 * Référence d'affaire — « 2026-014 », unique par tenant (ticket 4.1).
 *
 * LE PIÈGE, nommé dans le ticket : `count() + 1`. Deux créations simultanées
 * lisent le même compte et produisent deux fois la même référence — et comme
 * une référence sert à désigner un chantier devant un client, deux chantiers
 * homonymes est une erreur qu'on ne rattrape pas proprement.
 *
 * ICI : un seul ordre SQL. `INSERT … ON CONFLICT DO UPDATE … RETURNING` prend
 * le verrou de ligne du compteur ; les concurrents s'y sérialisent et chacun
 * repart avec un numéro distinct. Aucun SELECT préalable, donc aucune fenêtre
 * entre la lecture et l'écriture — c'est la fenêtre qui fait les doublons.
 *
 * L'unicité `(tenant_id, reference)` sur `affaires` reste le dernier rempart :
 * si un jour quelqu'un contourne cette fonction, la base refuse.
 */

/** Largeur du numéro dans la référence — « 2026-014 », et 1 000+ déborde sans casser. */
const SEQ_WIDTH = 3;

/**
 * Réserve le prochain numéro du tenant pour l'année donnée et rend la référence.
 *
 * DOIT être appelée DANS la transaction qui crée l'affaire (`withTenant`) :
 * appelée hors transaction, un échec de création plus loin laisserait un trou
 * dans la numérotation. Un trou n'est pas grave en soi — une collision, si.
 */
export async function nextAffaireReference(
  tx: TenantClient,
  tenantId: string,
  year: number,
): Promise<string> {
  const rows = await tx.$queryRaw<{ next_seq: number }[]>`
    INSERT INTO affaire_counters (tenant_id, year, next_seq, updated_at)
    VALUES (${tenantId}::uuid, ${year}, 1, NOW())
    ON CONFLICT (tenant_id, year)
    DO UPDATE SET next_seq = affaire_counters.next_seq + 1, updated_at = NOW()
    RETURNING next_seq
  `;
  const seq = rows[0]?.next_seq;
  // Un compteur qui ne rend rien est une anomalie de base, pas un cas métier :
  // rendre « 2026-000 » ferait passer un bug pour une donnée.
  if (seq === undefined) {
    throw new Error("affaire reference counter returned no row");
  }
  return `${year}-${String(seq).padStart(SEQ_WIDTH, "0")}`;
}
