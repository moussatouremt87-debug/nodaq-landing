/*
 * Formats audio acceptés pour la dictée — CONFIG VERSIONNÉE DATÉE SOURCÉE,
 * même doctrine que les autres règles métier du produit.
 *
 * CE QUE CE FICHIER EXISTE POUR DIRE. Le spike de transcription
 * (`docs/spike-transcription-souveraine.md`) a relevé la liste des formats
 * documentés par Scaleway : wav, mp3, flac, mpga, oga, ogg. Or le navigateur
 * n'enregistre dans AUCUN d'eux : `MediaRecorder` rend du **WebM/Opus** sur
 * Chrome et Firefox, du **MP4/AAC** sur Safari.
 *
 * Les deux listes ne se recouvrent pas. Trois façons de traiter ça :
 *
 * 1. refuser webm/mp4 — c'est refuser l'enregistrement de tous les
 *    navigateurs, donc refuser la fonctionnalité ;
 * 2. les accepter en silence — et découvrir au premier appel réel, chez un
 *    client, que le fournisseur les rejette ;
 * 3. les accepter en DISANT que le fournisseur ne les garantit pas, et rendre
 *    un refus motivé s'il les refuse.
 *
 * C'est la troisième. `providerConfirmed` porte cette distinction jusqu'à
 * l'écran : un pari assumé n'est pas un mensonge, un pari tu en est un.
 *
 * Le spike n'a pas pu vérifier la liste en console (proxy bloquant) — donc
 * cette liste vient de la DOCUMENTATION, et le premier appel réel la
 * confirmera ou la corrigera. C'est écrit ici pour que le correctif soit un
 * diff sur un fichier de données, pas une chasse dans du code.
 *
 * Vérifié le 2026-08-03 — source : Scaleway, « How to query audio models »
 * (https://www.scaleway.com/en/docs/generative-apis/how-to/query-audio-models/)
 */

/** Date d'instantané — à bumper si la liste du fournisseur change. */
export const AUDIO_FORMATS_VERSION = "2026-08-03";

export interface AudioFormat {
  /** Identifiant court, aussi utilisé comme extension de nom de fichier. */
  readonly id: string;
  readonly mimeType: string;
  /**
   * Le fournisseur documente-t-il ce format ?
   *
   * `false` = accepté par nous, non garanti par lui. L'écran doit le dire.
   */
  readonly providerConfirmed: boolean;
}

/**
 * Formats listés par la documentation du fournisseur (voir en-tête).
 *
 * `mpga` et `oga` n'ont pas d'entrée propre dans `AUDIO_FORMATS` : ce sont des
 * noms d'extension pour des conteneurs que le renifleur reconnaît déjà comme
 * `mp3` et `ogg`. La liste dit ce que le FOURNISSEUR accepte ; `AUDIO_FORMATS`
 * dit ce que nos octets savent identifier.
 */
export const PROVIDER_CONFIRMED_FORMATS = [
  "wav",
  "mp3",
  "mpga",
  "oga",
  "ogg",
  "flac",
] as const;

export const AUDIO_FORMATS: readonly AudioFormat[] = [
  { id: "wav", mimeType: "audio/wav", providerConfirmed: true },
  { id: "ogg", mimeType: "audio/ogg", providerConfirmed: true },
  { id: "flac", mimeType: "audio/flac", providerConfirmed: true },
  { id: "mp3", mimeType: "audio/mpeg", providerConfirmed: true },
  // Ce que les navigateurs produisent VRAIMENT — non documenté côté
  // fournisseur, accepté et signalé comme tel.
  { id: "webm", mimeType: "audio/webm", providerConfirmed: false },
  { id: "mp4", mimeType: "audio/mp4", providerConfirmed: false },
];

const BY_ID = new Map(AUDIO_FORMATS.map((format) => [format.id, format]));

function startsWith(bytes: Uint8Array, magic: readonly number[], offset = 0): boolean {
  if (bytes.byteLength < offset + magic.length) return false;
  return magic.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * Reconnaît le format par ses OCTETS. `null` si ce n'est pas de l'audio connu.
 *
 * Jamais par l'en-tête `Content-Type` ni par l'extension : les deux viennent
 * du client. Envoyer une image à un moteur de transcription coûterait un appel
 * facturé pour rien et rendrait une erreur incompréhensible — un refus franc
 * vaut mieux, et il est rendu AVANT toute sortie réseau.
 */
export function sniffAudioFormat(bytes: Uint8Array): AudioFormat | null {
  // RIFF....WAVE
  if (
    bytes.byteLength >= 12 &&
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x41, 0x56, 0x45], 8)
  ) {
    return BY_ID.get("wav") ?? null;
  }
  // OggS — conteneur Ogg (inclut oga/opus).
  if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) return BY_ID.get("ogg") ?? null;
  // fLaC
  if (startsWith(bytes, [0x66, 0x4c, 0x61, 0x43])) return BY_ID.get("flac") ?? null;
  // ID3 (mp3 étiqueté) ou trame MPEG brute (0xFF 0xEx/0xFx).
  if (startsWith(bytes, [0x49, 0x44, 0x33])) return BY_ID.get("mp3") ?? null;
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) {
    return BY_ID.get("mp3") ?? null;
  }
  // EBML — conteneur Matroska/WebM.
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return BY_ID.get("webm") ?? null;
  // ....ftyp — conteneur ISO-BMFF (MP4/M4A).
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) return BY_ID.get("mp4") ?? null;
  return null;
}
