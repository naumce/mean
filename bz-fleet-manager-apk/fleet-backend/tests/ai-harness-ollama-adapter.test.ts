import { createOllamaAdapter, checkOllama } from "../src/lib/aiHarness/ollamaAdapter.js";
import { ModelError, type ChatRequest } from "../src/lib/aiHarness/types.js";
import { resolveHarnessConfig, DEFAULT_HARNESS_CONFIG, harnessEnabled } from "../src/lib/aiHarness/config.js";

// Qwen Harness v0.1, Task 3 — aiHarness/ollamaAdapter.ts and config.ts.
// Every network call is a fake `fetch`: no test here ever reaches a real
// Ollama server. `recordingFetch` mirrors this codebase's existing fake-fetch
// idiom (see tests/geocode-settle.test.ts) — a vi.fn that hands back a real
// `Response` and records what it was called with.

function recordingFetch(respond: (url: string, init?: RequestInit) => Response) {
  const requests: { url: string; body: unknown }[] = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    return Promise.resolve(respond(url, init));
  });
  return { fetchImpl: fn as unknown as typeof fetch, requests };
}

function baseRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: "qwen3:8b",
    messages: [],
    tools: [],
    think: true,
    temperature: 0.2,
    numCtx: 16384,
    keepAlive: "5m",
    ...overrides,
  };
}

describe("createOllamaAdapter: request shape", () => {
  it("sends model, messages (incl. tool_name/tool_calls), tools, think, stream, options and keep_alive", async () => {
    const { fetchImpl, requests } = recordingFetch(
      () => new Response(JSON.stringify({ message: { role: "assistant", content: "ok" } }), { status: 200 }),
    );
    const adapter = createOllamaAdapter("http://localhost:11434/", fetchImpl);

    const request = baseRequest({
      messages: [
        { role: "system", content: "You are a dispatcher." },
        { role: "user", content: "Find a driver for L1." },
        { role: "assistant", content: "", toolCalls: [{ name: "getLoad", arguments: { loadId: "L1" } }] },
        { role: "tool", content: '{"id":"L1"}', toolName: "getLoad" },
      ],
      tools: [{ name: "getLoad", description: "desc", parameters: { type: "object", properties: {} } }],
    });

    await adapter.chat(request, new AbortController().signal);

    expect(requests).toHaveLength(1);
    // A trailing slash on baseUrl must not become a double slash before /api/chat.
    expect(requests[0].url).toBe("http://localhost:11434/api/chat");
    expect(requests[0].body).toEqual({
      model: "qwen3:8b",
      messages: [
        { role: "system", content: "You are a dispatcher." },
        { role: "user", content: "Find a driver for L1." },
        { role: "assistant", content: "", tool_calls: [{ function: { name: "getLoad", arguments: { loadId: "L1" } } }] },
        { role: "tool", content: '{"id":"L1"}', tool_name: "getLoad" },
      ],
      tools: [{ type: "function", function: { name: "getLoad", description: "desc", parameters: { type: "object", properties: {} } } }],
      think: true,
      stream: false,
      options: { temperature: 0.2, num_ctx: 16384 },
      keep_alive: "5m",
    });
  });

  it("carries an assistant history message's own thinking", async () => {
    const { fetchImpl, requests } = recordingFetch(
      () => new Response(JSON.stringify({ message: { role: "assistant", content: "ok" } }), { status: 200 }),
    );
    const adapter = createOllamaAdapter("http://x", fetchImpl);

    await adapter.chat(
      baseRequest({ messages: [{ role: "assistant", content: "done", thinking: "reasoning trace" }] }),
      new AbortController().signal,
    );

    expect((requests[0].body as { messages: unknown[] }).messages[0]).toEqual({
      role: "assistant",
      content: "done",
      thinking: "reasoning trace",
    });
  });
});

