import { describe, expect, it } from "vitest";
import { parseSseChunk, readSseEvents } from "../lib/sse";
import { toAgentEvent } from "../lib/events";

describe("parseSseChunk", () => {
  it("parses complete frames and keeps the incomplete tail", () => {
    const { events, rest } = parseSseChunk(
      "",
      'data: {"type":"tool_call","name":"rag_search"}\n\ndata: {"type":"assist',
    );
    expect(events).toEqual([{ type: "tool_call", name: "rag_search" }]);
    expect(rest).toBe('data: {"type":"assist');
  });

  it("reassembles an event split across chunks", () => {
    const first = parseSseChunk("", 'data: {"type":"assistant","con');
    expect(first.events).toEqual([]);
    const second = parseSseChunk(first.rest, 'tent":"Bonjour"}\n\n');
    expect(second.events).toEqual([{ type: "assistant", content: "Bonjour" }]);
    expect(second.rest).toBe("");
  });

  it("drops malformed frames instead of rendering them raw", () => {
    const { events } = parseSseChunk("", "data: {not-json}\n\ndata: {\"type\":\"done\",\"iterations\":2}\n\n");
    expect(events).toEqual([{ type: "done", iterations: 2 }]);
  });

  it("handles several events in one chunk", () => {
    const { events } = parseSseChunk(
      "",
      'data: {"type":"tool_call","name":"a"}\n\ndata: {"type":"tool_result","name":"a","ok":true}\n\n',
    );
    expect(events).toHaveLength(2);
  });
});

describe("readSseEvents", () => {
  it("streams events from a chunked body, including a final unterminated frame", async () => {
    const chunks = [
      'data: {"type":"tool_call","na',
      'me":"draft_dunning"}\n\ndata: {"type":"done","iterations":3}',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const events: unknown[] = [];
    for await (const event of readSseEvents(body)) events.push(event);
    expect(events).toEqual([
      { type: "tool_call", name: "draft_dunning" },
      { type: "done", iterations: 3 },
    ]);
  });
});

describe("toAgentEvent", () => {
  it("accepts the known union and rejects foreign payloads", () => {
    expect(toAgentEvent({ type: "assistant", content: "ok" })).toEqual({
      type: "assistant",
      content: "ok",
    });
    expect(toAgentEvent({ type: "assistant" })).toBeNull();
    expect(toAgentEvent({ type: "surprise", data: "x" })).toBeNull();
    expect(toAgentEvent("data")).toBeNull();
  });
});
