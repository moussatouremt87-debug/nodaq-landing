"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  formatEuroCents,
  getFiscalProfile,
  getTaxSchedule,
  putFiscalProfile,
  putTaxDeadline,
} from "../../lib/api";
import type { FiscalProfile, TaxDeadline, TaxSchedule } from "../../lib/api";

/*
 * Échéancier fiscal & social (2.9) — owner only : le régime fiscal et les
 * montants d'impôt sont des données de dirigeant.
 *
 * Deux principes portés jusqu'à l'écran : le calendrier ne prétend jamais
 * savoir ce qu'il ignore (régime non renseigné = échéances non proposées,
 * date dépendant du SIREN = signalée), et aucun montant n'est estimé — seul
 * ce que l'owner saisit apparaît, et seul cela pèse sur le prévisionnel.
 */

const VAT_LABELS: [string, string][] = [
  ["inconnu", "Non renseigné"],
  ["franchise", "Franchise en base (pas de TVA)"],
  ["reel_simplifie", "Réel simplifié (acomptes + CA12)"],
  ["reel_normal_mensuel", "Réel normal — CA3 mensuelle"],
  ["reel_normal_trimestriel", "Réel normal — CA3 trimestrielle"],
];

const PAYROLL_LABELS: [string, string][] = [
  ["aucune", "Aucun salarié"],
  ["mensuelle", "Paie mensuelle (DSN)"],
  ["trimestrielle", "Cotisations trimestrielles"],
];

const MONTHS = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
];

const CATEGORY_LABELS: Record<string, string> = {
  tva: "TVA",
  is: "IS",
  social: "Social",
  locale: "Locale",
};

