/*
 * Minimal SSE reader for the /employees/compta/chat stream. The agent emits
 * `data: {json}\n\n` frames; frames can be split or coalesced arbitrarily by
 * the network, so parsing is buffer-based and pure (unit-tested).
 */

export interface SseParseResult {
  events: unknown[];
  rest: string;
}

/** Extracts complete `data:` events from buffer+chunk; returns the leftover. */
export function parseSseChunk(buffer: string, chunk: string): SseParseResult {
  const combined = buffer + chunk;
  const frames = combined.split("\n\n");
  const rest = frames.pop() ?? "";
  const events: unknown[] = [];
  for (const frame of frames) {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch {
        // A malformed frame is dropped, never rendered raw.
      }
    }
  }
  return { events, rest };
}

/** Streams parsed SSE events from a fetch() response body. */
export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const { events, rest } = parseSseChunk(buffer, decoder.decode(value, { stream: true }));
      buffer = rest;
      yield* events;
    }
    // Flush a final frame that arrived without its trailing blank line.
    const { events } = parseSseChunk(buffer, "\n\n");
    yield* events;
  } finally {
    reader.releaseLock();
  }
}
