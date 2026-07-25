import type { ModelGroup } from "@nodaq/shared";

/**
 * Minimal OpenAI-compatible client for the LiteLLM proxy. Plain fetch on
 * purpose: NEVER a provider SDK (CLAUDE.md rule #1 + ESLint barrier).
 * Config is read at CALL time so tests can point at a fake server.
 */
function config(): { baseUrl: string; masterKey: string } {
  const baseUrl = process.env.LITELLM_BASE_URL;
  const masterKey = process.env.LITELLM_MASTER_KEY;
  // Fail fast in production: silently calling with dev defaults would be a
  // fail-open (audit finding 1.1). Dev defaults match the ops/ compose stack.
  if (process.env.NODE_ENV === "production" && (!baseUrl || !masterKey)) {
    throw new Error(
      "LITELLM_BASE_URL and LITELLM_MASTER_KEY must be provided in production (Secret Manager)",
    );
  }
  return {
    baseUrl: baseUrl ?? "http://localhost:4000",
    masterKey: masterKey ?? "sk-local-master",
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** OpenAI-compatible tool definition (function calling). */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the tool input. */
  parameters: Record<string, unknown>;
}

/** One tool invocation requested by the assistant. */
export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string as returned by the model — parse and validate downstream. */
  argumentsJson: string;
}

export interface AssistantTurn {
  content: string | null;
  toolCalls: ToolCall[];
}

/** Message including tool results, for the agent loop. */
export type LoopMessage =
  | ChatMessage
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

/**
 * Full chat-completions call with tool support. Same transport rules as
 * chatCompletion: plain fetch, status-only errors.
 */
export async function chatCompletionWithTools(
  group: ModelGroup,
  messages: LoopMessage[],
  tools: ToolDefinition[],
): Promise<AssistantTurn> {
  const { baseUrl, masterKey } = config();
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${masterKey}`,
    },
    body: JSON.stringify({
      model: group,
      messages,
      ...(tools.length > 0
        ? {
            tools: tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }
        : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`LiteLLM chat/completions failed for group "${group}": HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    choices?: {
      message?: {
        content?: string | null;
        tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
      };
    }[];
  };
  const message = body.choices?.[0]?.message;
  if (!message) {
    throw new Error(`LiteLLM returned no message for group "${group}"`);
  }
  return {
    content: message.content ?? null,
    toolCalls: (message.tool_calls ?? []).map((call, index) => ({
      id: call.id ?? `call_${index}`,
      name: call.function?.name ?? "",
      argumentsJson: call.function?.arguments ?? "{}",
    })),
  };
}

/** Calls a LiteLLM model group. Errors carry status codes only, never payloads. */
export async function chatCompletion(group: ModelGroup, messages: ChatMessage[]): Promise<string> {
  const { baseUrl, masterKey } = config();
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${masterKey}`,
    },
    body: JSON.stringify({ model: group, messages }),
  });
  if (!response.ok) {
    throw new Error(`LiteLLM chat/completions failed for group "${group}": HTTP ${response.status}`);
  }
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(`LiteLLM returned no content for group "${group}"`);
  }
  return content;
}

/** Embeddings are ALWAYS sovereign (they encode customer data). */
export async function embeddings(texts: string[]): Promise<number[][]> {
  const { baseUrl, masterKey } = config();
  const response = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${masterKey}`,
    },
    body: JSON.stringify({ model: "embeddings", input: texts }),
  });
  if (!response.ok) {
    throw new Error(`LiteLLM embeddings failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { data?: { embedding?: number[] }[] };
  const vectors = body.data?.map((d) => d.embedding);
  if (!vectors || vectors.some((v) => !Array.isArray(v))) {
    throw new Error("LiteLLM returned malformed embeddings");
  }
  return vectors as number[][];
}
