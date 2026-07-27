"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  decidePendingAction,
  formatEuroCents,
  getPendingAction,
  listPendingActions,
  updatePendingActionDraft,
} from "../../lib/api";
import type { PendingActionDetail, PendingActionSummary } from "../../lib/api";
import { actionStatusLabel, actionTypeLabel } from "../../lib/labels";

/*
 * File de validation 1-clic (CLAUDE.md rule #4, UI side). The agent PREPARES;
 * only a human decides here. Approve = the single execution point (idempotent
 * server-side: a double click gets a 409, never a double send). The list is
 * metadata-only; opening a row fetches the owner-gated detail so the human
 * can READ the draft — and rework it — before deciding.
 */

type Dict = Record<string, unknown>;
const asDict = (value: unknown): Dict | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : null;
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const asNumber = (value: unknown): number | null => (typeof value === "number" ? value : null);

/** Facts the agent grounded the action on — read-only, never editable. */
function ActionFacts({ payload }: { payload: Dict }) {
  const invoice = asDict(payload.invoice);
  const risk = asDict(payload.risk);
  const quote = asDict(payload.quote);
  const reconciliation = asDict(payload.reconciliation);
  const rows: [string, string][] = [];

  if (invoice) {
    const number = asString(invoice.number) ?? asString(invoice.id);
    if (number) rows.push(["Facture", number]);
    const customer = asString(invoice.customer);
    if (customer) rows.push(["Client", customer]);
    const label = asString(invoice.label);
    if (label) rows.push(["Objet", label]);
    const amount = asNumber(invoice.amountCents);
    if (amount !== null) rows.push(["Montant", formatEuroCents(amount)]);
    const daysOverdue = asNumber(risk?.daysOverdue);
    if (daysOverdue !== null) rows.push(["Retard", `${daysOverdue} jours`]);
  }
  if (quote) {
    const number = asString(quote.number);
    if (number) rows.push(["Devis", number]);
    const customer = asString(quote.customer);
    if (customer) rows.push(["Client", customer]);
    const label = asString(quote.label);
    if (label) rows.push(["Objet", label]);
    const amount = asNumber(quote.amountCents);
    if (amount !== null) rows.push(["Montant", formatEuroCents(amount)]);
  }
  if (reconciliation) {
    const items = Array.isArray(reconciliation.items) ? reconciliation.items : [];
    for (const item of items) {
      const entry = asDict(item);
      const label = asString(entry?.label);
      const amount = asNumber(entry?.amountCents);
      if (label && amount !== null) rows.push([label, formatEuroCents(amount)]);
    }
    const total = asNumber(reconciliation.totalCents);
    if (total !== null) rows.push(["Total", formatEuroCents(total)]);
  }

  if (rows.length === 0) return null;
  return (
    <dl className="facts">
      {rows.map(([term, value], index) => (
        <div key={`${term}-${index}`}>
          <dt className="overline">{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function ValidationPage() {
  const [actions, setActions] = useState<PendingActionSummary[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Detail of the OPEN row (one at a time): fetched payload + draft editor.
  // The ref mirrors openId so a SLOW detail response for a previously opened
  // row can never overwrite the row currently open (confidential drafts must
  // never bleed from one action into another).
  const [openId, setOpenId] = useState<string | null>(null);
  const openIdRef = useRef<string | null>(null);
  const [detail, setDetail] = useState<PendingActionDetail | null>(null);
  const [detailNotice, setDetailNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [savedDraft, setSavedDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(() => {
    listPendingActions()
      .then(setActions)
      .catch(() => setNotice("Impossible de charger la file."));
  }, []);

  useEffect(refresh, [refresh]);

  const closeDetail = useCallback(() => {
    openIdRef.current = null;
    setOpenId(null);
    setDetail(null);
    setDetailNotice(null);
    setDraft("");
    setSavedDraft("");
  }, []);

  async function toggleDetail(id: string): Promise<void> {
    // Closing (or switching away from) a modified, unsaved draft must be a
    // conscious choice — otherwise the correction is silently thrown away
    // and "Valider" would execute the original text.
    if (openId !== null && draft !== savedDraft) {
      const discard = window.confirm(
        "Brouillon modifié non enregistré — fermer et perdre la modification ?",
      );
      if (!discard) return;
    }
    if (openId === id) {
      closeDetail();
      return;
    }
    closeDetail();
    openIdRef.current = id;
    setOpenId(id);
    try {
      const loaded = await getPendingAction(id);
      if (openIdRef.current !== id) return; // stale response: row changed since
      setDetail(loaded);
      const text = asString(asDict(loaded.payload)?.draft) ?? "";
      setDraft(text);
      setSavedDraft(text);
    } catch (error) {
      if (openIdRef.current !== id) return;
      setDetailNotice(
        error instanceof ApiError && error.status === 403
          ? "Détail réservé au rôle owner."
          : "Impossible de charger le détail.",
      );
    }
  }

  async function saveDraft(id: string): Promise<void> {
    setSaving(true);
    setDetailNotice(null);
    try {
      const updated = await updatePendingActionDraft(id, draft);
      setSavedDraft(updated.draft);
      setDraft(updated.draft);
      setDetailNotice("Brouillon enregistré — c'est ce texte qui partira à la validation.");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setDetailNotice("Action déjà décidée — le brouillon n'est plus modifiable.");
        refresh();
      } else if (error instanceof ApiError && error.status === 403) {
        setDetailNotice("Modification réservée au rôle owner.");
      } else {
        setDetailNotice("Échec de l'enregistrement du brouillon.");
      }
    } finally {
      setSaving(false);
    }
  }

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
      closeDetail();
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
  const detailPayload = detail ? asDict(detail.payload) : null;
  const hasDraft = asString(detailPayload?.draft) !== null;
  const dirty = draft !== savedDraft;

  return (
    <>
      <h1 className="page-title">File de validation</h1>
      <p className="page-sub">
        Les employés virtuels préparent — vous décidez. Ouvrez une action pour lire (et corriger)
        le brouillon avant de valider : une validation exécute l&apos;action une seule fois.
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
              <th style={{ width: 300 }}>Décision</th>
            </tr>
          </thead>
          <tbody>
            {waiting.map((action) => (
              <Fragment key={action.id}>
                <tr>
                  <td>{actionTypeLabel(action.type)}</td>
                  <td>{new Date(action.createdAt).toLocaleString("fr-FR")}</td>
                  <td>
                    <button onClick={() => void toggleDetail(action.id)}>
                      {openId === action.id ? "Fermer" : "Voir"}
                    </button>{" "}
                    <button
                      className="primary"
                      disabled={busyId === action.id || (openId === action.id && dirty)}
                      title={
                        openId === action.id && dirty
                          ? "Enregistrez d'abord votre brouillon modifié."
                          : undefined
                      }
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
                {openId === action.id && (
                  <tr>
                    <td colSpan={3}>
                      <div className="card" style={{ margin: "4px 0 12px" }}>
                        {detailNotice && <p className="hint">{detailNotice}</p>}
                        {!detail && !detailNotice && <p className="hint">Chargement…</p>}
                        {detailPayload && (
                          <>
                            <ActionFacts payload={detailPayload} />
                            {hasDraft ? (
                              <label style={{ marginTop: 14 }}>
                                <span className="overline">Brouillon (modifiable)</span>
                                <textarea
                                  value={draft}
                                  rows={8}
                                  onChange={(event) => setDraft(event.target.value)}
                                />
                              </label>
                            ) : (
                              <p className="hint" style={{ marginTop: 10 }}>
                                Pas de brouillon libre pour ce type d&apos;action — les éléments
                                ci-dessus sont exactement ce qui sera exécuté.
                              </p>
                            )}
                            {hasDraft && (
                              <button
                                disabled={!dirty || saving || draft.trim().length === 0}
                                onClick={() => void saveDraft(action.id)}
                              >
                                {saving ? "Enregistrement…" : "Enregistrer le brouillon"}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
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
                <td>{actionTypeLabel(action.type)}</td>
                <td>
                  <span className={`badge ${action.status}`}>{actionStatusLabel(action.status)}</span>
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
