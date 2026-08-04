"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { ApiError, draftQuoteFromDictation } from "../../lib/api";
import { emitDomainEvent } from "../../lib/freshness";
import type { DictationDraftResult } from "../../lib/api";

/*
 * Le devis DICTÉ — le premier verbe de la promesse produit.
 *
 * Deux décisions commandent cet écran :
 *
 * 1. **L'audio ne quitte le navigateur qu'une fois, et n'y reste pas.** Aucun
 *    lecteur, aucun téléchargement, aucune conservation : l'enregistrement est
 *    envoyé, transcrit, puis relâché des deux côtés.
 *
 * 2. **La transcription est AFFICHÉE, en toutes lettres, à côté du résultat.**
 *    C'est la parade au seul risque que le spike n'a pas pu fermer : la
 *    transcription automatique entend « 25 » là où le patron a dit « 2,5 ».
 *    L'audio n'étant pas conservé, ce texte est le seul recours pour vérifier.
 *    Le cacher rendrait la validation en un clic aveugle.
 */

/** Ce que le navigateur sait enregistrer, par ordre de préférence. */
const PREFERRED_TYPES = [
  // Ogg/Opus est le seul format à la fois produit par un navigateur ET
  // documenté par le fournisseur : on le demande en premier (Firefox).
  "audio/ogg;codecs=opus",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return PREFERRED_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

type Phase = "idle" | "recording" | "sending";

export function Dictaphone() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<DictationDraftResult | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  async function start(): Promise<void> {
    setNotice(null);
    setResult(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        // Le micro se coupe AVEC l'enregistrement : laisser la piste ouverte
        // garderait la pastille « enregistrement » allumée dans l'onglet, ce
        // qui est au mieux inquiétant, au pire faux.
        stream.getTracks().forEach((track) => track.stop());
        void send(new Blob(chunksRef.current, { type: mimeType ?? "audio/webm" }));
        chunksRef.current = [];
      };
      recorder.start();
      recorderRef.current = recorder;
      setPhase("recording");
    } catch {
      // Refus du micro, appareil absent, page non sécurisée : trois causes,
      // un seul remède côté utilisateur — autoriser le micro.
      setNotice("Micro indisponible — autorisez l'accès dans votre navigateur.");
      setPhase("idle");
    }
  }

  function stop(): void {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setPhase("sending");
  }

  async function send(audio: Blob): Promise<void> {
    try {
      const outcome = await draftQuoteFromDictation(audio);
      setResult(outcome);
      // La proposition part en file de validation : d'autres écrans (le badge
      // de la nav, le cockpit) viennent de devenir faux.
      emitDomainEvent("action.preparee");
    } catch (error) {
      // Le message de l'API est déjà motivé (format non garanti, rien
      // d'audible, module éteint) : le remplacer par une phrase générique
      // ferait perdre le seul indice utile.
      setNotice(
        error instanceof ApiError
          ? error.message
          : "Préparation impossible pour l'instant.",
      );
    } finally {
      setPhase("idle");
    }
  }

  return (
    <section className="card">
      <h2>Devis dicté</h2>
      <p className="muted">
        Dictez le chantier à voix haute : le client, les postes, les quantités. L&apos;employé
        virtuel en tire une proposition et la dépose dans la file de validation. Il ne fixe{" "}
        <strong>aucun prix</strong> et n&apos;envoie rien.
      </p>
      <p className="muted">
        {/* Dire ce qu'on fait de l'enregistrement, à l'endroit où on le
            demande — pas dans une politique que personne n'ouvre. */}
        L&apos;enregistrement est transcrit sur nos serveurs souverains puis{" "}
        <strong>supprimé</strong> : seul le texte est conservé, pour que vous puissiez le relire.
      </p>

      {phase === "recording" ? (
        <button className="danger" onClick={stop}>
          ● Arrêter et préparer le devis
        </button>
      ) : (
        <button className="primary" disabled={phase === "sending"} onClick={() => void start()}>
          {phase === "sending" ? "Transcription en cours…" : "Dicter un devis"}
        </button>
      )}

      {notice && <p className="warn">{notice}</p>}

      {result && (
        <div style={{ marginTop: 14 }}>
          <p>
            Proposition préparée — {result.lines} ligne(s), prix {result.pricing}.{" "}
            <Link href="/validation">Relire et valider</Link>
          </p>
          {result.unmatchedCount > 0 && (
            <p className="warn">
              {result.unmatchedCount} ligne(s) sans article connu — à compléter avant validation.
            </p>
          )}
          {!result.formatProviderConfirmed && (
            <p className="muted">
              {/* Le pari est assumé, donc il est dit : voir `audioFormat.ts`. */}
              Votre navigateur enregistre dans un format que notre moteur de transcription ne
              garantit pas encore. Si le résultat vous semble incohérent, réessayez depuis
              Firefox.
            </p>
          )}

          {/* LE point de cet écran. Ce que la machine a entendu, mot pour mot,
              à côté de ce qu'elle en a fait — parce qu'elle peut entendre
              « 25 » là où vous avez dit « 2,5 », et que l'audio n'existe plus
              pour en juger. */}
          <span className="overline">Ce qui a été entendu</span>
          <blockquote className="email-preview">
            <div className="body">{result.transcript}</div>
          </blockquote>
          <p className="muted">
            Relisez ce texte avant de valider : un chiffre mal entendu se corrige ici, pas après
            l&apos;envoi du devis.
          </p>
        </div>
      )}
    </section>
  );
}
