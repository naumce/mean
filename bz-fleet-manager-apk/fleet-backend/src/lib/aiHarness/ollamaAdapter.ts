import {
  ModelError,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ModelAdapter,
  type Role,
  type ToolCall,
  type ToolDefinition,
} from "./types.js";

// aiHarness/ollamaAdapter.ts (Qwen Harness v0.1, Task 3): the only file in
// the harness that knows Ollama's actual `/api/chat` JSON. `fetchImpl`
// defaults to the global `fetch` (Node 18+) and is replaced in tests with a
// fake that never reaches a real server — the adapter itself knows nothing
// about HTTP transport beyond the Fetch API.

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `fetch`'s own rejection when the request's `AbortSignal` fires — checked
 *  by name rather than `instanceof DOMException`, since Node's `undici` and
 *  the browser Fetch spec don't guarantee the same constructor. */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function toOllamaMessage(m: ChatMessage): Record<string, unknown> {
  return {
    role: m.role,
    content: m.content,
    ...(m.thinking !== undefined ? { thinking: m.thinking } : {}),
    ...(m.toolCalls
      ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) }
      : {}),
    ...(m.toolName !== undefined ? { tool_name: m.toolName } : {}),
  };
}

function toOllamaTool(t: ToolDefinition): Record<string, unknown> {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } };
}

function toOllamaRequestBody(request: ChatRequest): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages.map(toOllamaMessage),
    tools: request.tools.map(toOllamaTool),
    think: request.think,
    stream: false,
    options: { temperature: request.temperature, num_ctx: request.numCtx },
    keep_alive: request.keepAlive,
  };
}

interface OllamaToolCallWire {
  function?: { name?: unknown; arguments?: unknown };
}

/**
 * `arguments` off one of Ollama's response `tool_calls` entries: usually
 * already an object; some models hand back a JSON-encoded string instead,
 * which is parsed here. A string that fails to parse — or parses to anything
 * other than a plain object — is kept verbatim as `{ __raw: <string> }` so
 * the loop can reject the call as invalid instead of crashing on it.
 */
function parseToolCallArguments(rawArgs: unknown): Record<string, unknown> {
  if (rawArgs != null && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    return rawArgs as Record<string, unknown>;
  }
  if (typeof rawArgs === "string") {
    try {
      const parsed: unknown = JSON.parse(rawArgs);
      if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Falls through to the __raw wrapper below.
    }
    return { __raw: rawArgs };
  }
  return {};
}

function parseToolCall(call: OllamaToolCallWire): ToolCall {
  const name = typeof call.function?.name === "string" ? call.function.name : "";
  return { name, arguments: parseToolCallArguments(call.function?.arguments) };
}

interface OllamaChatWire {
  message?: {
    role?: unknown;
    content?: unknown;
    thinking?: unknown;
    tool_calls?: OllamaToolCallWire[];
  };
  done_reason?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
  total_duration?: unknown;
}

const NS_PER_MS = 1_000_000;

/** Ollama's response body, parsed into this harness's own `ChatResponse` —
 *  the boundary where an unrecognizable shape becomes a
 *  `ModelError("malformed")` instead of a `TypeError` three call frames
 *  later. */
function parseOllamaChatResponse(payload: unknown): ChatResponse {
  const wire = payload as OllamaChatWire | null;
  const message = wire?.message;
  if (!message || typeof message.role !== "string" || typeof message.content !== "string") {
    throw new ModelError("Ollama response is missing a usable message.", "malformed");
  }

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.map(parseToolCall) : undefined;

  return {
    message: {
      // Ollama's chat response always answers with role "assistant"; reading
      // the wire value (already checked to be a string above) rather than
      // hardcoding it costs nothing and stays correct if that ever changes.
      role: message.role as Role,
      content: message.content,
      ...(typeof message.thinking === "string" ? { thinking: message.thinking } : {}),
      ...(toolCalls ? { toolCalls } : {}),
    },
    doneReason: typeof wire?.done_reason === "string" ? wire.done_reason : null,
    stats: {
      promptTokens: typeof wire?.prompt_eval_count === "number" ? wire.prompt_eval_count : null,
      completionTokens: typeof wire?.eval_count === "number" ? wire.eval_count : null,
      totalDurationMs: typeof wire?.total_duration === "number" ? wire.total_duration / NS_PER_MS : null,
    },
    raw: payload,
  };
}