describe("createOllamaAdapter: response parsing", () => {
  it("parses content, thinking, and object-shaped tool call arguments", async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            message: {
              role: "assistant",
              content: "here you go",
              thinking: "checking the load first",
              tool_calls: [{ function: { name: "getLoad", arguments: { loadId: "L1" } } }],
            },
            done_reason: "stop",
          }),
          { status: 200 },
        ),
    );
    const adapter = createOllamaAdapter("http://x", fetchImpl);

    const response = await adapter.chat(baseRequest(), new AbortController().signal);

    expect(response.message).toEqual({
      role: "assistant",
      content: "here you go",
      thinking: "checking the load first",
      toolCalls: [{ name: "getLoad", arguments: { loadId: "L1" } }],
    });
    expect(response.doneReason).toBe("stop");
  });

  it("parses a JSON-string tool call arguments field", async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            message: { role: "assistant", content: "", tool_calls: [{ function: { name: "getLoad", arguments: '{"loadId":"L1"}' } }] },
          }),
          { status: 200 },
        ),
    );
    const adapter = createOllamaAdapter("http://x", fetchImpl);

    const response = await adapter.chat(baseRequest(), new AbortController().signal);

    expect(response.message.toolCalls).toEqual([{ name: "getLoad", arguments: { loadId: "L1" } }]);
  });

  it("keeps an unparsable string arguments field as { __raw }", async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            message: { role: "assistant", content: "", tool_calls: [{ function: { name: "getLoad", arguments: "{not valid json" } }] },
          }),
          { status: 200 },
        ),
    );
    const adapter = createOllamaAdapter("http://x", fetchImpl);

    const response = await adapter.chat(baseRequest(), new AbortController().signal);

    expect(response.message.toolCalls).toEqual([{ name: "getLoad", arguments: { __raw: "{not valid json" } }]);
  });

  it("converts prompt_eval_count/eval_count/total_duration (ns) into ChatStats (ms)", async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            message: { role: "assistant", content: "ok" },
            prompt_eval_count: 120,
            eval_count: 45,
            total_duration: 2_500_000_000,
          }),
          { status: 200 },
        ),
    );
    const adapter = createOllamaAdapter("http://x", fetchImpl);

    const response = await adapter.chat(baseRequest(), new AbortController().signal);

    expect(response.stats).toEqual({ promptTokens: 120, completionTokens: 45, totalDurationMs: 2500 });
  });

  it("reports null stats and doneReason when the response omits them", async () => {
    const { fetchImpl } = recordingFetch(() => new Response(JSON.stringify({ message: { role: "assistant", content: "ok" } }), { status: 200 }));
    const adapter = createOllamaAdapter("http://x", fetchImpl);

    const response = await adapter.chat(baseRequest(), new AbortController().signal);

    expect(response.stats).toEqual({ promptTokens: null, completionTokens: null, totalDurationMs: null });
    expect(response.doneReason).toBeNull();
  });
});

describe("createOllamaAdapter: ModelError kinds", () => {
  it('a non-2xx response throws ModelError("http") whose message includes the status', async () => {
    expect.assertions(3);
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("server error", { status: 500 }))) as unknown as typeof fetch;
    const adapter = createOllamaAdapter("http://x", fetchImpl);

    try {
      await adapter.chat(baseRequest(), new AbortController().signal);
    } catch (err) {
      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).kind).toBe("http");
      expect((err as ModelError).message).toContain("500");
    }
  });

  it('a rejected fetch throws ModelError("network")', async () => {
    expect.assertions(2);
    const fetchImpl = vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const adapter = createOllamaAdapter("http://x", fetchImpl);

    try {
      await adapter.chat(baseRequest(), new AbortController().signal);
    } catch (err) {
      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).kind).toBe("network");
    }
  });

  it('invalid JSON in the response throws ModelError("malformed")', async () => {
    expect.assertions(2);
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("not json", { status: 200 }))) as unknown as typeof fetch;
    const adapter = createOllamaAdapter("http://x", fetchImpl);

    try {
      await adapter.chat(baseRequest(), new AbortController().signal);
    } catch (err) {
      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).kind).toBe("malformed");
    }
  });

  it('a response with no usable message throws ModelError("malformed")', async () => {
    expect.assertions(2);
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ done_reason: "stop" }), { status: 200 }))) as unknown as typeof fetch;
    const adapter = createOllamaAdapter("http://x", fetchImpl);

    try {
      await adapter.chat(baseRequest(), new AbortController().signal);
    } catch (err) {
      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).kind).toBe("malformed");
    }
  });

  it('the caller\'s AbortSignal firing throws ModelError("aborted")', async () => {
    expect.assertions(2);
    const abortError = Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(abortError));
        }),
    ) as unknown as typeof fetch;
    const adapter = createOllamaAdapter("http://x", fetchImpl);
    const controller = new AbortController();

    const chatPromise = adapter.chat(baseRequest(), controller.signal);
    controller.abort();

    try {
      await chatPromise;
    } catch (err) {
      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).kind).toBe("aborted");
    }
  });
});

