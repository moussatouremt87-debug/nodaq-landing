import type { Prisma } from "@nodaq/db";
import { viewsFor } from "@nodaq/shared";
import type { DomainEvent } from "@nodaq/shared";

/*
 * Bus d'événements (ticket 4.4, PR A) — ÉMISSION.
 *
 * DEUX BUGS QUE L'OUTBOX REND IMPOSSIBLES PAR CONSTRUCTION.
 *
 * Un `await commit()` suivi d'un `emit()` perd l'événement au premier crash :
 * l'écriture a eu lieu, plus personne ne le saura, et les écrans mentent
 * jusqu'au prochain rechargement manuel. Un `emit()` placé avant le commit
 * fait l'inverse : il en produit pour des transactions ANNULÉES — une relance
 * déclenchée par un travail qui n'a jamais été enregistré.
 *
 * Insérer l'événement DANS la transaction métier ferme les deux : il existe si
 * et seulement si l'écriture a été validée. Ce n'est pas de la
 * sur-ingénierie ici, c'est la condition de correction.
 */

/** Ce qu'un appelant décrit — jamais ce qu'il a écrit. */
export interface OutboxEmit {
  readonly type: DomainEvent;
  /** Nature de l'objet touché : « affaire », « pending_action »… */
  readonly objectType: string;
  /** Identifiant opaque de l'objet. Jamais un libellé, jamais un nom. */
  readonly objectId?: string | null;
  /** NOMS des champs modifiés. Jamais leurs valeurs. */
  readonly changedFields?: readonly string[];
  /** Corrèle les événements d'une même requête (rejeu, débogage). */
  readonly correlationId?: string | null;
}

/**
 * Champs qu'un événement ne portera JAMAIS.
 *
 * Le ticket l'écrit comme une règle ; sans garde exécutable, c'en est une
 * qu'on tient jusqu'au premier « juste ce montant, pour éviter une requête ».
 * La donnée finirait alors dans les files, les journaux et les rejeux — et
 * elle serait périmée au moment où quelqu'un la lit. Le consommateur relit
 * sous `withTenant` ; c'est tout l'intérêt.
 *
 * On borne ce qui ENTRE plutôt que d'inspecter des valeurs : `objectId` est le
 * seul texte libre, et un identifiant opaque n'est pas une donnée métier.
 */
const FORBIDDEN_FIELD_HINTS = [
  "montant",
  "amount",
  "cents",
  "prix",
  "price",
  "nom",
  "name",
  "email",
  "phone",
  "telephone",
  "adresse",
  "address",
  "iban",
  "siret",
  "note",
  "libelle",
  "label",
  "content",
  "message",
  "payload",
] as const;

/** Levée quand un appelant tente de faire porter de la donnée à un événement. */
export class OutboxContentError extends Error {}

/**
 * Vérifie qu'un événement ne transporte que de quoi RELIRE. PURE.
 *
 * `changedFields` est une liste de NOMS. Le piège n'est pas d'y mettre une
 * valeur par malice, c'est d'y pousser `clientName: "Dupont"` en croyant
 * décrire un champ. On rejette donc toute entrée qui ressemble à une paire
 * nom/valeur, et on refuse les noms dont la seule présence trahirait déjà une
 * donnée sensible côté journal.
 */
export function assertNoBusinessData(emit: OutboxEmit): void {
  for (const field of emit.changedFields ?? []) {
    if (field.includes(":") || field.includes("=")) {
      throw new OutboxContentError(
        "changedFields porte une VALEUR : un événement ne transporte que des noms de champs",
      );
    }
    const lowered = field.toLowerCase();
    if (FORBIDDEN_FIELD_HINTS.some((hint) => lowered.includes(hint))) {
      throw new OutboxContentError(
        `champ « ${field} » refusé : son nom seul apparaîtrait dans les journaux et les rejeux`,
      );
    }
  }
  // Un type inconnu du registre ne périmerait aucune vue : l'événement serait
  // écrit, relayé, et n'aurait aucun effet. Un silence, pas une erreur — donc
  // impossible à remarquer.
  // `?? []` : un type hors registre rend `undefined`, et un `.length` dessus
  // lèverait un TypeError opaque au lieu du refus MOTIVÉ qu'on veut ici.
  if ((viewsFor(emit.type) ?? []).length === 0) {
    throw new OutboxContentError(
      `type « ${emit.type} » ne périme aucune vue : l'événement n'aurait aucun effet`,
    );
  }
}

/**
 * Dépose un événement DANS la transaction métier en cours.
 *
 * `tx` est la transaction de l'appelant, pas une nouvelle : c'est toute la
 * propriété. Appeler ceci hors d'un `withTenant` échouerait sur la RLS — ce
 * qui est le comportement voulu.
 */
export async function emitOutbox(
  tx: Prisma.TransactionClient,
  tenantId: string,
  emit: OutboxEmit,
): Promise<void> {
  assertNoBusinessData(emit);
  await tx.outboxEvent.create({
    data: {
      tenantId,
      type: emit.type,
      objectType: emit.objectType,
      objectId: emit.objectId ?? null,
      changedFields: [...(emit.changedFields ?? [])],
      correlationId: emit.correlationId ?? null,
    },
  });
}
