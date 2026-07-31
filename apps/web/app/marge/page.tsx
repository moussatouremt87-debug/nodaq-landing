"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, COST_CATEGORIES, getMargin, putCost } from "../../lib/api";
import type { MarginReport } from "../../lib/api";

/*
 * Marge (2.8).
 *
 * Le parti pris de la page : **un plafond ne se rend jamais comme un
 * résultat**. Tant qu'un poste manque, le chiffre est précédé de « au plus »,
 * les postes manquants sont listés SOUS le chiffre, et la saisie qui les
 * comblerait est à portée de clic. Afficher « 42 % » nu serait la seule vraie
 * faute possible sur cet écran.
 */

const euros = (cents: number): string =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(cents / 100);

function lastCompleteMonth(): string {
  const now = new Date();
  const year = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const month = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth();
  return `${year}-${String(month).padStart(2, "0")}`;
}

export default function MargePage() {
  const [forbidden, setForbidden] = useState(false);
  const [month, setMonth] = useState(lastCompleteMonth());
  const [report, setReport] = useState<MarginReport | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const load = useCallback(async (target: string) => {
    setError(null);
    setRefusal(null);
    try {
      const result = await getMargin(target);
      if ("refused" in result) {
        setReport(null);
        setRefusal(result.reason);
      } else {
        setReport(result);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
      else setError("marge indisponible — réessayez");
    }
  }, []);

  useEffect(() => {
    void load(lastCompleteMonth());
  }, [load]);

  async function saveCost(category: string): Promise<void> {
    const raw = (amounts[category] ?? "").trim().replace(",", ".");
    const euros = Number(raw);
    if (raw === "" || !Number.isFinite(euros)) {
      setError("montant illisible");
      return;
    }
    try {
      await putCost({ month, category, amountCents: Math.round(euros * 100) });
      setAmounts((previous) => ({ ...previous, [category]: "" }));
      await load(month);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "enregistrement impossible");
    }
  }

  if (forbidden) {
    return (
      <div className="page">
        <section className="card">
          <h2>Marge</h2>
          <p className="muted">
            Réservé au dirigeant (chiffre d&apos;affaires, charges et masse salariale).
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="page">
      <section className="card">
        <h2>Marge</h2>
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
          <button className="primary" onClick={() => void load(month)}>
            Afficher
          </button>
        </div>
        {error && <p className="warn">{error}</p>}
        {refusal && <p className="warn">{refusal}</p>}
      </section>

      {report && (
        <>
          <section className="card">
            <h2>
              {report.month} — {euros(report.revenueCents)} de chiffre d&apos;affaires
            </h2>
            {report.revenueUnavailable && (
              <p className="warn">
                Facturier indisponible : aucun chiffre d&apos;affaires n&apos;a pu être lu.
              </p>
            )}
            {report.levels.length === 0 ? (
              <p className="muted">{report.notEvaluated.join(" ")}</p>
            ) : (
              <ul className="device-list">
                {report.levels.map((level) => (
                  <li key={level.level} className="device-row">
                    <div>
                      <strong>{level.label}</strong>
                      <br />
                      {/* « au plus » AVANT le chiffre : un plafond ne peut pas
                          se lire comme un résultat, même en diagonale. */}
                      <span style={{ fontSize: "1.2em" }}>
                        {level.kind === "borne_superieure" ? "au plus " : ""}
                        <strong>{Math.round(level.marginRatio * 100)} %</strong>{" "}
                        <span className="muted">({euros(level.marginCents)})</span>
                      </span>
                      <br />
                      <span className="muted">{level.reason}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="warn">
              {report.label} (règles du {report.rulesVersion})
            </p>
          </section>

          <section className="card">
            <h2>Charges du mois</h2>
            <ul className="device-list">
              {COST_CATEGORIES.map((category) => {
                const known = report.costs.find((cost) => cost.category === category.id);
                return (
                  <li key={category.id} className="device-row">
                    <div>
                      <strong>{category.label}</strong>{" "}
                      {known ? (
                        <span className="muted">
                          {euros(known.amountCents)} · {known.source}
                        </span>
                      ) : (
                        <span className="warn">non renseigné — la marge reste un plafond</span>
                      )}
                      <br />
                      <input
                        style={{ width: 120 }}
                        inputMode="decimal"
                        placeholder="montant €"
                        value={amounts[category.id] ?? ""}
                        onChange={(e) =>
                          setAmounts((previous) => ({ ...previous, [category.id]: e.target.value }))
                        }
                      />{" "}
                      <button onClick={() => void saveCost(category.id)}>Enregistrer</button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="muted">
              Les charges d&apos;un import FEC sont reprises automatiquement (source « fec ») ; une
              saisie les complète sans les remplacer. Importez votre FEC pour éviter de tout saisir
              — un poste oublié fait paraître la marge meilleure qu&apos;elle n&apos;est.
            </p>
            {(report.excludedCount > 0 || report.unusableCount > 0) && (
              <p className="muted">
                {report.excludedCount > 0 &&
                  `${report.excludedCount} facture(s) hors CA (brouillon, avoir, annulée). `}
                {report.unusableCount > 0 &&
                  `${report.unusableCount} facture(s) écartée(s) (montant illisible ou devise étrangère).`}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
