"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, decidePendingAction, listPendingActions } from "../../lib/api";
import type { PendingActionSummary } from "../../lib/api";

/*
 * File de validation 1-clic (CLAUDE.md rule #4, UI side). The agent PREPARES;
 * only a human decides here. Approve = the single execution point (idempotent
 * server-side: a double click gets a 409, never a double send). The list is
 * metadata-only — payload details stay on the owner-gated API endpoint.
 */

export default function ValidationPage() {
  const [actions, setActions] = useState<PendingActionSummary[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listPendingActions()
      .then(setActions)
      .catch(() => setNotice("Impossible de charger la file."));
  }, []);

  useEffect(refresh, [refresh]);

  async function decide(id: string, decision: "approve" | "reject"): Promise<void> {
    setBusyId(id);
    setNotice(null);
    try {
      const outcome = await decidePendingAction(id, decision);
      setNotice(
        decision === "approve"
          ? outcome.status === "executed"
            ? "Action validée et exécutée."
            : "Action validée — l'exécution a échoué, voir le détail."
          : "Action rejetée, rien n'a été exécuté.",
      );
      refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setNotice("Déjà traitée (aucune double exécution).");
        refresh();
      } else if (error instanceof ApiError && error.status === 403) {
        setNotice("Réservé au rôle owner.");
      } else {
        setNotice("Échec de la décision.");
      }
    } finally {
      setBusyId(null);
    }
  }

  const waiting = actions.filter((a) => a.status === "pending");
  const done = actions.filter((a) => a.status !== "pending");

  return (
    <>
      <h1 className="page-title">File de validation</h1>
      <p className="page-sub">
        Les employés virtuels préparent — vous décidez. Une validation exécute l&apos;action une
        seule fois.
      </p>

      {notice && <p className="error-line">{notice}</p>}

      <h2 className="overline" style={{ margin: "24px 0 12px" }}>
        En attente ({waiting.length})
      </h2>
      {waiting.length === 0 ? (
        <p className="empty">Rien à valider.</p>
      ) : (
        <table className="ledger">
          <thead>
            <tr>
              <th>Type</th>
              <th>Préparée le</th>
              <th style={{ width: 220 }}>Décision</th>
            </tr>
          </thead>
          <tbody>
            {waiting.map((action) => (
              <tr key={action.id}>
                <td className="figure">{action.type}</td>
                <td>{new Date(action.createdAt).toLocaleString("fr-FR")}</td>
                <td>
                  <button
                    className="primary"
                    disabled={busyId === action.id}
                    onClick={() => void decide(action.id, "approve")}
                  >
                    Valider
                  </button>{" "}
                  <button
                    className="danger"
                    disabled={busyId === action.id}
                    onClick={() => void decide(action.id, "reject")}
                  >
                    Rejeter
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="overline" style={{ margin: "34px 0 12px" }}>
        Historique
      </h2>
      {done.length === 0 ? (
        <p className="empty">Aucune décision passée.</p>
      ) : (
        <table className="ledger">
          <thead>
            <tr>
              <th>Type</th>
              <th>Statut</th>
              <th>Décidée le</th>
            </tr>
          </thead>
          <tbody>
            {done.map((action) => (
              <tr key={action.id}>
                <td className="figure">{action.type}</td>
                <td>
                  <span className={`badge ${action.status}`}>{action.status}</span>
                </td>
                <td>
                  {action.validatedAt ? new Date(action.validatedAt).toLocaleString("fr-FR") : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