/**
 * A `ModelAdapter` backed by a real (or faked, via `fetchImpl`) Ollama server
 * at `baseUrl`. The `signal` passed into `chat` is the CALLER's own — this
 * adapter enforces no timeout of its own, since `modelCallTimeoutMs` is the
 * loop's budget to keep, not this adapter's.
 */
export function createOllamaAdapter(baseUrl: string, fetchImpl: typeof fetch = fetch): ModelAdapter {
  const url = `${baseUrl.replace(/\/$/, "")}/api/chat`;

  return {
    name: "ollama",
    async chat(request: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(toOllamaRequestBody(request)),
          signal,
        });
      } catch (err) {
        if (isAbortError(err)) throw new ModelError("Ollama request aborted.", "aborted");
        throw new ModelError(`Could not reach Ollama: ${errorMessage(err)}`, "network");
      }

      if (!res.ok) {
        throw new ModelError(`Ollama returned HTTP ${res.status}.`, "http");
      }

      let payload: unknown;
      try {
        payload = await res.json();
      } catch (err) {
        if (isAbortError(err)) throw new ModelError("Ollama request aborted.", "aborted");
        throw new ModelError(`Ollama returned invalid JSON: ${errorMessage(err)}`, "malformed");
      }

      return parseOllamaChatResponse(payload);
    },
  };
}

function withTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  // Deliberately the global setTimeout/clearTimeout, not `AbortSignal.timeout`
  // — the latter schedules on Node's own internal timer rather than the ones
  // `vi.useFakeTimers()` can control, which would make this 3s budget
  // untestable without an actual 3-second wait.
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

const CHECK_TIMEOUT_MS = 3000;

/**
 * Whether `baseUrl` is a live Ollama server and whether `model` is already
 * pulled there — the "AI Lab" status panel's one preflight check, never
 * something the run loop calls per turn. Both requests share one 3s budget;
 * either one failing to answer in time reads as unreachable, same as the
 * server not existing at all.
 */
export async function checkOllama(
  baseUrl: string,
  model: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ reachable: boolean; version: string | null; models: string[]; modelPresent: boolean; error: string | null }> {
  const base = baseUrl.replace(/\/$/, "");
  const { signal, cancel } = withTimeout(CHECK_TIMEOUT_MS);
  try {
    const [versionRes, tagsRes] = await Promise.all([
      fetchImpl(`${base}/api/version`, { signal }),
      fetchImpl(`${base}/api/tags`, { signal }),
    ]);
    if (!versionRes.ok || !tagsRes.ok) {
      const badStatus = !versionRes.ok ? versionRes.status : tagsRes.status;
      return { reachable: false, version: null, models: [], modelPresent: false, error: `Ollama returned HTTP ${badStatus}.` };
    }

    const versionBody = (await versionRes.json()) as { version?: unknown };
    const tagsBody = (await tagsRes.json()) as { models?: { name?: unknown }[] };
    const models = Array.isArray(tagsBody.models)
      ? tagsBody.models.map((m) => (typeof m?.name === "string" ? m.name : null)).filter((n): n is string => n !== null)
      : [];

    return {
      reachable: true,
      version: typeof versionBody.version === "string" ? versionBody.version : null,
      models,
      modelPresent: models.includes(model),
      error: null,
    };
  } catch (err) {
    return { reachable: false, version: null, models: [], modelPresent: false, error: errorMessage(err) };
  } finally {
    cancel();
  }
}
