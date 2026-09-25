import type { ChatRequest, ChatResponse, ModelAdapter } from "../../src/lib/aiHarness/types.js";

// tests/helpers/scriptedAdapter.ts (Qwen Harness v0.1, Task 3): a
// `ModelAdapter` whose replies come from a fixed script instead of a real
// model, for tests of the harness loop (a later task) that need an exact,
// deterministic conversation without a network. Not a `*.test.ts` file, so
// vitest's test glob never collects it — every loop test can import it.

type ScriptEntry = ChatResponse | Error | ((req: ChatRequest) => ChatResponse | Error);

/**
 * One entry of `script` is consumed per `chat()` call, in order: a
 * `ChatResponse` resolves as-is, an `Error` is thrown, and a function is
 * called with the request and may return either. `requests` accumulates
 * every `ChatRequest` actually sent, so a test can assert what the loop
 * asked in addition to scripting what it was told back.
 */
export function scriptedAdapter(script: ScriptEntry[]): ModelAdapter & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let callIndex = 0;

  return {
    name: "scripted",
    requests,
    async chat(request: ChatRequest, _signal: AbortSignal): Promise<ChatResponse> {
      requests.push(request);
      if (callIndex >= script.length) {
        throw new Error(`scriptedAdapter: no scripted response for call ${callIndex + 1} (script has ${script.length}).`);
      }
      const entry = script[callIndex];
      callIndex += 1;

      const result = typeof entry === "function" ? entry(request) : entry;
      if (result instanceof Error) throw result;
      return result;
    },
  };
}
