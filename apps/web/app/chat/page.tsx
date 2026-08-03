"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { formatEuroCents, getPendingAction, listPendingActions } from "../../lib/api";
import { toAgentEvent } from "../../lib/events";
import { emitDomainEvent, eventForTool } from "../../lib/freshness";
import { readSseEvents } from "../../lib/sse";

/*
 * Chat with the Compta virtual employee (UI v2, maquette Figma) — SSE
 * streaming over the same-origin proxy. The stream only ever carries the
 * assistant text and tool NAMES. After each answer, the queue is re-listed:
 * actions the agent just PREPARED show up as a structured card (count, total,
 * lines) with a CTA to the validation queue — nothing is ever sent from here.
 */

type Dict = Record<string, unknown>;
const asDict = (value: unknown): Dict | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : null;
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const asNumber = (value: unknown): number | null => (typeof value === "number" ? value : null);

interface PreparedLine {
  label: string;
  amountCents: number | null;
}

type ChatLine =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; text: string }
  | { kind: "card"; count: number; totalCents: number; lines: PreparedLine[] };

const SUGGESTIONS = [
  "Prépare les relances des factures en retard",
  "Où en est ma trésorerie à 60 jours ?",
  "Quelle est ma marge ce mois ?",
];

const GREETING =
  "Bonjour. Je suis votre employé Compta. Je peux consulter vos factures Pennylane, vos " +
  "mouvements Qonto et vos documents pour préparer relances, devis et écritures — que vous " +
  "validez ensuite. Que puis-je préparer ?";

