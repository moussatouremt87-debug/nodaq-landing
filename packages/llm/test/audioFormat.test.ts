import { describe, expect, it } from "vitest";
import {
  AUDIO_FORMATS,
  PROVIDER_CONFIRMED_FORMATS,
  sniffAudioFormat,
} from "../src/audioFormat.js";

/*
 * La dictée — reconnaissance du format audio.
 *
 * Le sujet n'est pas « lire un en-tête » : c'est que le navigateur enregistre
 * dans des formats que le fournisseur ne documente PAS, et que découvrir ça au
 * premier appel réel serait le pire moment.
 */

/** Fabrique un début de fichier plausible pour un format donné. */
function header(bytes: readonly number[], padTo = 32): Buffer {
  const buffer = Buffer.alloc(padTo);
  Buffer.from(bytes).copy(buffer);
  return buffer;
}

const WAV = header([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
]);
const OGG = header([0x4f, 0x67, 0x67, 0x53]);
const FLAC = header([0x66, 0x4c, 0x61, 0x43]);
const MP3_ID3 = header([0x49, 0x44, 0x33, 0x04]);
const MP3_FRAME = header([0xff, 0xfb, 0x90, 0x00]);
const WEBM = header([0x1a, 0x45, 0xdf, 0xa3]);
const MP4 = header([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]);

describe("reconnaissance par les OCTETS, jamais par ce que le client déclare", () => {
  it("reconnaît les formats que le fournisseur documente", () => {
    expect(sniffAudioFormat(WAV)?.id).toBe("wav");
    expect(sniffAudioFormat(OGG)?.id).toBe("ogg");
    expect(sniffAudioFormat(FLAC)?.id).toBe("flac");
    expect(sniffAudioFormat(MP3_ID3)?.id).toBe("mp3");
    expect(sniffAudioFormat(MP3_FRAME)?.id).toBe("mp3");
  });

  it("reconnaît aussi ce que les NAVIGATEURS produisent réellement", () => {
    // MediaRecorder ne demande pas son avis au fournisseur : Chrome et Firefox
    // rendent du WebM/Opus, Safari du MP4/AAC. Ne pas les reconnaître, c'est
    // refuser l'enregistrement de tout le monde.
    expect(sniffAudioFormat(WEBM)?.id).toBe("webm");
    expect(sniffAudioFormat(MP4)?.id).toBe("mp4");
  });

  it("un contenu inconnu N'EST PAS deviné", () => {
    // Envoyer une image ou du texte à un moteur de transcription coûte un
    // appel facturé pour rien, et rend une erreur incompréhensible.
    expect(sniffAudioFormat(header([0xff, 0xd8, 0xff]))).toBeNull();
    expect(sniffAudioFormat(Buffer.from("bonjour"))).toBeNull();
    expect(sniffAudioFormat(Buffer.alloc(0))).toBeNull();
  });

  it("un WAV tronqué avant sa signature n'est pas un WAV", () => {
    expect(sniffAudioFormat(Buffer.from([0x52, 0x49, 0x46, 0x46]))).toBeNull();
  });
});

describe("ce que le fournisseur garantit, et ce qu'il ne garantit pas", () => {
  it("chaque format dit s'il est CONFIRMÉ chez le fournisseur", () => {
    // La distinction est le cœur du fichier : `webm` et `mp4` ne figurent pas
    // dans la documentation Scaleway lue par le spike. Les accepter est un
    // pari assumé ; le taire serait une promesse qu'on ne tient pas.
    for (const format of AUDIO_FORMATS) {
      expect(typeof format.providerConfirmed).toBe("boolean");
    }
    expect(sniffAudioFormat(WAV)?.providerConfirmed).toBe(true);
    expect(sniffAudioFormat(WEBM)?.providerConfirmed).toBe(false);
    expect(sniffAudioFormat(MP4)?.providerConfirmed).toBe(false);
  });

  it("la liste confirmée est celle de la source citée par le spike", () => {
    // Si quelqu'un ajoute un format « confirmé » sans mettre à jour la source,
    // ce test le force à regarder la doc plutôt que la mémoire.
    expect([...PROVIDER_CONFIRMED_FORMATS].sort()).toEqual([
      "flac",
      "mp3",
      "mpga",
      "oga",
      "ogg",
      "wav",
    ]);
  });
});
