"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  createProspect,
  getProspectionPlan,
  getProspects,
  logProspectInteraction,
  opposeProspect,
  PROSPECT_SOURCES,
  PROSPECT_STAGES,
  updateProspect,
} from "../../lib/api";
import type { Prospect, ProspectionPlan } from "../../lib/api";

/*
 * Prospection (2.12). Deux choses sont visibles à l'écran parce qu'elles ne
 * doivent PAS être des réglages cachés :
 *  - la PROVENANCE est un champ obligatoire du formulaire, pas une option ;
 *  - l'OPPOSITION est un bouton présent sur chaque fiche, et son effet est
 *    annoncé avant d'être déclenché (il n'est pas réversible ici).
 */

const STAGE_LABELS: Record<string, string> = {
  nouveau: "Nouveau",
  contacte: "Contacté",
  qualifie: "Qualifié",
  devis_envoye: "Devis envoyé",
  gagne: "Gagné",
  perdu: "Perdu",
};

const SOURCE_LABELS: Record<string, string> = {
  demande_entrante: "Demande entrante",
  recommandation: "Recommandation",
  salon: "Salon",
  reseau_pro: "Réseau professionnel",
  site_web: "Site web",
  saisie_manuelle: "Saisie manuelle",
};

const KIND_LABELS: Record<string, string> = {
  appel: "Appel",
  email: "E-mail",
  rdv: "Rendez-vous",
  autre: "Autre",
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function ProspectsPage() {
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [plan, setPlan] = useState<ProspectionPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [source, setSource] = useState("");

  const refresh = useCallback(async () => {
    try {
      const list = await getProspects();
      setProspects(list.prospects);
      setTruncated(list.truncated);
      setPlan(await getProspectionPlan().catch(() => null));
    } catch {
      setError("prospection indisponible — réessayez");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function add(): Promise<void> {
    setError(null);
    if (name.trim() === "") {
      setError("le nom est obligatoire");
      return;
    }
    // Provenance EXIGÉE côté écran comme côté API : on refuse d'enregistrer
    // une personne dont on ne saurait pas dire d'où vient sa fiche.
    if (source === "") {
      setError("indiquez d'où vient cette fiche — c'est une obligation, pas un détail");
      return;
    }
    try {
      await createProspect({
        name: name.trim(),
        source,
        ...(company.trim() ? { company: company.trim() } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
      });
      setName("");
      setCompany("");
      setEmail("");
      setSource("");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "enregistrement impossible");
    }
  }

  async function oppose(prospect: Prospect): Promise<void> {
    const confirmed = window.confirm(
      `Enregistrer l'opposition de ${prospect.name} ?\n\n` +
        "Ses coordonnées et les comptes rendus seront effacés, et elle ne " +
        "réapparaîtra dans aucune liste de relance. Cette action ne peut pas " +
        "être annulée depuis le produit.",
    );
    if (!confirmed) return;
    try {
      await opposeProspect(prospect.id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "opposition impossible");
    }
  }

  async function logContact(prospect: Prospect, kind: string): Promise<void> {
    try {
      await logProspectInteraction(prospect.id, { kind, occurredAt: today() });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "contact non consigné");
    }
  }

  async function moveStage(prospect: Prospect, stage: string): Promise<void> {
    try {
      await updateProspect(prospect.id, { stage });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "étape non modifiée");
    }
  }

  return (
    <div className="page">
      <section className="card">
        <h2>Nouvelle fiche</h2>
        <div className="form-grid">
          <input placeholder="Nom" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            placeholder="Société (optionnel)"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
          />
          <input
            placeholder="E-mail (optionnel)"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <label>
            Provenance :{" "}
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">— obligatoire —</option>
              {PROSPECT_SOURCES.map((value) => (
                <option key={value} value={value}>
                  {SOURCE_LABELS[value] ?? value}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" onClick={() => void add()}>
            Enregistrer
          </button>
        </div>
        <p className="muted">
          La provenance est obligatoire : sans elle, impossible de dire à la personne d&apos;où
          vient sa fiche si elle le demande. Les fichiers de prospection achetés ne sont pas pris
          en charge.
        </p>
        {error && <p className="warn">{error}</p>}
      </section>

      {plan && (
        <section className="card">
          <h2>À relancer</h2>
          {plan.followups.length === 0 ? (
            <p className="muted">Aucune relance au-delà des délais.</p>
          ) : (
            <ul className="device-list">
              {plan.followups.map((followup) => (
                <li key={followup.id} className="device-row">
                  <div>
                    <strong>{followup.name}</strong>{" "}
                    <span className="muted">
                      {followup.company ? `${followup.company} · ` : ""}
                      {STAGE_LABELS[followup.stage] ?? followup.stage}
                    </span>
                    <br />
                    <span className="muted">{followup.reason}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="muted">
            Pipeline :{" "}
            {PROSPECT_STAGES.map(
              (stage) => `${STAGE_LABELS[stage] ?? stage} ${plan.pipeline[stage] ?? 0}`,
            ).join(" · ")}
            {plan.optedOutCount > 0 &&
              ` — ${plan.optedOutCount} personne(s) opposée(s) à la prospection, exclue(s) de toute liste.`}
          </p>
          {plan.retentionAlerts.length > 0 && (
            <p className="warn">
              {plan.retentionAlerts.length} fiche(s) sans contact depuis plus de 36 mois : à
              supprimer, la durée de conservation recommandée est dépassée.
              {plan.expiredOptedOutCount > 0 &&
                ` S'y ajoutent ${plan.expiredOptedOutCount} fiche(s) opposée(s) également périmée(s).`}
            </p>
          )}
          <p className="warn">
            {plan.label} (règles du {plan.rulesVersion})
          </p>
        </section>
      )}

      <section className="card">
        <h2>Fiches ({prospects.length})</h2>
        {truncated && (
          <p className="warn">
            Liste tronquée : seules les 500 fiches les plus récentes sont affichées.
          </p>
        )}
        <ul className="device-list">
          {prospects.map((prospect) => (
            <li key={prospect.id} className="device-row">
              <div>
                <strong>{prospect.name}</strong>{" "}
                <span className="muted">
                  {prospect.company ? `${prospect.company} · ` : ""}
                  {SOURCE_LABELS[prospect.source] ?? prospect.source}
                </span>
                {(prospect.email || prospect.phone || prospect.notes) && (
                  <>
                    <br />
                    <span className="muted">
                      {[prospect.email, prospect.phone, prospect.notes].filter(Boolean).join(" · ")}
                    </span>
                  </>
                )}
                {prospect.optedOut ? (
                  <>
                    <br />
                    <span className="warn">
                      Opposée à la prospection — conservée uniquement pour ne plus la recontacter.
                    </span>
                  </>
                ) : (
                  <>
                    <br />
                    <select
                      value={prospect.stage}
                      onChange={(e) => void moveStage(prospect, e.target.value)}
                    >
                      {PROSPECT_STAGES.map((stage) => (
                        <option key={stage} value={stage}>
                          {STAGE_LABELS[stage] ?? stage}
                        </option>
                      ))}
                    </select>{" "}
                    {Object.entries(KIND_LABELS).map(([kind, label]) => (
                      <button key={kind} onClick={() => void logContact(prospect, kind)}>
                        + {label}
                      </button>
                    ))}{" "}
                    <button onClick={() => void oppose(prospect)}>Ne plus contacter</button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
