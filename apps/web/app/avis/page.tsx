"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  ApiError,
  createReview,
  deleteReview,
  draftReviewReply,
  getReputation,
  getReviews,
} from "../../lib/api";
import type { CustomerReview, ReputationReport } from "../../lib/api";
import { useViewRefresh } from "../../lib/useFreshness";
import { emitDomainEvent } from "../../lib/freshness";

/*
 * Avis clients / e-réputation (3.8). Lecture pour tous les membres ; saisie
 * owner-only (403 propre) ; la réponse à un avis passe par la file de
 * validation (HITL) et sa PUBLICATION sur la plateforme reste manuelle en V1
 * (copier-coller) — le label le dit.
 */

const VERDICT_LABELS: Record<string, string> = {
  en_hausse: "en hausse",
  en_baisse: "en baisse",
  stable: "stable",
};

function Stars({ rating }: { rating: number }) {
  return (
    <span aria-label={`${rating}/5`} title={`${rating}/5`}>
      {"★".repeat(rating)}
      {"☆".repeat(5 - rating)}
    </span>
  );
}

export default function AvisPage() {
  const [reviews, setReviews] = useState<CustomerReview[]>([]);
  const [reputation, setReputation] = useState<ReputationReport | null>(null);
  const [form, setForm] = useState({ authorName: "", rating: "5", text: "", reviewedAt: "" });
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [list, report] = await Promise.all([
        getReviews(),
        getReputation().catch(() => null),
      ]);
      setReviews(list.reviews);
      setReputation(report);
    } catch {
      setError("avis indisponibles — réessayez");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useViewRefresh(["avis"], () => void refresh());

  async function addReview(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    const rating = Number(form.rating);
    if (!form.text || !form.reviewedAt || !Number.isInteger(rating)) {
      setError("formulaire incomplet");
      return;
    }
    try {
      await createReview({
        source: "manuel",
        ...(form.authorName ? { authorName: form.authorName } : {}),
        rating,
        text: form.text,
        reviewedAt: form.reviewedAt,
      });
      setForm({ authorName: "", rating: "5", text: "", reviewedAt: "" });
      await refresh();
      emitDomainEvent("avis.modifie");
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? "saisie réservée au dirigeant"
          : "ajout impossible",
      );
    }
  }

  async function removeReview(reviewId: string): Promise<void> {
    setError(null);
    try {
      await deleteReview(reviewId);
      await refresh();
      emitDomainEvent("avis.modifie");
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? "suppression réservée au dirigeant"
          : "suppression impossible",
      );
    }
  }

  async function prepareReply(reviewId: string): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await draftReviewReply(reviewId);
      // Rien n'est publié : un brouillon attend dans la file, et le badge de
      // la nav doit le montrer tout de suite.
      emitDomainEvent("action.preparee");
      setNotice("Brouillon déposé dans la file de validation — validez-le avant de le publier.");
    } catch {
      setError("brouillon indisponible — réessayez");
    }
  }

  return (
    <div className="page">
      <section className="card">
        <h2>E-réputation</h2>
        {reputation === null ? (
          <p className="muted">Synthèse indisponible.</p>
        ) : reputation.totalReviews === 0 ? (
          <p className="muted">Aucun avis enregistré — saisissez ou importez vos avis.</p>
        ) : (
          <>
            <p>
              <strong>{reputation.averageRating ?? "—"}/5</strong> sur {reputation.totalReviews}{" "}
              avis
              {reputation.replyRatePct !== null && ` · ${reputation.replyRatePct} % répondus`}
              {reputation.trend &&
                ` · tendance ${VERDICT_LABELS[reputation.trend.verdict] ?? reputation.trend.verdict} ` +
                  `(${reputation.trend.recentAverage}/5 vs ${reputation.trend.previousAverage}/5)`}
            </p>
            {reputation.unansweredNegative.length > 0 && (
              <p className="warn">
                {reputation.unansweredNegative.length} avis négatif(s) récent(s) sans réponse —
                répondez-y en priorité.
              </p>
            )}
            {reputation.truncated && (
              <p className="warn">
                Lecture partielle (plus de 5 000 avis) — synthèse calculée sur les 5 000 plus
                récents.
              </p>
            )}
            <p className="muted">{reputation.label}</p>
          </>
        )}
      </section>

      <section className="card">
        <h3>Avis ({reviews.length})</h3>
        <ul className="device-list">
          {reviews.map((review) => (
            <li key={review.id} className="device-row">
              <div>
                <Stars rating={review.rating} />{" "}
                <strong>{review.authorName ?? "Anonyme"}</strong>{" "}
                <span className="muted">
                  {review.source} · {review.reviewedAt.slice(0, 10)}
                </span>
                <br />
                <span>{review.text}</span>
                {review.replyText ? (
                  <>
                    <br />
                    <span className="muted">
                      Réponse validée (à publier sur la plateforme) : {review.replyText}
                    </span>
                  </>
                ) : (
                  <>
                    <br />
                    <button onClick={() => void prepareReply(review.id)}>
                      Préparer une réponse
                    </button>
                  </>
                )}
              </div>
              <div>
                {/* Effacement (droit RGPD de l'auteur) — owner-only côté API. */}
                <button onClick={() => void removeReview(review.id)}>Supprimer</button>
              </div>
            </li>
          ))}
        </ul>
        {notice && <p className="hint">{notice}</p>}
      </section>

      <section className="card">
        <h3>Saisir un avis (dirigeant)</h3>
        <form onSubmit={(event) => void addReview(event)} className="form-grid">
          <input
            placeholder="Auteur (optionnel)"
            value={form.authorName}
            onChange={(e) => setForm({ ...form, authorName: e.target.value })}
          />
          <select value={form.rating} onChange={(e) => setForm({ ...form, rating: e.target.value })}>
            {["5", "4", "3", "2", "1"].map((value) => (
              <option key={value} value={value}>
                {value}/5
              </option>
            ))}
          </select>
          <input
            type="date"
            value={form.reviewedAt}
            onChange={(e) => setForm({ ...form, reviewedAt: e.target.value })}
          />
          <input
            placeholder="Texte de l'avis"
            value={form.text}
            onChange={(e) => setForm({ ...form, text: e.target.value })}
          />
          <button className="primary">Ajouter</button>
        </form>
        {error && <p className="warn">{error}</p>}
      </section>
    </div>
  );
}
