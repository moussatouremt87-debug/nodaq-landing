"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  formatEuroCents,
  getSubmissions,
  previewEReporting,
  proposeEReporting,
} from "../../lib/api";
import type { EInvoiceSubmission, EReportingPreview } from "../../lib/api";

/*
 * Factures électroniques (2.4) — owner only : numéros, montants et statuts de
 * factures. La page SUIT les dépôts et PRÉPARE l'e-reporting ; elle ne dépose
 * jamais rien elle-même — tout part de la file de validation, parce qu'un
 * dépôt sur le réseau national est irréversible et opposable.
 */

/** Réutilise les badges de statut existants : refus = erreur, dépôt = attente. */
function statusTone(status: string): string {
  if (status === "refusee" || status === "rejetee" || status === "erreur") return "failed";
  if (status === "approuvee" || status === "encaissee") return "executed";
  return "pending";
}

function SubmissionRow({
  submission,
  labels,
}: {
  submission: EInvoiceSubmission;
  labels: Record<string, string>;
}) {
  return (
    <tr>
      <td>{submission.invoiceNumber}</td>
      <td>{formatEuroCents(submission.amountCents)}</td>
      <td>
        <span className={`badge ${statusTone(submission.status)}`}>
          {labels[submission.status] ?? submission.status}
        </span>
      </td>
      <td>{submission.pdpReference ?? "—"}</td>
      <td>
        {submission.submittedAt
          ? new Date(submission.submittedAt).toLocaleDateString("fr-FR")
          : "—"}
      </td>
    </tr>
  );
}

export default function FacturesPage() {
  const [forbidden, setForbidden] = useState(false);
  const [items, setItems] = useState<EInvoiceSubmission[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [preview, setPreview] = useState<EReportingPreview | null>(null);
  const [vatEuros, setVatEuros] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const state = await getSubmissions();
      setItems(state.items);
      setLabels(state.statusLabels);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
      else setError("suivi indisponible — réessayez");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function loadPreview(): Promise<void> {
    setNotice(null);
    setPreview(null);
    try {
      setPreview(await previewEReporting(periodStart, periodEnd));
    } catch (err) {
      setNotice(
        err instanceof ApiError && err.status === 409
          ? "Module désactivé."
          : "Aperçu indisponible (facturier non connecté ?).",
      );
    }
  }

  async function propose(): Promise<void> {
    if (!preview) return;
    const vat = Number(vatEuros.replace(",", "."));
    if (!Number.isFinite(vat) || vat < 0) {
      setNotice("Montant de TVA invalide.");
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await proposeEReporting({
        periodStart: preview.periodStart,
        periodEnd: preview.periodEnd,
        totalCents: preview.totalCents,
        vatCents: Math.round(vat * 100),
        transactionCount: preview.transactionCount,
      });
      setNotice("Transmission proposée — à valider dans la file de validation.");
      await refresh();
    } catch (err) {
      setNotice(
        err instanceof ApiError && err.status === 409
          ? "Cette période a déjà été transmise."
          : "Proposition impossible.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (forbidden) {
    return (
      <div className="page">
        <section className="card">
          <h2>Factures électroniques</h2>
          <p className="muted">
            Réservé au dirigeant : cette page expose les numéros et montants des factures.
          </p>
        </section>
      </div>
    );
  }

  const emissions = items.filter((item) => item.direction === "emission");
  const reports = items.filter((item) => item.direction === "ereporting");

  return (
    <div className="page">
      <section className="card">
        <h2>Dépôts de factures</h2>
        <p className="muted">
          Le dépôt d&apos;une facture sur une plateforme agréée est irréversible : il passe
          toujours par la file de validation. Cette page suit ce qui a été déposé et ce que la
          plateforme en dit.
        </p>
        {error && <p className="warn">{error}</p>}
        {emissions.length === 0 ? (
          <p className="muted">Aucune facture déposée pour l&apos;instant.</p>
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th>Facture</th>
                <th>Montant TTC</th>
                <th>Statut</th>
                <th>Référence plateforme</th>
                <th>Déposée le</th>
              </tr>
            </thead>
            <tbody>
              {emissions.map((submission) => (
                <SubmissionRow key={submission.id} submission={submission} labels={labels} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>E-reporting</h2>
        <p className="muted">
          L&apos;e-reporting transmet des <strong>totaux</strong> de transactions — jamais le
          détail nominatif de vos clients. L&apos;aperçu ci-dessous lit votre facturier ; il ne
          remplace pas votre déclaration.
        </p>
        <div className="form-grid">
          <label>
            Début
            <input
              type="date"
              value={periodStart}
              onChange={(event) => setPeriodStart(event.target.value)}
            />
          </label>
          <label>
            Fin
            <input
              type="date"
              value={periodEnd}
              onChange={(event) => setPeriodEnd(event.target.value)}
            />
          </label>
          <button
            type="button"
            onClick={() => void loadPreview()}
            disabled={!periodStart || !periodEnd}
          >
            Calculer l&apos;aperçu
          </button>
        </div>

        {preview && (
          <div className="form-grid">
            <p>
              <strong>{preview.transactionCount}</strong> facture(s) —{" "}
              <strong>{formatEuroCents(preview.totalCents)}</strong> sur la période.
            </p>
            {preview.truncated && (
              <p className="warn">
                Facturier lu par page : l&apos;agrégat est partiel, vérifiez-le avant
                transmission.
              </p>
            )}
            <ul className="muted">
              {preview.caveats.map((caveat) => (
                <li key={caveat}>{caveat}</li>
              ))}
            </ul>
            <label>
              Montant de TVA de la période (€) — saisi par vos soins
              <input
                inputMode="decimal"
                value={vatEuros}
                onChange={(event) => setVatEuros(event.target.value)}
                placeholder="0,00"
              />
            </label>
            <button type="button" onClick={() => void propose()} disabled={busy || !vatEuros}>
              Proposer la transmission
            </button>
          </div>
        )}
        {notice && <p className="hint">{notice}</p>}

        {reports.length > 0 && (
          <table className="ledger">
            <thead>
              <tr>
                <th>Période</th>
                <th>Total déclaré</th>
                <th>Statut</th>
                <th>Référence plateforme</th>
                <th>Transmise le</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((submission) => (
                <SubmissionRow key={submission.id} submission={submission} labels={labels} />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
