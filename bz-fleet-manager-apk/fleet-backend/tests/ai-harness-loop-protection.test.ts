import { resetDb } from "./helpers.js";
import { scriptedAdapter } from "./helpers/scriptedAdapter.js";
import { memoryRunStore } from "./helpers/memoryRunStore.js";
import { runDispatchDecision, type RunInput } from "../src/lib/aiHarness/loop.js";
import { DEFAULT_HARNESS_CONFIG } from "../src/lib/aiHarness/config.js";
import { ModelError, type ChatResponse, type ModelAdapter } from "../src/lib/aiHarness/types.js";
import type { InvokeResult } from "../src/lib/dispatchTools/invoke.js";
import { sumTokens } from "../src/lib/aiHarness/loopMessages.js";

// Qwen Harness v0.1, Task 5 — loop.ts's safety valves: the turn cap, the
// tool-call cap, repeated-call detection, the consecutive-invalid cap, the
// accumulated-bytes cap, per-call timeout, the run deadline (checked before
// both a model call and a tool call), and mid-run cancellation. None of these
// scenarios ever reach an ACCEPTED propose_decision, so none need a seeded
// Org/Driver — only `validateProposal` (Task 4, not injectable) touches the
// database, and it is never reached here. `resetDb` still runs for
// consistency with every other suite.

beforeEach(resetDb);

function assistantTurn(content: string, toolCalls: { name: string; arguments: Record<string, unknown> }[] = []): ChatResponse {
  return {
    message: { role: "assistant", content, ...(toolCalls.length > 0 ? { toolCalls } : {}) },
    doneReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    stats: { promptTokens: 10, completionTokens: 5, totalDurationMs: 50 },
  };
}

function makeInput(overrides: Partial<RunInput> & Pick<RunInput, "adapter">): RunInput {
  return {
    orgId: "org-1",
    decisionId: "decision-1",
    loadId: "load-1",
    loadRef: "L-100",
    config: DEFAULT_HARNESS_CONFIG,
    store: memoryRunStore(),
    captureBaseline: async () => null,
    ...overrides,
  };
}

const OK_VALUE: InvokeResult = { ok: true, value: { ok: true } };

describe("sumTokens (loopMessages.ts)", () => {
  it("stays null when every call reports null, and sums only the present values otherwise", () => {
    expect(sumTokens(null, null)).toBeNull();
    expect(sumTokens(null, 10)).toBe(10);
    expect(sumTokens(10, null)).toBe(10); // a later null leaves the running total untouched, never resets it
    expect(sumTokens(10, 5)).toBe(15);
  });
});

