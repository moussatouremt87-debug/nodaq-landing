"use client";

import { useCallback, useState } from "react";
import {
  ApiError,
  createContrat,
  formatEuroCents,
  listContrats,
  materialiserContrat,
  setContratStatus,
} from "../../lib/api";
import type { Contrat } from "../../lib/api";
import { emitDomainEvent } from "../../lib/freshness";
import { useFreshness } from "../../lib/useFreshness";

/*
 * Contrats récurrents (4.2, bloc 2).
 *
 * LA PROPRIÉTÉ QUE CET ÉCRAN DOIT TENIR : matérialiser n'est jamais
 * automatique. Le plan est calculé et AFFICHÉ — combien de passages sont dus,
 * depuis quand, quand tombe le prochain — et c'est le dirigeant qui clique.
 * Un générateur de fond remplirait la base de travail que personne n'a décidé
 * de faire, et le patron découvrirait douze affaires un lundi matin sans
 * savoir d'où elles viennent.
 *
 * Aucun calcul de date ICI : le plan vient de l'API. Deux moteurs de
 * récurrence, c'est deux réponses différentes à la même question le jour où
 * l'un des deux bouge.
 */

const CADENCE_LABELS: Record<string, string> = {
  mensuel: "mensuel",
  trimestriel: "trimestriel",
  semestriel: "semestriel",
  annuel: "annuel",
};

