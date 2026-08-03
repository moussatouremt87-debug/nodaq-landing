import { createHash } from "node:crypto";
import { z } from "zod";
import { TenantId } from "@nodaq/shared";
import type { SensitivityCategory } from "@nodaq/shared";
import { withTenant } from "@nodaq/db";
import type { ModelGroup } from "@nodaq/shared";
import { assertSovereignty } from "./index.js";
import { transcribeAudio } from "./litellm.js";

/*
 * SPIKE F1 — porte souveraine de la transcription.
 *
 * LE POINT QUI COMMANDE TOUT : on ne peut pas classifier ce qu'on n'a pas
 * encore lu. Le classifier travaille sur du TEXTE ; devant un fichier audio, il
 * n'a rien à analyser. Il n'existe donc aucun chemin honnête où une dictée
 * serait jugée `non_sensible` avant transcription.
 *
 * Conséquence : la catégorie est FIXÉE à `confidentiel`, exactement comme les
 * photos de documents (2.16) le sont déjà « par construction ». Ce n'est pas
 * une précaution excessive — une dictée de devis contient un nom de client, une
 * adresse de chantier et des prix.
 *
 * Et il n'y a volontairement AUCUN paramètre de groupe : contrairement à
 * `route()`, aucun appelant ne peut demander le tier frontier, même par erreur,
 * même avec `preferFrontier`. La garde dure reste là quand même — deux
 * verrous valent mieux qu'un commentaire.
 */

/** Bornes d'une dictée : un devis dicté dure des minutes, pas une heure. */
export const TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;

export const TranscribeTask = z.object({
  /** Contenu audio brut. Jamais journalisé, jamais stocké par cette fonction. */
  audio: z.instanceof(Uint8Array).refine((a) => a.byteLength > 0, "audio vide"),
  /** Nom NEUTRE (« dictee.webm ») — surtout pas « devis-mme-martin.wav ». */
  fileName: z.string().min(1).max(120),
  /** ISO-639-1. `fr` par défaut : deviner la langue coûte de la précision. */
  language: z.string().length(2).optional(),
  tenantId: TenantId,
  requestId: z.string().min(1).max(200),
});
export type TranscribeTask = z.infer<typeof TranscribeTask>;

export interface TranscribeResult {
  text: string;
  /** Toujours `confidentiel` — exposé pour que l'appelant le PROPAGE. */
  category: SensitivityCategory;
  group: ModelGroup;
}

/** Une dictée n'est jamais autre chose que confidentielle. */
const AUDIO_CATEGORY: SensitivityCategory = "confidentiel";
const AUDIO_GROUP: ModelGroup = "sovereign-strong";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Transcrit un enregistrement sur le tier souverain, et audite la décision —
 * empreinte de l'AUDIO seulement, jamais le texte obtenu.
 *
 * Auditer le texte reviendrait à stocker en clair ce que la dictée contient :
 * le nom du client et le prix. L'empreinte suffit à prouver qu'un appel a eu
 * lieu et sur quel contenu, sans le conserver.
 */
export async function transcribe(task: TranscribeTask): Promise<TranscribeResult> {
  const parsed = TranscribeTask.parse(task);
  if (parsed.audio.byteLength > TRANSCRIPTION_MAX_BYTES) {
    throw new Error("audio payload exceeds the transcription cap");
  }

  // Garde dure AVANT toute émission réseau, comme dans `route()`.
  assertSovereignty(AUDIO_CATEGORY, AUDIO_GROUP, parsed.requestId);

  const writeAudit = (outcome: "allowed" | "failed"): Promise<unknown> =>
    withTenant(parsed.tenantId, (tx) =>
      tx.classification.create({
        data: {
          tenantId: parsed.tenantId,
          requestId: parsed.requestId,
          category: AUDIO_CATEGORY,
          tier: AUDIO_GROUP,
          // Aucun modèle n'a décidé quoi que ce soit : la catégorie est une
          // règle de construction, pas une inférence.
          decidedBy: "rules",
          outcome,
          contentHash: sha256(parsed.audio),
        },
      }),
    ).catch(() => undefined);

  try {
    const text = await transcribeAudio(parsed.audio, parsed.fileName, parsed.language ?? "fr");
    await writeAudit("allowed");
    return { text, category: AUDIO_CATEGORY, group: AUDIO_GROUP };
  } catch (error) {
    await writeAudit("failed");
    throw error;
  }
}
