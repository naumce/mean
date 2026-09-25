import type { ModelAdapter } from "./types.js";
import type { HarnessConfig } from "./config.js";
import { PROPOSE_DECISION_NAME, type Proposal } from "./decision.js";
import { captureBaseline } from "./baseline.js";
import { DISPATCH_PROMPT_V1 } from "./prompts/dispatch-v1.js";
import { invokeTool } from "../dispatchTools/invoke.js";
import type { RunStore, StepKind, StoredStep } from "./runStore.js";
import { checkCaps } from "./loopGuards.js";
import { harnessToolDefinitions } from "./loopMessages.js";
import {
  createRunState,
  handleAssistantTurn,
  handleProposeCall,
  handleToolCall,
  finalizeRun,
  type RunContext,
  type PersistStepFn,
} from "./loopHandlers.js";

// aiHarness/loop.ts (Qwen Harness v0.1, Task 5): the agent loop's own
// orchestration — system/user -> [assistant (+thinking) -> tool calls -> tool
// results]* -> final. The per-turn/per-call algorithm itself lives in
// loopHandlers.ts (handleAssistantTurn/handleProposeCall/handleToolCall/
// finalizeRun, fix round 1's extraction out of what was one 300-line
// function); this file is the state machine deciding WHICH of those runs
// next, plus the closures (persistStep/abortRun/stopIfNeeded) that need
// `onStep`/the store's decisionId directly. Writes ONLY through `RunStore`
// (Ai* rows): it never calls `applyLoadChange`, never touches assignments/
// loads/drivers, never imports the Ollama adapter directly (the caller
// injects a `ModelAdapter`), and never parses `thinking` — it is captured as
// its own step for display only.

export type TerminationReason =
  | "proposed"
  | "no_decision"
  | "max_turns"
  | "max_tool_calls"
  | "repeated_calls"
  | "consecutive_invalid"
  | "tool_bytes_exceeded"
  | "timeout"
  | "model_error"
  | "cancelled"
  // Added in fix round 1 — not in the original brief's list, amended by the
  // controller: an unexpected throw from anywhere other than captureBaseline
  // (validateProposal's own DB call, the RunStore, or any other bug) is
  // caught so the run always ends with a real terminationReason instead of
  // staying "running" forever. A captureBaseline throw is handled separately
  // and does NOT produce this reason — the run continues with baseline: null.
  | "internal_error";

export type RunStatus = "queued" | "running" | "proposed" | "incomplete" | "failed" | "cancelled";

export interface RunStats {
  modelCalls: number;
  toolCalls: number;
  uniqueTools: number;
  repeatedCalls: number;
  invalidCalls: number;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number;
}

export interface RunInput {
  orgId: string;
  decisionId: string;
  loadId: string;
  loadRef: string | null;
  config: HarnessConfig;
  adapter: ModelAdapter;
  store: RunStore;
  /** Defaults to the real `invokeTool` — overridden in tests so a loop test
   *  never needs a seeded database for tool execution. */
  invoke?: typeof invokeTool;
  /** Defaults to the real `captureBaseline` — overridden in tests that want
   *  to control the run's feasible set without seeding ⚡Suggest's own
   *  fixtures (a real `AiDecisionRecord`/`AiExperiment` row is still needed
   *  for the run itself; this only stands in for the ⚡Suggest snapshot). */
  captureBaseline?: typeof captureBaseline;
  now?: () => number;
  signal?: AbortSignal;
  onStep?: (seq: number, kind: StepKind) => void;
  onStatus?: (status: RunStatus) => void;
}