describe("runDispatchDecision: loop caps", () => {
  it("ends as max_turns when the model never proposes within its turn budget", async () => {
    const store = memoryRunStore();
    const invoke = async (): Promise<InvokeResult> => OK_VALUE;
    const adapter = scriptedAdapter([
      assistantTurn("Call 1.", [{ name: "getDriverMetrics", arguments: { driverId: "d1" } }]),
      assistantTurn("Call 2.", [{ name: "getDriverMetrics", arguments: { driverId: "d2" } }]),
    ]);

    const outcome = await runDispatchDecision(
      makeInput({ decisionId: "d-maxturns", store, adapter, invoke, config: { ...DEFAULT_HARNESS_CONFIG, maxTurns: 2 } }),
    );

    expect(outcome.terminationReason).toBe("max_turns");
    expect(outcome.status).toBe("incomplete");
    expect(outcome.stats.modelCalls).toBe(2);
  });

  it("ends as max_tool_calls once the successful, non-repeated tool-call budget is exhausted", async () => {
    const store = memoryRunStore();
    const invoke = async (): Promise<InvokeResult> => OK_VALUE;
    const adapter = scriptedAdapter([
      assistantTurn("Call 1.", [{ name: "getDriverMetrics", arguments: { driverId: "d1" } }]),
      assistantTurn("Call 2.", [{ name: "getDriverMetrics", arguments: { driverId: "d2" } }]),
    ]);

    const outcome = await runDispatchDecision(
      makeInput({ decisionId: "d-maxtools", store, adapter, invoke, config: { ...DEFAULT_HARNESS_CONFIG, maxToolCalls: 2, maxTurns: 10 } }),
    );

    expect(outcome.terminationReason).toBe("max_tool_calls");
    expect(outcome.status).toBe("incomplete");
    expect(adapter.requests.length).toBe(2); // a 3rd turn was never requested
    expect(outcome.stats.toolCalls).toBe(2);
  });

  it("ends as repeated_calls after the identical call is repeated three times", async () => {
    const store = memoryRunStore();
    const invoke = async (): Promise<InvokeResult> => OK_VALUE;
    const call = { name: "getDriverMetrics", arguments: { driverId: "d1" } };
    const adapter = scriptedAdapter([
      assistantTurn("First.", [call]),
      assistantTurn("Again.", [call]),
      assistantTurn("Again.", [call]),
      assistantTurn("Again.", [call]),
    ]);

    const outcome = await runDispatchDecision(
      makeInput({
        decisionId: "d-repeated",
        store,
        adapter,
        invoke,
        // A repeated call also counts as invalid (design spec §3) -- with the
        // default cap both would trip on the very same call. Raised here so
        // repeated_calls is the cap actually being exercised by this test.
        config: { ...DEFAULT_HARNESS_CONFIG, maxConsecutiveInvalid: 10, maxTurns: 10 },
      }),
    );

    expect(outcome.terminationReason).toBe("repeated_calls");
    expect(outcome.status).toBe("incomplete");

    const steps = store.stepsFor("d-repeated");
    const firstSuccess = steps.find((s) => s.kind === "tool_result" && (s.payload as { ok: boolean }).ok === true);
    const repeats = steps.filter((s) => s.kind === "tool_result" && (s.payload as { ok: boolean }).ok === false);
    expect(repeats).toHaveLength(3);
    for (const repeat of repeats) {
      expect((repeat.payload as { error: string }).error).toBe(`identical call already made; reuse the earlier result (step ${firstSuccess!.seq})`);
    }
    expect(store.latest("d-repeated").stats).toMatchObject({ repeatedCalls: 3, invalidCalls: 3 });
  });

  it("ends as consecutive_invalid after three invalid calls in a row, with no repeats involved", async () => {
    const store = memoryRunStore();
    const adapter = scriptedAdapter([
      assistantTurn("Bad 1.", [{ name: "getDriverMetrics", arguments: {} }]),
      assistantTurn("Bad 2.", [{ name: "getDriverHistory", arguments: {} }]),
      assistantTurn("Bad 3.", [{ name: "noSuchTool", arguments: {} }]),
    ]);

    const outcome = await runDispatchDecision(
      makeInput({ decisionId: "d-consecutive", store, adapter, config: { ...DEFAULT_HARNESS_CONFIG, maxConsecutiveInvalid: 3, maxTurns: 10 } }),
    );

    expect(outcome.terminationReason).toBe("consecutive_invalid");
    expect(outcome.status).toBe("incomplete");
    expect(store.latest("d-consecutive").stats).toMatchObject({ invalidCalls: 3, repeatedCalls: 0 });
  });

  it("ends as tool_bytes_exceeded once accumulated returned bytes across calls reach the cap", async () => {
    const store = memoryRunStore();
    const bigValue = { data: "x".repeat(200) }; // ~211 bytes of JSON, well under the 300-byte cap on its own
    const invoke = async (): Promise<InvokeResult> => ({ ok: true, value: bigValue });
    const adapter = scriptedAdapter([
      assistantTurn("Call 1.", [{ name: "getDriverMetrics", arguments: { driverId: "d1" } }]),
      assistantTurn("Call 2.", [{ name: "getDriverHistory", arguments: { driverId: "d2" } }]),
    ]);

    const outcome = await runDispatchDecision(
      makeInput({ decisionId: "d-bytes", store, adapter, invoke, config: { ...DEFAULT_HARNESS_CONFIG, maxToolResultBytes: 300, maxTurns: 10 } }),
    );

    expect(outcome.terminationReason).toBe("tool_bytes_exceeded");
    expect(outcome.status).toBe("incomplete");
    expect(adapter.requests.length).toBe(2); // tripped after the 2nd call; a 3rd turn was never requested
    const results = store.stepsFor("d-bytes").filter((s) => s.kind === "tool_result");
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect((result.payload as { truncated: boolean }).truncated).toBe(false); // neither call was truncated on its own
    }
  });

  it("truncates a single result over the PER-RESULT 8 KB default, independent of the (much larger) cumulative cap", async () => {
    const store = memoryRunStore();
    const twentyKb = { data: "x".repeat(20_000) }; // ~20 KB of JSON, well over serializeToolResult's 8192-byte default
    const invoke = async (): Promise<InvokeResult> => ({ ok: true, value: twentyKb });
    const adapter = scriptedAdapter([
      assistantTurn("One big call.", [{ name: "getDriverLocationHistory", arguments: { driverId: "d1", sinceMs: 0 } }]),
      // A second, harmless turn purely so the tool result actually gets SENT
      // to the adapter (turn 1's own request is built BEFORE that result
      // exists) -- this is what lets the test inspect the real wire content.
      assistantTurn("Nothing further."),
    ]);

    const outcome = await runDispatchDecision(
      // The default cumulative cap (65536) is untouched here -- only a single
      // ~20 KB call is made, so if truncation used config.maxToolResultBytes
      // instead of the per-result 8192 default, this would come back
      // UNtruncated.
      makeInput({ decisionId: "d-big-truncate", store, adapter, invoke, config: { ...DEFAULT_HARNESS_CONFIG, maxTurns: 2 } }),
    );

    expect(outcome.terminationReason).toBe("max_turns"); // truncation alone never ends a run
    const resultStep = store.stepsFor("d-big-truncate").find((s) => s.kind === "tool_result");
    const payload = resultStep!.payload as { truncated: boolean; originalSize: number; returnedSize: number; preview: string };
    expect(payload.truncated).toBe(true);
    expect(payload.originalSize).toBeGreaterThan(payload.returnedSize);
    expect(payload.returnedSize).toBeLessThanOrEqual(8192);
    expect(payload.preview.length).toBeLessThanOrEqual(512);

    // The wire content sent back to the model on the NEXT call is the same
    // wrapper shape serializeToolResult produces directly:
    // { truncated: true, originalSize, returnedSize, data }.
    const toolMessage = adapter.requests[1]?.messages.find((m) => m.toolName === "getDriverLocationHistory");
    const wireContent = JSON.parse(toolMessage!.content) as { truncated: boolean; originalSize: number; returnedSize: number; data: string };
    expect(wireContent.truncated).toBe(true);
    expect(wireContent.originalSize).toBe(payload.originalSize);
    expect(wireContent.returnedSize).toBe(payload.returnedSize);

    const summary = store.latest("d-big-truncate").toolResults?.[0];
    expect(summary).toMatchObject({ name: "getDriverLocationHistory", ok: true, truncated: true });
  });

  it("[default config] 3 CONSECUTIVE repeats trip consecutive_invalid first (repeats count as invalid too)", async () => {
    const store = memoryRunStore();
    const invoke = async (): Promise<InvokeResult> => OK_VALUE;
    const call = { name: "getDriverMetrics", arguments: { driverId: "d1" } };
    const adapter = scriptedAdapter([
      assistantTurn("First.", [call]),
      assistantTurn("Again.", [call]),
      assistantTurn("Again.", [call]),
      assistantTurn("Again.", [call]),
    ]);

    const outcome = await runDispatchDecision(
      makeInput({ decisionId: "d-default-consecutive", store, adapter, invoke, config: DEFAULT_HARNESS_CONFIG }),
    );

    expect(outcome.terminationReason).toBe("consecutive_invalid");
    expect(outcome.status).toBe("incomplete");
    expect(outcome.stats.repeatedCalls).toBe(3);
    expect(outcome.stats.invalidCalls).toBe(3);
  });

  it("[default config] repeats INTERLEAVED with successful calls trip repeated_calls instead", async () => {
    const store = memoryRunStore();
    const invoke = async (): Promise<InvokeResult> => OK_VALUE;
    const metrics = { name: "getDriverMetrics", arguments: { driverId: "d1" } };
    const adapter = scriptedAdapter([
      assistantTurn("Original call.", [metrics]),
      assistantTurn("Repeat 1.", [metrics]),
      // A different, successful call between each repeat resets
      // consecutiveInvalid to 0 without touching repeatedCount, so three
      // repeats can accumulate without ever tripping consecutive_invalid.
      assistantTurn("A different, valid call.", [{ name: "getDriverHistory", arguments: { driverId: "d1" } }]),
      assistantTurn("Repeat 2.", [metrics]),
      assistantTurn("Another different, valid call.", [{ name: "getDriverAvailability", arguments: { driverId: "d1" } }]),
      assistantTurn("Repeat 3.", [metrics]),
    ]);

    const outcome = await runDispatchDecision(
      makeInput({ decisionId: "d-default-interleaved", store, adapter, invoke, config: DEFAULT_HARNESS_CONFIG }),
    );

    expect(outcome.terminationReason).toBe("repeated_calls");
    expect(outcome.status).toBe("incomplete");
    expect(outcome.stats.repeatedCalls).toBe(3);
  });
});

