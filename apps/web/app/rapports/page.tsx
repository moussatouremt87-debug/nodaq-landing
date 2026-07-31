"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, getMonthlyReport } from "../../lib/api";
import type { MonthlyReport } from "../../lib/api";

/*
 * Rapport mensuel + anomalies (2.11) — owner only (CA du mois, encours échu,
 * nom du meilleur client).
 *
 * Le parti pris de la page : une anomalie n'est JAMAIS affichée comme un
 * verdict. Chaque ligne montre la valeur observée, la référence, le seuil
 * franchi et la taille de l'échantillon — de quoi la contester. Et ce que le
 * produit n'a PAS pu évaluer est affiché aussi visiblement que ce qu'il a
 * trouvé : un rapport sans anomalie parce qu'il manquait l'historique n'est
 * pas un mois sans anomalie.
 */

const ANOMALY_LABELS: Record<string, string> = {
  ca_en_baisse: "Chiffre d'affaires en baisse",
  facture_inhabituelle: "Facture inhabituelle",
  concentration_client: "Concentration client",
  impayes_en_hausse: "Impayés en hausse",
};

const euros = (cents: number): string =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(cents / 100);

/** Mois par défaut de la saisie : le dernier mois COMPLET, comme l'API. */
function lastCompleteMonth(): string {
  const now = new Date();
  const year = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const month = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth();
  return `${year}-${String(month).padStart(2, "0")}`;
}

export default function RapportsPage() {
  const [forbidden, setForbidden] = useState(false);
  const [month, setMonth] = useState(lastCompleteMonth());
  const [report, setReport] = useState<MonthlyReport | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (target: string) => {
    setLoading(true);
    setError(null);
    setRefusal(null);
    try {
      const result = await getMonthlyReport(target);
      if ("refused" in result) {
        setReport(null);
        setRefusal(result.reason);
      } else {
        setReport(result);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
      else setError("rapport indisponible — réessayez");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(lastCompleteMonth());
  }, [load]);

  if (forbidden) {
    return (
      <div className="page">
        <section className="card">
          <h2>Rapport mensuel</h2>
          <p className="muted">
            Réservé au dirigeant (chiffre d&apos;affaires et clients de l&apos;entreprise).
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="page">
      <section className="card">
        <h2>Rapport mensuel</h2>
        <div className="form-grid">
          <label>
            Mois :{" "}
            <input
              type="month"
              value={month}
              max={lastCompleteMonth()}
              onChange={(e) => setMonth(e.target.value)}
            />
          </label>
          <button className="primary" onClick={() => void load(month)} disabled={loading}>
            {loading ? "Lecture…" : "Afficher"}
          </button>
        </div>
        {error && <p className="warn">{error}</p>}
        {refusal && <p className="warn">{refusal}</p>}
      </section>

      {report && (
        <>
          <section className="card">
            <h2>{report.month}</h2>
            <ul className="device-list">
              <li className="device-row">
                <div>
                  <strong>{euros(report.revenueCents)}</strong>{" "}
                  <span className="muted">
                    de chiffre d&apos;affaires · {report.invoiceCount} facture(s)
                  </span>
                </div>
              </li>
              <li className="device-row">
                <div>
                  <strong>{euros(report.overdueCents)}</strong>{" "}
                  <span className="muted">
                    de factures du mois aujourd&apos;hui en retard de paiement (
                    {report.overdueCount})
                  </span>
                </div>
              </li>
              <li className="device-row">
                <div>
                  {report.referenceRevenueCents === null ? (
                    <span className="muted">
                      Référence : indisponible — {report.referenceMonths} mois d&apos;historique
                      lus.
                    </span>
                  ) : (
                    <span className="muted">
                      Référence : {euros(report.referenceRevenueCents)} en moyenne sur{" "}
                      {report.referenceMonths} mois précédents.
                    </span>
                  )}
                </div>
              </li>
              {report.topCustomer && (
                <li className="device-row">
                  <div>
                    <strong>{report.topCustomer.name ?? "client sans nom"}</strong>{" "}
                    <span className="muted">
                      premier client du mois · {euros(report.topCustomer.totalCents)} (
                      {Math.round(report.topCustomer.share * 100)} % du CA)
                    </span>
                  </div>
                </li>
              )}
            </ul>
            {(report.unusableCount > 0 ||
              report.excludedCount > 0 ||
              report.unattributedCount > 0) && (
              <p className="muted">
                {report.unusableCount > 0 &&
                  `${report.unusableCount} facture(s) écartée(s) (montant ou date illisible, devise étrangère jamais convertie). `}
                {report.excludedCount > 0 &&
                  `${report.excludedCount} brouillon(s), devis, avoir(s) ou facture(s) annulée(s) hors du CA. `}
                {report.unattributedCount > 0 &&
                  `${report.unattributedCount} facture(s) (${euros(report.unattributedCents)}) ne sont rattachées à aucun client : comptées au CA, jamais attribuées.`}
              </p>
            )}
          </section>

          <section className="card">
            <h2>Anomalies</h2>
            {/* La troncature qualifie les anomalies : elle est affichée AVEC
                elles, pas dans un autre coin de l'écran. */}
            {report.windowTruncated && (
              <p className="warn">
                Lecture du facturier tronquée : des factures peuvent manquer, y compris sur le mois
                analysé. Les écarts ci-dessous portent sur un historique incomplet.
              </p>
            )}
            {report.anomalies.length === 0 ? (
              <p className="muted">
                Aucun écart au-delà des seuils sur les règles évaluées ci-dessous.
              </p>
            ) : (
              <ul className="device-list">
                {report.anomalies.map((anomaly) => (
                  <li key={anomaly.kind} className="device-row">
                    <div>
                      <strong>{ANOMALY_LABELS[anomaly.kind] ?? anomaly.kind}</strong>
                      <br />
                      <span>{anomaly.reason}</span>
                      <br />
                      {/* Le calcul est montré : un écart mesuré se conteste,
                          un verdict ne se conteste pas. */}
                      <span className="muted">
                        Calculé sur {anomaly.sampleSize} élément(s) · seuil {anomaly.threshold}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {report.notEvaluated.length > 0 && (
            <section className="card">
              <h2>Non évalué</h2>
              <p className="muted">
                Ces règles n&apos;ont pas pu être calculées faute de données. Leur silence n&apos;est
                pas un feu vert.
              </p>
              <ul className="device-list">
                {report.notEvaluated.map((line) => (
                  <li key={line} className="device-row">
                    <div>{line}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="card">
            <p className="warn">
              {report.label} (règles du {report.rulesVersion})
            </p>
          </section>
        </>
      )}
    </div>
  );
}