export interface RunOutcome {
  status: RunStatus;
  terminationReason: TerminationReason;
  proposal: Proposal | null;
  stats: RunStats;
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs one dispatch-decision experiment against `input.loadId` to completion:
 * captures the ⚡Suggest baseline, drives the model through its tool calls up
 * to `config.maxTurns`, and ends with exactly one `TerminationReason`. Every
 * interaction is persisted through `input.store` as it happens (`onStep`/
 * `onStatus` fire right after each persist), so a caller watching the same
 * run live sees exactly what ends up in the transcript — nothing is buffered
 * and flushed at the end.
 */
export async function runDispatchDecision(input: RunInput): Promise<RunOutcome> {
  const now = input.now ?? (() => Date.now());
  const store = input.store;
  const invoke = input.invoke ?? invokeTool;
  const captureBaselineFn = input.captureBaseline ?? captureBaseline;
  const config = input.config;
  const onStep = input.onStep ?? (() => {});
  const onStatus = input.onStatus ?? (() => {});
  const decisionId = input.decisionId;

  const startedAtMs = now();
  const deadlineAtMs = startedAtMs + config.maxRunMs;

  const systemContent = DISPATCH_PROMPT_V1.system;
  const userContent = DISPATCH_PROMPT_V1.user({ loadId: input.loadId, loadRef: input.loadRef });
  const state = createRunState([
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ]);
  const ctx: RunContext = {
    orgId: input.orgId,
    loadId: input.loadId,
    decisionId,
    config,
    adapter: input.adapter,
    tools: harnessToolDefinitions(),
    invoke,
    now,
    deadlineAtMs,
    signal: input.signal,
    store,
    startedAtMs,
    onStatus,
  };

  const persistStep: PersistStepFn = async (kind, name, payload, durationMs = null) => {
    const atMs = now();
    const seq = await store.appendStep(decisionId, { kind, name, payload, atMs, durationMs });
    const step: StoredStep = { seq, kind, name, payload, atMs, durationMs };
    state.stepLog.push(step);
    onStep(seq, kind);
    return step;
  };

  /** Persists the one `error` step every non-`proposed` abnormal termination
   *  gets (a genuine `ModelError`, or this loop's own timeout/cancel
   *  detection) and ends the run. Cap-triggered terminations (max_turns,
   *  repeated_calls, etc.) do NOT go through here — their own tool_result/
   *  nudge steps already explain what happened; a redundant error step would
   *  only repeat it. */
  async function abortRun(kind: string, message: string, terminationReason: TerminationReason): Promise<RunOutcome> {
    await persistStep("error", null, { kind, message });
    return finalizeRun(state, ctx, terminationReason, null, message);
  }

  /** Checked before every model call and every tool call (and once more right
   *  after a tool call finishes) — never assumed to have already been caught
   *  by `callModel`'s own racing, since a tool call has no abort machinery of
   *  its own at all. */
  async function stopIfNeeded(context: string): Promise<RunOutcome | null> {
    if (input.signal?.aborted) return abortRun("cancelled", `run cancelled ${context}`, "cancelled");
    if (now() >= deadlineAtMs) return abortRun("timeout", `run deadline exceeded ${context}`, "timeout");
    return null;
  }

  /** Fix round 1: the run must never stay "running" forever because
   *  something OTHER than the model itself broke — validateProposal's DB
   *  call, the store, or any other bug. Best-effort: if even persisting the
   *  error step fails (the store itself is what's broken), the run still
   *  ends via `finalizeRun` rather than throwing out of this function with
   *  the record stuck `running`. */
  async function handleUnexpectedError(err: unknown): Promise<RunOutcome> {
    const message = errorMessageOf(err);
    await persistStep("error", null, { kind: "internal", message }).catch(() => {});
    return finalizeRun(state, ctx, "internal_error", null, message);
  }

  await store.updateRun(decisionId, {
    status: "running",
    startedAt: new Date(startedAtMs),
    modelConfig: config,
    promptVersion: DISPATCH_PROMPT_V1.version,
  });
  onStatus("running");

  // captureBaseline's own failure is NOT an internal_error: the brief already
  // treats a null baseline (load not found, wrong org) as a normal, run-
  // continuing outcome, so an engine hiccup should be no different — persist
  // what happened, keep going with an empty feasible set instead of a seeded
  // one, and let the model's own tools still drive the investigation.
  try {
    state.baseline = await captureBaselineFn(input.orgId, input.loadId);
  } catch (err) {
    await persistStep("error", null, { kind: "baseline", message: errorMessageOf(err) }).catch(() => {});
    state.baseline = null;
  }
  state.feasibleSet = new Set<string>(state.baseline?.feasibleDriverIds ?? []);

  try {
    await store.updateRun(decisionId, { baseline: state.baseline ?? null });
    await persistStep("system", null, { content: systemContent });
    await persistStep("user", null, { content: userContent });

    for (let turn = 1; turn <= config.maxTurns; turn++) {
      const stoppedBeforeCall = await stopIfNeeded("before the next model call");
      if (stoppedBeforeCall) return stoppedBeforeCall;

      const turnResult = await handleAssistantTurn(state, ctx, persistStep);
      if (turnResult.kind === "aborted") return abortRun(turnResult.errorKind, turnResult.errorMessage, turnResult.reason);
      if (turnResult.kind === "no_decision") return finalizeRun(state, ctx, "no_decision", null);
      if (turnResult.kind === "nudged") continue;

      const { toolCalls } = turnResult;
      for (let i = 0; i < toolCalls.length; i++) {
        const call = toolCalls[i];

        const stoppedBeforeTool = await stopIfNeeded("before the next tool call");
        if (stoppedBeforeTool) return stoppedBeforeTool;

        if (call.name === PROPOSE_DECISION_NAME) {
          const result = await handleProposeCall(call, toolCalls.slice(i + 1), state, ctx, persistStep);
          if (result.kind === "proposed") return finalizeRun(state, ctx, "proposed", result.proposal);
        } else {
          await handleToolCall(call, state, ctx, persistStep);
        }

        // A call that finishes after the deadline still gets its result
        // persisted (above) before the run stops — never abandoned
        // mid-flight, since tool calls carry no abort signal of their own.
        const stoppedAfterTool = await stopIfNeeded("after a tool call completed");
        if (stoppedAfterTool) return stoppedAfterTool;

        const capReason = checkCaps(
          { toolCallsCount: state.toolCallsCount, bytesUsed: state.bytesUsed, consecutiveInvalid: state.consecutiveInvalid, repeatedCount: state.repeatedCount },
          config,
        );
        if (capReason) return finalizeRun(state, ctx, capReason, null);
      }
    }

    return finalizeRun(state, ctx, "max_turns", null);
  } catch (err) {
    return handleUnexpectedError(err);
  }
}