describe("runDispatchDecision: per-call timeout", () => {
  it("maps an adapter-observed abort to timeout when the run itself was not cancelled", async () => {
    const store = memoryRunStore();
    const adapter = scriptedAdapter([new ModelError("Ollama request aborted.", "aborted")]);

    const outcome = await runDispatchDecision(makeInput({ decisionId: "d-calltimeout", store, adapter }));

    expect(outcome.terminationReason).toBe("timeout");
    expect(outcome.status).toBe("failed");
    const errorStep = store.stepsFor("d-calltimeout").find((s) => s.kind === "error");
    expect(errorStep?.payload).toMatchObject({ kind: "aborted" });
  });

  it("a genuinely hanging adapter (never resolves) times out via the REAL timer/AbortController mechanism, leaking no timer", async () => {
    vi.useFakeTimers();
    try {
      const store = memoryRunStore();
      let capturedSignal: AbortSignal | undefined;
      const adapter: ModelAdapter = {
        name: "hanging",
        chat: (_req, signal) => {
          capturedSignal = signal;
          return new Promise(() => {}); // never resolves -- callModel's own race must be what cuts this off
        },
      };
      const config = { ...DEFAULT_HARNESS_CONFIG, modelCallTimeoutMs: 20, maxRunMs: 60_000 };

      const outcomePromise = runDispatchDecision(makeInput({ decisionId: "d-hang-timeout", store, adapter, config }));
      await vi.advanceTimersByTimeAsync(25); // flushes the run up through the call, fires the 20ms timer, then drains
      const outcome = await outcomePromise;

      expect(outcome.terminationReason).toBe("timeout");
      expect(outcome.status).toBe("failed");
      expect(capturedSignal?.aborted).toBe(true); // the adapter's own request was actually cancelled
      const errorStep = store.stepsFor("d-hang-timeout").find((s) => s.kind === "error");
      expect(errorStep?.payload).toEqual({ kind: "aborted", message: "model call exceeded its time budget" });
      expect(vi.getTimerCount()).toBe(0); // the timer that fired was cleared, nothing else was scheduled
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a late-resolving response after the run has already timed out (no second assistant step)", async () => {
    vi.useFakeTimers();
    try {
      const store = memoryRunStore();
      const adapter: ModelAdapter = {
        name: "late",
        chat: () =>
          new Promise((resolve) => {
            // Resolves long after the 20ms timeout has already fired and the
            // run has ended -- Promise.race has already settled by then, so
            // nothing is left awaiting this promise's eventual fulfillment.
            setTimeout(
              () =>
                resolve({
                  message: { role: "assistant", content: "Too late." },
                  doneReason: "stop",
                  stats: { promptTokens: 1, completionTokens: 1, totalDurationMs: 1 },
                }),
              1000,
            );
          }),
      };
      const config = { ...DEFAULT_HARNESS_CONFIG, modelCallTimeoutMs: 20, maxRunMs: 60_000 };

      const outcomePromise = runDispatchDecision(makeInput({ decisionId: "d-late-response", store, adapter, config }));
      await vi.advanceTimersByTimeAsync(25); // fires the 20ms timeout; the run ends here
      const outcome = await outcomePromise;
      expect(outcome.terminationReason).toBe("timeout");

      const stepCountAfterAbort = store.stepsFor("d-late-response").length;
      await vi.advanceTimersByTimeAsync(2000); // now let the adapter's own (irrelevant) timer fire too

      expect(store.stepsFor("d-late-response").length).toBe(stepCountAfterAbort); // nothing new was persisted
      expect(store.stepsFor("d-late-response").filter((s) => s.kind === "assistant")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runDispatchDecision: run deadline", () => {
  it("checks the deadline before starting a new model call, never attempting it", async () => {
    const store = memoryRunStore();
    const START = 1_000_000;
    let pastDeadline = false;
    // The scripted turn itself flips the flag, simulating "real time passed
    // while turn 1 was in flight" -- entirely independent of how many times
    // `now()` happens to be called internally.
    const adapter = scriptedAdapter([
      (): ChatResponse => {
        pastDeadline = true;
        return assistantTurn("Thinking, no action yet.");
      },
      assistantTurn("Should never be requested."),
    ]);
    const now = () => (pastDeadline ? START + 10_000 : START);

    const outcome = await runDispatchDecision(
      makeInput({ decisionId: "d-deadline", store, adapter, now, config: { ...DEFAULT_HARNESS_CONFIG, maxRunMs: 5000, maxTurns: 10 } }),
    );

    expect(outcome.terminationReason).toBe("timeout");
    expect(outcome.status).toBe("failed");
    expect(adapter.requests.length).toBe(1);
    expect(store.stepsFor("d-deadline").map((s) => s.kind)).toEqual(["system", "user", "assistant", "nudge", "error"]);
  });

  it("skips a tool call entirely once the deadline has already passed before it starts", async () => {
    const store = memoryRunStore();
    const START = 1_000_000;
    let pastDeadline = false;
    const invoke = async (): Promise<InvokeResult> => OK_VALUE;
    const now = () => (pastDeadline ? START + 10_000 : START);
    const adapter = scriptedAdapter([
      (): ChatResponse => {
        pastDeadline = true; // "time passes" while producing this very turn
        return assistantTurn("Two calls at once.", [
          { name: "getDriverMetrics", arguments: { driverId: "d1" } },
          { name: "getDriverHistory", arguments: { driverId: "d1" } },
        ]);
      },
    ]);

    const invokeSpy = vi.fn(invoke);
    const outcome = await runDispatchDecision(
      makeInput({ decisionId: "d-preskip", store, adapter, invoke: invokeSpy, now, config: { ...DEFAULT_HARNESS_CONFIG, maxRunMs: 5000, maxTurns: 10 } }),
    );

    expect(outcome.terminationReason).toBe("timeout");
    expect(invokeSpy).not.toHaveBeenCalled();
    expect(store.stepsFor("d-preskip").map((s) => s.kind)).toEqual(["system", "user", "assistant", "error"]);
  });

  it("still persists a tool call's own result when the deadline passes during it, then stops before any further call", async () => {
    const store = memoryRunStore();
    const START = 1_000_000;
    let pastDeadline = false;
    const now = () => (pastDeadline ? START + 10_000 : START);
    const invoke = vi.fn(async (): Promise<InvokeResult> => {
      pastDeadline = true; // "time passes" while this call executes
      return OK_VALUE;
    });
    const adapter = scriptedAdapter([
      assistantTurn("Two calls at once.", [
        { name: "getDriverMetrics", arguments: { driverId: "d1" } },
        { name: "getDriverHistory", arguments: { driverId: "d1" } },
      ]),
    ]);

    const outcome = await runDispatchDecision(
      makeInput({ decisionId: "d-postcheck", store, adapter, invoke, now, config: { ...DEFAULT_HARNESS_CONFIG, maxRunMs: 5000, maxTurns: 10 } }),
    );

    expect(outcome.terminationReason).toBe("timeout");
    expect(invoke).toHaveBeenCalledTimes(1); // the 2nd call in the same message was never attempted
    expect(store.stepsFor("d-postcheck").map((s) => s.kind)).toEqual(["system", "user", "assistant", "tool_call", "tool_result", "error"]);
  });
});

describe("runDispatchDecision: mid-run cancellation", () => {
  it("stops the run when the caller's signal aborts between tool calls in the same message", async () => {
    const store = memoryRunStore();
    const controller = new AbortController();
    const invoke = vi.fn(async (): Promise<InvokeResult> => {
      controller.abort();
      return OK_VALUE;
    });
    const adapter = scriptedAdapter([
      assistantTurn("Two calls at once.", [
        { name: "getDriverMetrics", arguments: { driverId: "d1" } },
        { name: "getDriverHistory", arguments: { driverId: "d1" } },
      ]),
    ]);

    const outcome = await runDispatchDecision(
      makeInput({ decisionId: "d-midcancel", store, adapter, invoke, signal: controller.signal }),
    );

    expect(outcome.terminationReason).toBe("cancelled");
    expect(outcome.status).toBe("cancelled");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("a genuinely hanging adapter is cancelled via the REAL AbortController when the caller's signal fires mid-call", async () => {
    vi.useFakeTimers();
    try {
      const store = memoryRunStore();
      const controller = new AbortController();
      let capturedSignal: AbortSignal | undefined;
      const adapter: ModelAdapter = {
        name: "hanging",
        chat: (_req, signal) => {
          capturedSignal = signal;
          return new Promise(() => {}); // never resolves -- only the abort can end this call
        },
      };

      const outcomePromise = runDispatchDecision(makeInput({ decisionId: "d-hang-cancel", store, adapter, signal: controller.signal }));
      await vi.advanceTimersByTimeAsync(0); // flush the run up through the model call so the adapter is actually invoked first
      expect(capturedSignal).toBeDefined();
      controller.abort();
      const outcome = await outcomePromise;

      expect(outcome.terminationReason).toBe("cancelled");
      expect(outcome.status).toBe("cancelled");
      expect(capturedSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0); // the per-call timeout timer was cleared, nothing leaked
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runDispatchDecision: status mapping table", () => {
  it("maps incomplete vs. failed vs. cancelled per terminationReason", async () => {
    const cases: { reason: string; expectedStatus: string; run: () => Promise<{ terminationReason: string; status: string }> }[] = [
      {
        reason: "no_decision",
        expectedStatus: "incomplete",
        run: () => runDispatchDecision(makeInput({ decisionId: "d-map-nodec", store: memoryRunStore(), adapter: scriptedAdapter([assistantTurn("a"), assistantTurn("b")]) })),
      },
      {
        reason: "model_error",
        expectedStatus: "failed",
        run: () => runDispatchDecision(makeInput({ decisionId: "d-map-error", store: memoryRunStore(), adapter: scriptedAdapter([new ModelError("boom", "network")]) })),
      },
      {
        reason: "cancelled",
        expectedStatus: "cancelled",
        run: () => {
          const controller = new AbortController();
          controller.abort();
          return runDispatchDecision(makeInput({ decisionId: "d-map-cancel", store: memoryRunStore(), adapter: scriptedAdapter([assistantTurn("never")]), signal: controller.signal }));
        },
      },
    ];

    for (const { reason, expectedStatus, run } of cases) {
      const outcome = await run();
      expect(outcome.terminationReason).toBe(reason);
      expect(outcome.status).toBe(expectedStatus);
    }
  });
});
