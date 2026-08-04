"use client";

import { useState } from "react";
import Link from "next/link";
import { ApiError, draftQuoteFromEmail } from "../../lib/api";
import { emitDomainEvent } from "../../lib/freshness";
import type { QuoteDraftResult } from "../../lib/api";
import { Dictaphone } from "./Dictaphone";

/*
 * Devis depuis un e-mail (2.7). Le texte collé est écrit par un TIERS : il
 * part dans un sens (vers l'API, qui le traite en tier souverain) et ne
 * revient jamais. L'écran ne montre que le résultat — la proposition, elle,
 * s'ouvre dans la file de validation.
 */

const EMAIL_BODY_MAX = 8_000;

export default function DevisPage() {
  const [emailBody, setEmailBody] = useState("");
  const [from, setFrom] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<QuoteDraftResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setNotice(null);
    setResult(null);
    try {
      const outcome = await draftQuoteFromEmail(emailBody.trim(), from.trim() || undefined);
      setResult(outcome);
      // Le devis part en file de validation, jamais au client directement.
      emitDomainEvent("action.preparee");
      // Le contenu collé ne reste pas à l'écran une fois traité.
      setEmailBody("");
    } catch (error) {
      setNotice(
        error instanceof ApiError && error.status === 422
          ? "Ce message ne ressemble pas à une demande de devis."
          : "Préparation impossible pour l'instant.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      {/* La dictée d'abord : c'est le geste du terrain, l'e-mail est celui du
          bureau. L'ordre de la page suit celui de la journée. */}
      <Dictaphone />

      <section className="card">
        <h2>Devis depuis un e-mail</h2>
        <p className="muted">
          Collez la demande reçue : l&apos;employé virtuel en tire une proposition de devis,
          rapproche les articles de votre référentiel, et la dépose dans la file de validation.
          Il ne fixe <strong>aucun prix</strong> et n&apos;envoie rien.
        </p>
        <div className="form-grid">
          <label>
            Expéditeur (facultatif)
            <input
              value={from}
              maxLength={320}
              placeholder="prospect@exemple.fr"
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label>
            E-mail reçu
            <textarea
              value={emailBody}
              maxLength={EMAIL_BODY_MAX}
              rows={10}
              placeholder="Bonjour, pourriez-vous me chiffrer…"
              onChange={(event) => setEmailBody(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="primary"
            disabled={busy || emailBody.trim().length < 10}
            onClick={() => void submit()}
          >
            {busy ? "Lecture…" : "Préparer le devis"}
          </button>
        </div>
        {notice && <p className="warn">{notice}</p>}
        {result && (
          <div>
            <p>
              Proposition prête : <strong>{result.lines}</strong> ligne(s), prix{" "}
              {result.pricing}.
            </p>
            {result.unmatchedCount > 0 && (
              <p className="warn">
                {result.unmatchedCount} ligne(s) sans article connu — à compléter à la main.
              </p>
            )}
            <Link href="/validation" className="btn primary">
              Ouvrir la file de validation
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}