describe("checkOllama", () => {
  it("reachable, with the model already pulled", async () => {
    const fetchImpl = vi.fn((url: string) => {
      if (url.endsWith("/api/version")) return Promise.resolve(new Response(JSON.stringify({ version: "0.34.0" }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ models: [{ name: "qwen3:8b" }, { name: "llama3:8b" }] }), { status: 200 }));
    }) as unknown as typeof fetch;

    const status = await checkOllama("http://localhost:11434", "qwen3:8b", fetchImpl);

    expect(status).toEqual({ reachable: true, version: "0.34.0", models: ["qwen3:8b", "llama3:8b"], modelPresent: true, error: null });
  });

  it("reachable, but the requested model has not been pulled", async () => {
    const fetchImpl = vi.fn((url: string) => {
      if (url.endsWith("/api/version")) return Promise.resolve(new Response(JSON.stringify({ version: "0.34.0" }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ models: [{ name: "llama3:8b" }] }), { status: 200 }));
    }) as unknown as typeof fetch;

    const status = await checkOllama("http://localhost:11434", "qwen3:8b", fetchImpl);

    expect(status.reachable).toBe(true);
    expect(status.modelPresent).toBe(false);
    expect(status.models).toEqual(["llama3:8b"]);
  });

  it("unreachable: a fetch that never settles times out at 3s", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
            });
          }),
      ) as unknown as typeof fetch;

      const statusPromise = checkOllama("http://localhost:11434", "qwen3:8b", fetchImpl);
      await vi.advanceTimersByTimeAsync(3000);
      const status = await statusPromise;

      expect(status.reachable).toBe(false);
      expect(status.error).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("resolveHarnessConfig", () => {
  it("returns the defaults for an empty override", () => {
    expect(resolveHarnessConfig({})).toEqual(DEFAULT_HARNESS_CONFIG);
  });

  it("merges a partial override onto the defaults", () => {
    expect(resolveHarnessConfig({ model: "qwen3:14b", temperature: 0.5 })).toEqual({
      ...DEFAULT_HARNESS_CONFIG,
      model: "qwen3:14b",
      temperature: 0.5,
    });
  });

  const outOfRange: [string, Record<string, unknown>][] = [
    ["temperature above 2", { temperature: 2.1 }],
    ["temperature below 0", { temperature: -0.1 }],
    ["numCtx below 2048", { numCtx: 1024 }],
    ["numCtx above 131072", { numCtx: 200_000 }],
    ["maxTurns below 1", { maxTurns: 0 }],
    ["maxTurns above 50", { maxTurns: 51 }],
    ["maxToolCalls below 1", { maxToolCalls: 0 }],
    ["maxToolCalls above 200", { maxToolCalls: 201 }],
    ["maxConsecutiveInvalid below 1", { maxConsecutiveInvalid: 0 }],
    ["maxConsecutiveInvalid above 10", { maxConsecutiveInvalid: 11 }],
    ["maxToolResultBytes below 8192", { maxToolResultBytes: 8191 }],
    ["maxToolResultBytes above 1048576", { maxToolResultBytes: 1_048_577 }],
    ["maxRunMs below 30000", { maxRunMs: 29_999 }],
    ["maxRunMs above 3600000", { maxRunMs: 3_600_001 }],
    ["modelCallTimeoutMs below 5000", { modelCallTimeoutMs: 4_999 }],
    ["modelCallTimeoutMs above 600000", { modelCallTimeoutMs: 600_001 }],
    ["model empty", { model: "" }],
    ["model over 80 chars", { model: "x".repeat(81) }],
    ["adapter not ollama", { adapter: "openai" }],
  ];

  it.each(outOfRange)("rejects %s", (_label, partial) => {
    expect(() => resolveHarnessConfig(partial)).toThrow();
  });
});

describe("harnessEnabled", () => {
  const originalUrl = process.env.OLLAMA_URL;

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.OLLAMA_URL;
    else process.env.OLLAMA_URL = originalUrl;
  });

  it("is false when OLLAMA_URL is unset", () => {
    delete process.env.OLLAMA_URL;
    expect(harnessEnabled()).toBe(false);
  });

  it("flips to true as soon as OLLAMA_URL is set, with no reload", () => {
    process.env.OLLAMA_URL = "http://localhost:11434";
    expect(harnessEnabled()).toBe(true);
  });
});