export default function ContratsPage() {
  const [contrats, setContrats] = useState<Contrat[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [ouvert, setOuvert] = useState(false);
  const [form, setForm] = useState({
    label: "",
    clientName: "",
    cadence: "mensuel",
    amount: "",
    startDate: "",
  });

  const load = useCallback(async () => {
    await listContrats()
      .then((res) => setContrats(res.contrats))
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError && err.status === 403
            ? "Réservé aux membres de l'organisation."
            : "Impossible de charger les contrats.",
        );
        throw err;
      });
  }, []);

  const freshness = useFreshness(["contrats"], load);

  async function creer(): Promise<void> {
    setError(null);
    setNotice(null);
    const amount = form.amount.trim();
    const cents = amount === "" ? null : Math.round(Number(amount.replace(",", ".")) * 100);
    if (cents !== null && (!Number.isFinite(cents) || cents < 0)) {
      setError("montant invalide");
      return;
    }
    try {
      await createContrat({
        label: form.label.trim(),
        clientName: form.clientName.trim() === "" ? null : form.clientName.trim(),
        cadence: form.cadence,
        amountCents: cents,
        startDate: form.startDate === "" ? null : form.startDate,
      });
      emitDomainEvent("contrat.modifie");
      setOuvert(false);
      setForm({ label: "", clientName: "", cadence: "mensuel", amount: "", startDate: "" });
      setNotice("Contrat enregistré.");
      freshness.refresh();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? "Réservé au dirigeant."
          : err instanceof ApiError
            ? err.message
            : "enregistrement impossible",
      );
    }
  }

  async function materialiser(contrat: Contrat): Promise<void> {
    setBusyId(contrat.id);
    setError(null);
    setNotice(null);
    try {
      const res = await materialiserContrat(contrat.id);
      emitDomainEvent("contrat.modifie");
      setNotice(
        [
          res.created.length === 1
            ? "1 affaire créée"
            : `${res.created.length} affaires créées`,
          // La troncature est DITE à l'écran, pas seulement dans la réponse :
          // un rattrapage partiel qui se tait laisse croire que tout est à jour.
          res.truncated ? `${res.reason ?? "reste à rattraper"} — recliquez pour la suite` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      );
      freshness.refresh();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? `Rien à faire : ${err.message}.`
          : err instanceof ApiError && err.status === 403
            ? "Réservé au dirigeant."
            : "Matérialisation impossible.",
      );
    } finally {
      setBusyId(null);
    }
  }

  async function basculer(contrat: Contrat): Promise<void> {
    setBusyId(contrat.id);
    setError(null);
    try {
      await setContratStatus(contrat.id, contrat.status === "ACTIF" ? "SUSPENDU" : "ACTIF");
      emitDomainEvent("contrat.modifie");
      freshness.refresh();
    } catch {
      setError("Réservé au dirigeant.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page">
      <h1 className="page-title">Contrats récurrents</h1>
      <p className="page-sub">
        Entretien, maintenance, forfait mensuel. Les passages dus sont calculés — ils ne
        deviennent des affaires que quand vous le décidez.
      </p>

      {error && <p className="error-line">{error}</p>}
      {notice && <p className="hint">{notice}</p>}

      <section className="card">
        <div className="card-header">
          <div className="titles">
            <div className="title">{contrats.length} contrat(s)</div>
          </div>
          <button className="btn" onClick={() => setOuvert((v) => !v)}>
            {ouvert ? "Annuler" : "Nouveau contrat"}
          </button>
        </div>

        {ouvert && (
          <div className="form-grid" style={{ marginBottom: 14 }}>
            <label>
              Intitulé :{" "}
              <input
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
              />
            </label>
            <label>
              Client :{" "}
              <input
                value={form.clientName}
                onChange={(e) => setForm({ ...form, clientName: e.target.value })}
              />
            </label>
            <label>
              Cadence :{" "}
              <select
                value={form.cadence}
                onChange={(e) => setForm({ ...form, cadence: e.target.value })}
              >
                {Object.entries(CADENCE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {/* « par période » est DANS le libellé : un contrat à 200 €/mois
                  saisi comme 2 400 € donnerait une marge flatteuse sur la
                  première intervention et onze chantiers à zéro. */}
              Montant HT par période :{" "}
              <input
                style={{ width: 110 }}
                inputMode="decimal"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
              />
            </label>
            <label>
              Premier passage :{" "}
              <input
                type="date"
                value={form.startDate}
                onChange={(e) => setForm({ ...form, startDate: e.target.value })}
              />
            </label>
            <button className="primary" disabled={form.label.trim() === ""} onClick={() => void creer()}>
              Enregistrer
            </button>
          </div>
        )}

        {contrats.length === 0 ? (
          <p className="empty">Aucun contrat.</p>
        ) : (
          <table className="ledger">
            <tbody>
              {contrats.map((contrat) => (
                <tr key={contrat.id}>
                  <td>
                    <strong>{contrat.label}</strong>
                    {contrat.clientName && <div className="ameta">{contrat.clientName}</div>}
                    <div className="ameta">
                      {CADENCE_LABELS[contrat.cadence] ?? contrat.cadence}
                      {contrat.amountCents !== null &&
                        ` · ${formatEuroCents(contrat.amountCents)} par période`}
                    </div>
                  </td>
                  <td>
                    {contrat.status !== "ACTIF" ? (
                      <span className="muted">{contrat.status.toLowerCase()}</span>
                    ) : contrat.plan.due.length > 0 ? (
                      <>
                        <strong style={{ color: "#b45309" }}>
                          {contrat.plan.due.length} passage(s) à planifier
                        </strong>
                        {/* La DATE du plus ancien : « 3 passages » sans date se
                            lit « cette semaine » alors que le plus ancien peut
                            dater de mars. */}
                        <div className="ameta">depuis le {contrat.plan.due[0]}</div>
                      </>
                    ) : (
                      <span className="muted">
                        {contrat.plan.next !== null
                          ? `prochain le ${contrat.plan.next}`
                          : contrat.plan.ended
                            ? "terminé"
                            : (contrat.plan.reason ?? "rien à planifier")}
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="btn"
                      disabled={busyId === contrat.id || contrat.plan.due.length === 0}
                      onClick={() => void materialiser(contrat)}
                    >
                      Créer les affaires
                    </button>{" "}
                    <button
                      className="btn"
                      disabled={busyId === contrat.id}
                      onClick={() => void basculer(contrat)}
                    >
                      {contrat.status === "ACTIF" ? "Suspendre" : "Réactiver"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
