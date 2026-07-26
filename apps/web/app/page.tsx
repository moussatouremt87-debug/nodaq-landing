"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatEuroCents, getKpis, listConnectors, listPendingActions } from "../lib/api";
import type { CockpitKpis, PendingActionSummary } from "../lib/api";

/*
 * Cockpit v0 (ticket 1.7) — the owner's ledger view: treasury projection
 * (30/60/90 d), validation queue pressure, agent activity. Metadata only:
 * payloads stay behind the owner-gated detail endpoint.
 */

export default function CockpitPage() {
  const [kpis, setKpis] = useState<CockpitKpis | null>(null);
  const [recent, setRecent] = useState<PendingActionSummary[]>([]);
  const [connectorCount, setConnectorCount] = useState<number | null>(null);
  const [demoMode, setDemoMode] = useState(false);

  useEffect(() => {
    getKpis().then(setKpis).catch(() => undefined);
    listPendingActions()
      .then((actions) => setRecent(actions.slice(0, 5)))
      .catch(() => undefined);
    listConnectors()
      .then((connectors) => {
        setConnectorCount(connectors.length);
        // Tenant de démonstration (seed démo) : signalé discrètement, jamais
        // présenté comme une vraie connexion.
        setDemoMode(connectors.some((connector) => connector.status === "demo"));
      })
      .catch(() => undefined);
  }, []);

  const pending = kpis?.pendingActions.pending ?? 0;
  const executed = kpis?.pendingActions.executed ?? 0;

  return (
    <>
      <h1 className="page-title">Cockpit</h1>
      <p className="page-sub">La journée de vos employés virtuels, en un coup d&apos;œil.</p>
      {demoMode && (
        <p className="hint" style={{ marginTop: -12, marginBottom: 20 }}>
          Mode démo — données fictives (aucune connexion bancaire réelle).
        </p>
      )}

      {connectorCount === 0 && (
        <div className="card signal" style={{ marginBottom: 24 }}>
          <span className="overline">Bienvenue — dernière étape</span>
          <p className="hint" style={{ margin: "6px 0 10px" }}>
            Aucun outil connecté : reliez Qonto et Pennylane pour que l&apos;employé Compta voie
            votre trésorerie et vos factures.
          </p>
          <Link href="/connecteurs" className="btn">
            → Connecter mes outils
          </Link>
        </div>
      )}

      <div className="kpi-grid">
        <div className={pending > 0 ? "card signal" : "card"}>
          <span className="overline">À valider</span>
          <div className="big">{pending}</div>
          <div className="hint">
            {pending > 0 ? (
              <Link href="/validation">→ ouvrir la file de validation</Link>
            ) : (
              "Aucune action en attente."
            )}
          </div>
        </div>
        <div className="card">
          <span className="overline">Actions exécutées</span>
          <div className="big">{executed}</div>
          <div className="hint">Après votre validation, jamais avant.</div>
        </div>
        <div className="card accent">
          <span className="overline">Conversations agent</span>
          <div className="big">{kpis?.conversations ?? 0}</div>
          <div className="hint">
            <Link href="/chat">→ parler à l&apos;employé Compta</Link>
          </div>
        </div>
      </div>

      <h2 className="overline" style={{ marginBottom: 12 }}>
        Trésorerie — projection
      </h2>
      {kpis?.treasury ? (
        <div className="card accent" style={{ marginBottom: 40 }}>
          <span className="overline">Compte {kpis.treasury.account}</span>
          <div className="big">{formatEuroCents(kpis.treasury.currentBalanceCents)}</div>
          <div className="spark">
            {kpis.treasury.points.map((point) => (
              <div key={point.horizonDays}>
                <span className="overline">J+{point.horizonDays}</span>
                {formatEuroCents(point.projectedBalanceCents)}
              </div>
            ))}
          </div>
          <div className="hint">
            Flux net moyen {formatEuroCents(kpis.treasury.avgDailyNetFlowCents)}/j, observé sur{" "}
            {kpis.treasury.observedDays} j.
          </div>
        </div>
      ) : (
        <p className="empty" style={{ marginBottom: 40 }}>
          Projection indisponible — connectez Qonto (ou vous n&apos;êtes pas owner de
          l&apos;organisation).
        </p>
      )}

      <h2 className="overline" style={{ marginBottom: 12 }}>
        Dernières actions préparées
      </h2>
      {recent.length === 0 ? (
        <p className="empty">Rien pour l&apos;instant — demandez une relance à l&apos;employé Compta.</p>
      ) : (
        <table className="ledger">
          <thead>
            <tr>
              <th>Type</th>
              <th>Statut</th>
              <th>Préparée le</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((action) => (
              <tr key={action.id}>
                <td className="figure">{action.type}</td>
                <td>
                  <span className={`badge ${action.status}`}>{action.status}</span>
                </td>
                <td>{new Date(action.createdAt).toLocaleString("fr-FR")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