export default function ChatPage() {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const conversationRef = useRef<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  function push(line: ChatLine): void {
    setLines((prev) => [...prev, line]);
    queueMicrotask(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }));
  }

  /** Actions en attente AVANT l'envoi — pour détecter celles que l'agent dépose. */
  async function pendingIds(): Promise<Set<string>> {
    try {
      const actions = await listPendingActions();
      return new Set(actions.filter((a) => a.status === "pending").map((a) => a.id));
    } catch {
      return new Set();
    }
  }

  async function showPreparedCard(before: Set<string>): Promise<void> {
    try {
      const after = await listPendingActions();
      const fresh = after.filter((a) => a.status === "pending" && !before.has(a.id));
      if (fresh.length === 0) return;
      // Détails owner-gated (libellé + montant) ; un 403 laisse la carte
      // en version compteur seulement.
      const results = await Promise.allSettled(fresh.slice(0, 5).map((a) => getPendingAction(a.id)));
      const cardLines: PreparedLine[] = [];
      let total = 0;
      for (const [index, result] of results.entries()) {
        if (result.status !== "fulfilled") {
          cardLines.push({ label: fresh[index]?.type ?? "action", amountCents: null });
          continue;
        }
        const payload = asDict(result.value.payload);
        const invoice = asDict(payload?.invoice);
        const quote = asDict(payload?.quote);
        const label =
          asString(invoice?.customer) ??
          asString(quote?.customer) ??
          asString(invoice?.number) ??
          asString(quote?.number) ??
          result.value.type;
        const amount = asNumber(invoice?.amountCents) ?? asNumber(quote?.amountCents);
        if (amount !== null) total += amount;
        cardLines.push({ label, amountCents: amount });
      }
      push({ kind: "card", count: fresh.length, totalCents: total, lines: cardLines });
    } catch {
      /* jamais bloquant pour la conversation */
    }
  }

  async function send(event: FormEvent): Promise<void> {
    event.preventDefault();
    const message = input.trim();
    if (!message || streaming) return;
    setInput("");
    push({ kind: "user", text: message });
    setStreaming(true);
    const before = await pendingIds();
    try {
      const response = await fetch("/backend/employees/compta/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message,
          ...(conversationRef.current ? { conversationId: conversationRef.current } : {}),
        }),
      });
      if (!response.ok || !response.body) {
        push({ kind: "assistant", text: "L'employé Compta est indisponible pour le moment." });
        return;
      }
      for await (const raw of readSseEvents(response.body)) {
        const agentEvent = toAgentEvent(raw);
        if (!agentEvent) continue;
        switch (agentEvent.type) {
          case "conversation":
            conversationRef.current = agentEvent.conversationId;
            break;
          case "tool_call":
            push({ kind: "tool", text: `⚙ ${agentEvent.name}…` });
            break;
          case "tool_result": {
            push({ kind: "tool", text: `${agentEvent.ok ? "✓" : "✗"} ${agentEvent.name}` });
            // L'agent vient d'écrire pendant qu'on le regarde : les écrans
            // concernés se périment MAINTENANT, sans attendre une navigation.
            // Le flux ne transporte qu'un NOM d'outil (minimisation 2.17) —
            // c'est assez pour savoir quoi rafraîchir.
            const domainEvent = agentEvent.ok ? eventForTool(agentEvent.name) : null;
            if (domainEvent) emitDomainEvent(domainEvent);
            break;
          }
          case "assistant":
            push({ kind: "assistant", text: agentEvent.content });
            break;
          case "error":
            push({ kind: "assistant", text: "Une erreur est survenue côté agent." });
            break;
          case "done":
            break;
        }
      }
      await showPreparedCard(before);
    } finally {
      setStreaming(false);
    }
  }

  return (
    <div className="chat">
      <div className="chat-header">
        <span className="avatar" aria-hidden>
          C
        </span>
        <div className="who">
          <div className="name">Employé Compta / Direction</div>
          <div className="access">
            Accès : documents, Pennylane, Qonto · mémoire scellée à votre organisation
          </div>
        </div>
        <span className="tag-souverain">Souverain · Mistral EU</span>
      </div>
      <div className="chat-log" ref={logRef}>
        <div className="msg-row">
          <span className="avatar" aria-hidden>
            C
          </span>
          <div className="msg assistant">{GREETING}</div>
        </div>
        {lines.length === 0 && (
          <div className="suggestions">
            {SUGGESTIONS.map((suggestion) => (
              <button key={suggestion} type="button" onClick={() => setInput(suggestion)}>
                {suggestion}
              </button>
            ))}
          </div>
        )}
        {lines.map((line, index) => {
          if (line.kind === "user") {
            return (
              <div key={index} className="msg user">
                {line.text}
              </div>
            );
          }
          if (line.kind === "assistant") {
            return (
              <div key={index} className="msg-row">
                <span className="avatar" aria-hidden>
                  C
                </span>
                <div className="msg assistant">{line.text}</div>
              </div>
            );
          }
          if (line.kind === "tool") {
            return (
              <div key={index} className="msg tool">
                {line.text}
              </div>
            );
          }
          return (
            <div key={index} className="prepared-card">
              <div className="ph">
                <span>
                  {line.count} action{line.count > 1 ? "s" : ""} préparée
                  {line.count > 1 ? "s" : ""}
                </span>
                {line.totalCents > 0 && (
                  <span className="total">{formatEuroCents(line.totalCents)}</span>
                )}
              </div>
              {line.lines.map((item, i) => (
                <div key={i} className="li">
                  <span className="dot" aria-hidden />
                  <span>{item.label}</span>
                  {item.amountCents !== null && (
                    <span className="amount">{formatEuroCents(item.amountCents)}</span>
                  )}
                </div>
              ))}
              <Link href="/validation" className="btn primary">
                Ouvrir la file de validation →
              </Link>
            </div>
          );
        })}
        {streaming && <div className="msg tool">l&apos;employé travaille…</div>}
      </div>
      <form className="chat-input" onSubmit={(e) => void send(e)}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Écrivez à votre employé Compta… (ex. « quelle est ma marge ce mois ? »)"
          aria-label="Message à l'employé Compta"
        />
        <button className="primary" type="submit" disabled={streaming || !input.trim()}>
          Envoyer
        </button>
      </form>
    </div>
  );
}