function DeadlineRow({
  deadline,
  onSaved,
}: {
  deadline: TaxDeadline;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState(
    deadline.amountCents === null ? "" : String(deadline.amountCents / 100),
  );
  const [busy, setBusy] = useState(false);

  async function save(status: string): Promise<void> {
    setBusy(true);
    try {
      const trimmed = amount.trim().replace(",", ".");
      const parsed = trimmed === "" ? null : Number(trimmed);
      await putTaxDeadline({
        obligationId: deadline.obligationId,
        dueDate: deadline.dueDate,
        amountCents:
          parsed !== null && Number.isFinite(parsed) && parsed >= 0
            ? Math.round(parsed * 100)
            : null,
        status,
        note: deadline.note,
      });
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>
        {new Date(deadline.dueDate).toLocaleDateString("fr-FR")}
        {deadline.dateIsApproximate && (
          <span className="muted" title={deadline.basis}>
            {" "}
            (date à confirmer)
          </span>
        )}
      </td>
      <td>
        {deadline.label}
        <div className="muted">{deadline.period}</div>
      </td>
      <td>{CATEGORY_LABELS[deadline.category] ?? deadline.category}</td>
      <td>
        <input
          inputMode="decimal"
          value={amount}
          placeholder="montant €"
          onChange={(event) => setAmount(event.target.value)}
          style={{ width: 110 }}
        />
      </td>
      <td>
        <select
          value={deadline.status}
          disabled={busy}
          onChange={(event) => void save(event.target.value)}
        >
          <option value="prevu">À payer</option>
          <option value="paye">Payée</option>
          <option value="non_applicable">Non applicable</option>
        </select>
      </td>
      <td>
        <button type="button" disabled={busy} onClick={() => void save(deadline.status)}>
          Enregistrer
        </button>
      </td>
    </tr>
  );
}

export default function EcheancierPage() {
  const [forbidden, setForbidden] = useState(false);
  const [schedule, setSchedule] = useState<TaxSchedule | null>(null);
  const [profile, setProfile] = useState<FiscalProfile | null>(null);
  const [months, setMonths] = useState(3);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setProfile(await getFiscalProfile());
      setSchedule(await getTaxSchedule(months));
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
      else setError("échéancier indisponible — réessayez");
    }
  }, [months]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function saveProfile(next: Partial<FiscalProfile>): Promise<void> {
    if (!profile) return;
    setError(null);
    try {
      await putFiscalProfile({
        vatRegime: next.vatRegime ?? profile.vatRegime,
        corporateTaxLiable: next.corporateTaxLiable ?? profile.corporateTaxLiable,
        fiscalYearEndMonth: next.fiscalYearEndMonth ?? profile.fiscalYearEndMonth,
        payrollPeriodicity: next.payrollPeriodicity ?? profile.payrollPeriodicity,
      });
      await refresh();
    } catch {
      setError("enregistrement impossible");
    }
  }

  if (forbidden) {
    return (
      <div className="page">
        <section className="card">
          <h2>Échéancier fiscal &amp; social</h2>
          <p className="muted">
            Réservé au dirigeant : cette page expose le régime fiscal et les montants
            d&apos;impôt de l&apos;entreprise.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="page">
      <section className="card">
        <h2>Votre régime</h2>
        <p className="muted">
          Rien n&apos;est deviné : tant qu&apos;un régime n&apos;est pas renseigné, les
          échéances correspondantes ne sont pas proposées.
        </p>
        {profile && (
          <div className="form-grid">
            <label>
              TVA
              <select
                value={profile.vatRegime}
                onChange={(event) => void saveProfile({ vatRegime: event.target.value })}
              >
                {VAT_LABELS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Paie
              <select
                value={profile.payrollPeriodicity}
                onChange={(event) => void saveProfile({ payrollPeriodicity: event.target.value })}
              >
                {PAYROLL_LABELS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Clôture de l&apos;exercice
              <select
                value={profile.fiscalYearEndMonth}
                onChange={(event) =>
                  void saveProfile({ fiscalYearEndMonth: Number(event.target.value) })
                }
              >
                {MONTHS.map((month, index) => (
                  <option key={month} value={index + 1}>
                    {month}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={profile.corporateTaxLiable}
                onChange={(event) =>
                  void saveProfile({ corporateTaxLiable: event.target.checked })
                }
              />{" "}
              Soumise à l&apos;impôt sur les sociétés
            </label>
          </div>
        )}
        {error && <p className="warn">{error}</p>}
      </section>

      <section className="card">
        <h2>Prochaines échéances</h2>
        {schedule && (
          <>
            <p className="muted">{schedule.label}</p>
            <div className="form-grid">
              <label>
                Horizon
                <select value={months} onChange={(event) => setMonths(Number(event.target.value))}>
                  {[3, 6, 12].map((value) => (
                    <option key={value} value={value}>
                      {value} mois
                    </option>
                  ))}
                </select>
              </label>
              <p>
                À décaisser (montants que vous avez saisis) :{" "}
                <strong>{formatEuroCents(schedule.plannedOutflowCents)}</strong>
                {schedule.unpricedCount > 0 && (
                  <span className="muted">
                    {" "}
                    — {schedule.unpricedCount} échéance(s) sans montant renseigné
                  </span>
                )}
              </p>
            </div>
            {schedule.gaps.length > 0 && (
              <ul className="muted">
                {schedule.gaps.map((gap) => (
                  <li key={gap}>{gap}</li>
                ))}
              </ul>
            )}
            {schedule.deadlines.length === 0 ? (
              <p className="muted">
                Aucune échéance sur la période — complétez votre régime ci-dessus.
              </p>
            ) : (
              <table className="ledger">
                <thead>
                  <tr>
                    <th>Échéance</th>
                    <th>Obligation</th>
                    <th>Type</th>
                    <th>Montant</th>
                    <th>État</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {schedule.deadlines.map((deadline) => (
                    <DeadlineRow
                      key={`${deadline.obligationId}|${deadline.dueDate}`}
                      deadline={deadline}
                      onSaved={() => void refresh()}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>
    </div>
  );
}
