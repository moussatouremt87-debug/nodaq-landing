"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  ApiError,
  createAbsence,
  createStaff,
  deleteAbsence,
  formatEuroCents,
  getHourlyPerformance,
  getRh,
  getStaffingPlan,
  updateStaff,
} from "../../lib/api";
import type { HourlyPerformance, StaffAbsence, StaffMember, StaffingPlan } from "../../lib/api";

/*
 * Équipe & plannings (3.5) — owner only (données RH = PII). Capacité vs
 * charge ESTIMÉE (prévision de ventes ÷ taux horaire configurable) : chaque
 * verdict est chiffré et le tout est TOUJOURS labellisé estimation.
 */

const ABSENCE_TYPES = [
  ["conges", "Congés"],
  ["maladie", "Maladie"],
  ["formation", "Formation"],
  ["autre", "Autre"],
] as const;

export default function RhPage() {
  const [forbidden, setForbidden] = useState(false);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [absences, setAbsences] = useState<StaffAbsence[]>([]);
  const [plan, setPlan] = useState<StaffingPlan | null>(null);
  const [perf, setPerf] = useState<HourlyPerformance | null>(null);
  const [rate, setRate] = useState("60");
  const [staffForm, setStaffForm] = useState({ name: "", role: "", weeklyHours: "35" });
  const [absenceForm, setAbsenceForm] = useState({ staffId: "", type: "conges", startDate: "", endDate: "" });
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (hourlyRate?: number) => {
    try {
      const rh = await getRh();
      setStaff(rh.staff);
      setAbsences(rh.absences);
      const nextPlan = await getStaffingPlan(hourlyRate).catch(() => null);
      setPlan(nextPlan);
      if (nextPlan) setRate(String(Math.round(nextPlan.hourlyRateCents / 100)));
      // Même taux pour l'objectif de performance : un seul réglage cohérent.
      setPerf(await getHourlyPerformance(hourlyRate).catch(() => null));
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
      else setError("données RH indisponibles — réessayez");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function addStaff(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    const weeklyHours = Number(staffForm.weeklyHours);
    if (!staffForm.name || !Number.isInteger(weeklyHours)) {
      setError("formulaire incomplet");
      return;
    }
    try {
      await createStaff({ name: staffForm.name, role: staffForm.role, weeklyHours });
      setStaffForm({ name: "", role: "", weeklyHours: "35" });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "ajout impossible");
    }
  }

  async function addAbsence(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    if (!absenceForm.staffId || !absenceForm.startDate || !absenceForm.endDate) {
      setError("absence incomplète");
      return;
    }
    try {
      await createAbsence(absenceForm);
      setAbsenceForm({ staffId: "", type: "conges", startDate: "", endDate: "" });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "ajout impossible");
    }
  }

  if (forbidden) {
    return (
      <div className="page">
        <section className="card">
          <h2>Équipe & plannings</h2>
          <p className="muted">Réservé au dirigeant (données RH).</p>
        </section>
      </div>
    );
  }

  const staffName = (id: string): string => staff.find((m) => m.id === id)?.name ?? "?";

  return (
    <div className="page">
      <section className="card">
        <h2>Capacité vs charge estimée</h2>
        {plan === null ? (
          <p className="muted">Plan indisponible.</p>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>Mois</th>
                  <th>Capacité</th>
                  <th>Charge estimée</th>
                  <th>Écart</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {plan.months.map((month) => (
                  <tr key={month.month} title={month.reason}>
                    <td>{month.month}</td>
                    <td>{month.capacityHours} h</td>
                    <td>
                      {month.estimatedWorkloadHours === null ? "—" : `${month.estimatedWorkloadHours} h`}
                    </td>
                    <td>{month.gapHours === null ? "—" : `${month.gapHours > 0 ? "+" : ""}${month.gapHours} h`}</td>
                    <td>
                      {month.verdict === "sous-capacite" ? (
                        <strong style={{ color: "#dc2626" }}>sous-capacité</strong>
                      ) : (
                        month.verdict.replace("-", " ")
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="warn">{plan.label}</p>
            <label>
              Taux horaire facturé moyen (€/h) :{" "}
              <input
                style={{ width: 80 }}
                inputMode="numeric"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />{" "}
              <button
                onClick={() => {
                  const value = Number(rate);
                  if (Number.isFinite(value) && value >= 10 && value <= 500) {
                    setError(null);
                    void refresh(value);
                  } else {
                    setError("taux horaire entre 10 et 500 €/h");
                  }
                }}
              >
                Recalculer
              </button>
            </label>
          </>
        )}
      </section>

      <section className="card">
        <h2>Performance horaire réalisée</h2>
        {perf === null ? (
          <p className="muted">Performance indisponible.</p>
        ) : perf.months.length === 0 ? (
          <p className="muted">
            {perf.revenueUnavailable
              ? "CA indisponible — connectez un facturier (Pennylane, démo ou FEC) pour mesurer le taux réalisé."
              : "Aucun mois avec du chiffre d'affaires observé sur la fenêtre."}
          </p>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>Mois</th>
                  <th>Heures estimées</th>
                  <th>CA réalisé</th>
                  <th>€/h réalisé</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {perf.months.map((month) => (
                  <tr key={month.month} title={month.reason}>
                    <td>{month.month}</td>
                    <td>{month.workedHours} h</td>
                    <td>{formatEuroCents(month.revenueCents)}</td>
                    <td>
                      {month.revenuePerHourCents === null
                        ? "—"
                        : `${Math.round(month.revenuePerHourCents / 100)} €/h`}
                    </td>
                    <td>
                      {month.verdict === "en-dessous" ? (
                        <strong style={{ color: "#dc2626" }}>en-dessous</strong>
                      ) : (
                        month.verdict.replace("-", " ")
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {perf.averageRateCents !== null && (
              <p className="muted">
                Moyenne pondérée : {Math.round(perf.averageRateCents / 100)} €/h vs objectif{" "}
                {Math.round(perf.targetRateCents / 100)} €/h
                {perf.trendCentsPerMonth !== 0 &&
                  ` · tendance ${perf.trendCentsPerMonth > 0 ? "+" : "−"}${Math.abs(
                    Math.round(perf.trendCentsPerMonth / 100),
                  )} €/h par mois`}
              </p>
            )}
            <p className="warn">{perf.label}</p>
          </>
        )}
      </section>

      <section className="card">
        <h3>Équipe ({staff.filter((m) => m.active).length} actifs)</h3>
        <ul className="device-list">
          {staff.map((member) => (
            <li key={member.id} className="device-row">
              <div>
                <strong>{member.name}</strong>{" "}
                <span className="muted">
                  {member.role || "—"} · {member.weeklyHours} h/sem
                  {!member.active && " · inactif"}
                </span>
              </div>
              <button
                onClick={() => void updateStaff(member.id, { active: !member.active }).then(() => refresh())}
              >
                {member.active ? "Désactiver" : "Réactiver"}
              </button>
            </li>
          ))}
        </ul>
        <form onSubmit={(event) => void addStaff(event)} className="form-grid">
          <input
            placeholder="Nom"
            value={staffForm.name}
            onChange={(e) => setStaffForm({ ...staffForm, name: e.target.value })}
          />
          <input
            placeholder="Rôle (ex. technicien)"
            value={staffForm.role}
            onChange={(e) => setStaffForm({ ...staffForm, role: e.target.value })}
          />
          <input
            placeholder="Heures/semaine"
            inputMode="numeric"
            value={staffForm.weeklyHours}
            onChange={(e) => setStaffForm({ ...staffForm, weeklyHours: e.target.value })}
          />
          <button className="primary">Ajouter</button>
        </form>
      </section>

      <section className="card">
        <h3>Absences</h3>
        <ul className="device-list">
          {absences.map((absence) => (
            <li key={absence.id} className="device-row">
              <div>
                <strong>{staffName(absence.staffId)}</strong>{" "}
                <span className="muted">
                  {absence.type} · du {absence.startDate.slice(0, 10)} au {absence.endDate.slice(0, 10)}
                </span>
              </div>
              <button onClick={() => void deleteAbsence(absence.id).then(() => refresh())}>
                Supprimer
              </button>
            </li>
          ))}
        </ul>
        <form onSubmit={(event) => void addAbsence(event)} className="form-grid">
          <select
            value={absenceForm.staffId}
            onChange={(e) => setAbsenceForm({ ...absenceForm, staffId: e.target.value })}
          >
            <option value="">— salarié —</option>
            {staff.filter((m) => m.active).map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
          <select
            value={absenceForm.type}
            onChange={(e) => setAbsenceForm({ ...absenceForm, type: e.target.value })}
          >
            {ABSENCE_TYPES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={absenceForm.startDate}
            onChange={(e) => setAbsenceForm({ ...absenceForm, startDate: e.target.value })}
          />
          <input
            type="date"
            value={absenceForm.endDate}
            onChange={(e) => setAbsenceForm({ ...absenceForm, endDate: e.target.value })}
          />
          <button className="primary">Ajouter l&apos;absence</button>
        </form>
        {error && <p className="warn">{error}</p>}
      </section>
    </div>
  );
}
