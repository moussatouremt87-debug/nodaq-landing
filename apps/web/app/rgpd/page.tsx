"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  addActivityFromTemplate,
  deleteActivity,
  getRgpdRegister,
} from "../../lib/api";
import type { RgpdRegister } from "../../lib/api";

/*
 * Assistant RGPD (3.9) — owner only (registre des traitements = document de
 * conformité stratégique, art. 30). Modèles CNIL versionnés sourcés, audit
 * déterministe expliqué ; information générale, jamais un conseil juridique
 * ni un DPO — le label reste affiché en permanence.
 */

const BASIS_LABELS: Record<string, string> = {
  consentement: "Consentement",
  contrat: "Contrat",
  obligation_legale: "Obligation légale",
  interet_legitime: "Intérêt légitime",
  mission_publique: "Mission publique",
  interets_vitaux: "Intérêts vitaux",
};

export default function RgpdPage() {
  const [forbidden, setForbidden] = useState(false);
  const [register, setRegister] = useState<RgpdRegister | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRegister(await getRgpdRegister());
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
      else setError("registre indisponible — réessayez");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function addTemplate(templateId: string): Promise<void> {
    setError(null);
    try {
      await addActivityFromTemplate(templateId);
      await refresh();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? "ce traitement est déjà dans le registre"
          : "ajout impossible",
      );
    }
  }

  async function remove(id: string): Promise<void> {
    setError(null);
    try {
      await deleteActivity(id);
      await refresh();
    } catch {
      setError("suppression impossible");
    }
  }

  if (forbidden) {
    return (
      <div className="page">
        <section className="card">
          <h2>Assistant RGPD</h2>
          <p className="muted">Réservé au dirigeant (registre de conformité).</p>
        </section>
      </div>
    );
  }

  if (register === null) {
    return (
      <div className="page">
        <section className="card">
          <h2>Assistant RGPD</h2>
          <p className="muted">{error ?? "Chargement…"}</p>
        </section>
      </div>
    );
  }

  const inRegister = new Set(
    register.activities.map((activity) => activity.sourceTemplate).filter(Boolean),
  );
  const alerts = register.audit.issues.filter((issue) => issue.severity === "alerte");
  const warnings = register.audit.issues.filter((issue) => issue.severity === "attention");

  return (
    <div className="page">
      <section className="card">
        <h2>Audit du registre</h2>
        {register.audit.issues.length === 0 ? (
          <p>
            ✓ Aucune alerte sur les {register.audit.activityCount} traitement(s) enregistrés.
          </p>
        ) : (
          <ul className="device-list">
            {[...alerts, ...warnings].map((issue, index) => (
              <li key={index} className="device-row">
                <div>
                  {issue.severity === "alerte" ? (
                    <strong style={{ color: "#dc2626" }}>Alerte</strong>
                  ) : (
                    <strong>Attention</strong>
                  )}{" "}
                  {issue.activityName && <strong>{issue.activityName} — </strong>}
                  <span>{issue.reason}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="warn">
          {register.audit.label} (catalogue du {register.audit.version})
        </p>
      </section>

      <section className="card">
        <h2>Registre des traitements ({register.activities.length})</h2>
        <ul className="device-list">
          {register.activities.map((activity) => (
            <li key={activity.id} className="device-row">
              <div>
                <strong>{activity.name}</strong>{" "}
                <span className="muted">
                  {BASIS_LABELS[activity.legalBasis] ?? activity.legalBasis}
                  {activity.sensitiveData && " · données sensibles (art. 9)"}
                </span>
                <br />
                <span className="muted">{activity.purpose}</span>
                <br />
                <span className="muted">
                  Données : {activity.dataCategories.join(", ")} · Personnes :{" "}
                  {activity.dataSubjects.join(", ")} · Conservation : {activity.retention}
                </span>
              </div>
              <button onClick={() => void remove(activity.id)}>Supprimer</button>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h3>Ajouter depuis les modèles CNIL</h3>
        <ul className="device-list">
          {register.templates.map((template) => (
            <li key={template.id} className="device-row">
              <div>
                <strong>{template.name}</strong>{" "}
                <span className="muted">
                  {BASIS_LABELS[template.legalBasis] ?? template.legalBasis} ·{" "}
                  {template.retention}
                </span>
                <br />
                <a href={template.source.url} target="_blank" rel="noreferrer">
                  {template.source.label}
                </a>
              </div>
              {inRegister.has(template.id) ? (
                <span className="muted">déjà ajouté</span>
              ) : (
                <button className="primary" onClick={() => void addTemplate(template.id)}>
                  Ajouter
                </button>
              )}
            </li>
          ))}
        </ul>
        {error && <p className="warn">{error}</p>}
      </section>
    </div>
  );
}
