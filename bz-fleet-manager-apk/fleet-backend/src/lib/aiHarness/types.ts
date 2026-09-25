// aiHarness/types.ts (Qwen Harness v0.1, Task 3): the shapes every part of
// the harness (adapter, loop, persistence) agrees on for "a chat turn" and
// "a model backing it", independent of any one provider's wire format.
// ollamaAdapter.ts is the only file that knows Ollama's actual request/
// response JSON; everything else here and downstream speaks these types.

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** One turn in the conversation. `thinking` and `toolCalls` only ever appear
 *  on an assistant turn; `toolName` is set on a `tool`-role message so the
 *  model can tell which of its own calls a given result answers when more
 *  than one was made in the same turn. */
export interface ChatMessage {
  role: Role;
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  toolName?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Everything one `ModelAdapter.chat` call needs, in provider-neutral form.
 *  `keepAlive` and `numCtx` are Ollama concepts by name — kept here anyway
 *  since there is exactly one adapter today and no evidence yet of what a
 *  second provider would call them instead. */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  think: boolean;
  temperature: number;
  numCtx: number;
  keepAlive: string;
}

/** Token/latency accounting for one call. Each field is independently `null`
 *  when the provider's response did not carry it — never a guessed `0`, which
 *  would read as "this call used no tokens" instead of "unknown". */
export interface ChatStats {
  promptTokens: number | null;
  completionTokens: number | null;
  totalDurationMs: number | null;
}

export interface ChatResponse {
  message: ChatMessage;
  doneReason: string | null;
  stats: ChatStats;
  raw?: unknown;
}

export interface ModelAdapter {
  readonly name: string;
  chat(request: ChatRequest, signal: AbortSignal): Promise<ChatResponse>;
}

type ModelErrorKind = "http" | "network" | "malformed" | "aborted";

/**
 * A `ModelAdapter` call's own failure, classified so the loop can react
 * differently per kind (e.g. a `network` blip is not the same situation as a
 * `malformed` response) without parsing `message` text: `"http"` a non-2xx
 * response, `"network"` the request never got a response at all,
 * `"malformed"` a response that parsed but not into a usable chat message,
 * `"aborted"` the caller's own `AbortSignal` fired first.
 */
export class ModelError extends Error {
  constructor(message: string, readonly kind: ModelErrorKind) {
    super(message);
    this.name = "ModelError";
  }
}
