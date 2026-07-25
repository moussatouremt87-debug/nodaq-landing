import { z } from "zod";

/*
 * Agent stream events (mirror of apps/agent-runtime AgentEvent) — validated
 * at the boundary before touching React state. Tool events carry NAMES only;
 * anything not matching the union is discarded.
 */

export const AgentStreamEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("conversation"), conversationId: z.string() }),
  z.object({ type: z.literal("tool_call"), name: z.string() }),
  z.object({ type: z.literal("tool_result"), name: z.string(), ok: z.boolean() }),
  z.object({ type: z.literal("assistant"), content: z.string() }),
  z.object({ type: z.literal("done"), iterations: z.number() }),
  z.object({ type: z.literal("error"), name: z.string() }),
]);
export type AgentStreamEvent = z.infer<typeof AgentStreamEvent>;

/** Parses an unknown SSE payload into a typed event, or null if foreign. */
export function toAgentEvent(raw: unknown): AgentStreamEvent | null {
  const parsed = AgentStreamEvent.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
