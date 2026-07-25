"use client";

import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { toAgentEvent } from "../../lib/events";
import { readSseEvents } from "../../lib/sse";

/*
 * Chat with the Compta virtual employee — SSE streaming over the same-origin
 * proxy. The stream only ever carries the assistant text and tool NAMES; a
 * conversationId event lets the next turn resume the same conversation.
 */

type ChatLine =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; text: string };

const SUGGESTIONS = [
  "Prépare les relances des factures en retard",
  "Où en est ma trésorerie à 60 jours ?",
  "Quelles actions attendent ma validation ?",
];

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

  async function send(event: FormEvent): Promise<void> {
    event.preventDefault();
    const message = input.trim();
    if (!message || streaming) return;
    setInput("");
    push({ kind: "user", text: message });
    setStreaming(true);
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
          case "tool_result":
            push({
              kind: "tool",
              text: `${agentEvent.ok ? "✓" : "✗"} ${agentEvent.name}`,
            });
            break;
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
    } finally {
      setStreaming(false);
    }
  }

  return (
    <>
      <h1 className="page-title">Employé Compta</h1>
      <p className="page-sub">
        Il lit vos factures et votre trésorerie, prépare les actions — et n&apos;exécute jamais
        sans vous.
      </p>
      <div className="chat">
        <div className="chat-log" ref={logRef}>
          {lines.length === 0 && (
            <div className="empty">
              Par exemple :
              {SUGGESTIONS.map((suggestion) => (
                <div key={suggestion}>
                  <button
                    type="button"
                    style={{ marginTop: 8 }}
                    onClick={() => setInput(suggestion)}
                  >
                    {suggestion}
                  </button>
                </div>
              ))}
            </div>
          )}
          {lines.map((line, index) => (
            <div key={index} className={`msg ${line.kind}`}>
              {line.text}
            </div>
          ))}
          {streaming && <div className="msg tool">l&apos;employé travaille…</div>}
        </div>
        <form className="chat-input" onSubmit={(e) => void send(e)}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Votre demande…"
            aria-label="Message à l'employé Compta"
          />
          <button className="primary" type="submit" disabled={streaming || !input.trim()}>
            Envoyer
          </button>
        </form>
      </div>
    </>
  );
}
