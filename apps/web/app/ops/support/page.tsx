"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  getSupportTicket,
  getSupportTicketBody,
  listSupportIssues,
  listSupportTickets,
  resolveSupportTicket,
  sendSupportReply,
  updateSupportDraft,
  validateSupportIssue,
} from "../../../lib/api";
import type { SupportIssue, SupportTicket, SupportTicketDetail } from "../../../lib/api";

/*
 * Back-office support (2.18) — OPÉRATEUR uniquement (l'API répond 404 aux
 * autres : la page affiche alors « accès réservé »). Boucle : ticket trié ->
 * brouillon relu/édité -> envoi 1 clic -> résolution -> entrée de recueil
 * (anonymisée, la garde serveur refuse sinon) -> validation du recueil.
 */

const STATUS_LABELS: Record<string, string> = {
  NOUVEAU: "Nouveau",
  TRIE: "Trié",
  BROUILLON_PRET: "Brouillon prêt",
  REPONDU: "Répondu",
  RESOLU: "Résolu",
  SPAM: "Spam",
};

export default function OpsSupportPage() {
  const [forbidden, setForbidden] = useState(false);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [issues, setIssues] = useState<SupportIssue[]>([]);
  const [selected, setSelected] = useState<SupportTicketDetail | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [issueForm, setIssueForm] = useState({ title: "", symptoms: "", resolution: "" });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [ticketList, issueList] = await Promise.all([
        listSupportTickets(),
        listSupportIssues(),
      ]);
      setTickets(ticketList);
      setIssues(issueList);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) setForbidden(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function open(ticket: SupportTicket): Promise<void> {
    setNote(null);
    const detail = await getSupportTicket(ticket.id);
    setSelected(detail);
    setDraft(detail.draftReply ?? "");
    setBody(null);
    try {
      setBody(await getSupportTicketBody(ticket.id));
    } catch {
      setBody("(corps indisponible — stockage non configuré)");
    }
  }

  async function saveAndSend(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setNote(null);
    try {
      await updateSupportDraft(selected.id, draft);
      await sendSupportReply(selected.id);
      setNote("Réponse envoyée.");
      setSelected(null);
      await refresh();
    } catch (error) {
      setNote(error instanceof ApiError ? error.message : "envoi impossible");
    } finally {
      setBusy(false);
    }
  }

  async function resolve(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setNote(null);
    try {
      const withIssue = issueForm.title.trim().length > 0;
      await resolveSupportTicket(
        selected.id,
        withIssue
          ? {
              issue: {
                title: issueForm.title,
                symptoms: issueForm.symptoms || issueForm.title,
                resolution: issueForm.resolution,
                origin: selected.origin ?? "USAGE",
              },
            }
          : {},
      );
      setNote(withIssue ? "Résolu — entrée de recueil proposée (à valider)." : "Résolu.");
      setSelected(null);
      setIssueForm({ title: "", symptoms: "", resolution: "" });
      await refresh();
    } catch (error) {
      setNote(error instanceof ApiError ? error.message : "résolution impossible");
    } finally {
      setBusy(false);
    }
  }

  if (forbidden) {
    return (
      <div className="page">
        <section className="card">
          <h2>Support</h2>
          <p className="muted">Accès réservé à l&apos;opérateur de la plateforme.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="page">
      <section className="card">
        <h2>Tickets</h2>
        {note && <p className="muted">{note}</p>}
        {tickets.length === 0 ? (
          <p className="muted">Aucun ticket — la boîte support est vide.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Reçu</th>
                <th>De</th>
                <th>Sujet</th>
                <th>Origine</th>
                <th>Niveau</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((ticket) => (
                <tr
                  key={ticket.id}
                  onClick={() => void open(ticket)}
                  style={{ cursor: "pointer" }}
                  className={selected?.id === ticket.id ? "selected" : undefined}
                >
                  <td>{new Date(ticket.createdAt).toLocaleString("fr-FR")}</td>
                  <td>{ticket.fromEmail}</td>
                  <td>{ticket.subject || "(sans sujet)"}</td>
                  <td>{ticket.origin ?? "—"}</td>
                  <td>{ticket.level ?? "—"}</td>
                  <td>{STATUS_LABELS[ticket.status] ?? ticket.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selected && (
        <section className="card">
          <h3>
            {selected.subject || "(sans sujet)"} — {selected.fromEmail}
          </h3>
          <h4>Message original</h4>
          <pre className="mail-body">{body ?? "chargement…"}</pre>
          {selected.agentReport != null && (
            <>
              <h4>Rapport de l&apos;agent</h4>
              <pre className="mail-body">{JSON.stringify(selected.agentReport, null, 2)}</pre>
            </>
          )}
          <h4>Brouillon de réponse (rien ne part sans votre validation)</h4>
          <textarea
            rows={10}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            style={{ width: "100%" }}
          />
          <div className="actions-row">
            <button
              className="primary"
              disabled={busy || draft.trim().length === 0 || selected.status === "REPONDU"}
              onClick={() => void saveAndSend()}
            >
              {busy ? "Envoi…" : "Valider et envoyer"}
            </button>
          </div>
          <h4>Résoudre (+ entrée de recueil, anonymisée — sans nom ni adresse)</h4>
          <input
            placeholder="Titre canonique du problème (vide = résoudre sans recueil)"
            value={issueForm.title}
            onChange={(event) => setIssueForm({ ...issueForm, title: event.target.value })}
            style={{ width: "100%" }}
          />
          <textarea
            rows={2}
            placeholder="Symptômes (génériques)"
            value={issueForm.symptoms}
            onChange={(event) => setIssueForm({ ...issueForm, symptoms: event.target.value })}
            style={{ width: "100%" }}
          />
          <textarea
            rows={2}
            placeholder="Résolution canonique"
            value={issueForm.resolution}
            onChange={(event) => setIssueForm({ ...issueForm, resolution: event.target.value })}
            style={{ width: "100%" }}
          />
          <div className="actions-row">
            <button disabled={busy} onClick={() => void resolve()}>
              Marquer résolu
            </button>
          </div>
        </section>
      )}

      <section className="card">
        <h3>Recueil des problèmes ({issues.filter((issue) => issue.validated).length} validés)</h3>
        {issues.length === 0 ? (
          <p className="muted">Le recueil se construit à chaque résolution.</p>
        ) : (
          <ul className="device-list">
            {issues.map((issue) => (
              <li key={issue.id} className="device-row">
                <div>
                  <strong>{issue.title}</strong>{" "}
                  <span className="muted">
                    ({issue.origin} — {issue.occurrences} occurrence{issue.occurrences > 1 ? "s" : ""})
                  </span>
                  <div className="muted">{issue.resolution || issue.symptoms}</div>
                </div>
                {issue.validated ? (
                  <span className="muted">validée</span>
                ) : (
                  <button
                    onClick={() =>
                      void validateSupportIssue(issue.id).then(() => refresh())
                    }
                  >
                    Valider
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
