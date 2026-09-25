import { ModelError, type ChatRequest, type ChatResponse, type ModelAdapter } from "./types.js";
import type { HarnessConfig } from "./config.js";
import type { RunStatus, TerminationReason } from "./loop.js";

// aiHarness/loopGuards.ts (Qwen Harness v0.1, Task 5): the loop's safety
// valves — cap bookkeeping, the termination -> status mapping, and one model
// call's timeout/cancel racing — split out of loop.ts so that file's
// turn-by-turn algorithm is not buried under abort-signal plumbing.
// `RunStatus`/`TerminationReason` are defined in loop.ts (the algorithm that
// produces them); the type-only import back does not create a runtime cycle.

/** Fixed safety constant, not a per-experiment `HarnessConfig` knob: the
 *  plan's binding algorithm hardcodes "repeated >= 3" rather than exposing
 *  it, unlike every other cap here (`maxToolCalls`, `maxConsecutiveInvalid`,
 *  `maxToolResultBytes`), which the experiment's own config controls. */
export const REPEATED_CALLS_LIMIT = 3;

export interface CapCounters {
  toolCallsCount: number;
  bytesUsed: number;
  consecutiveInvalid: number;
  repeatedCount: number;
}

/**
 * Which cap (if any) `counters` has now tripped, checked in the ORDER the
 * plan's algorithm specifies — not alphabetical, not severity-ranked. A call
 * that trips more than one cap at once (e.g. it both exhausts the tool-call
 * budget and pushes bytes over the limit) always reports the first of these
 * four, so the reported `terminationReason` is deterministic regardless of
 * which caps happen to co-occur.
 */
export function checkCaps(counters: CapCounters, config: HarnessConfig): TerminationReason | null {
  if (counters.toolCallsCount >= config.maxToolCalls) return "max_tool_calls";
  if (counters.bytesUsed >= config.maxToolResultBytes) return "tool_bytes_exceeded";
  if (counters.consecutiveInvalid >= config.maxConsecutiveInvalid) return "consecutive_invalid";
  if (counters.repeatedCount >= REPEATED_CALLS_LIMIT) return "repeated_calls";
  return null;
}

/** `incomplete` covers every non-proposed termination except the ones called
 *  out by name: `model_error`/`timeout`/`internal_error` are `failed` (the
 *  run broke on its own), `cancelled` is its own status (the caller stopped
 *  it — not a failure of the run itself). `internal_error` (fix round 1) is
 *  a `failed` run for the same reason `model_error` is: something outside
 *  the model's own answer broke the run. */
export function statusForTermination(reason: TerminationReason): RunStatus {
  if (reason === "proposed") return "proposed";
  if (reason === "cancelled") return "cancelled";
  if (reason === "model_error" || reason === "timeout" || reason === "internal_error") return "failed";
  return "incomplete";
}

export type ModelCallOutcome =
  | { outcome: "ok"; response: ChatResponse }
  | { outcome: "timeout"; error: ModelError }
  | { outcome: "cancelled"; error: ModelError }
  | { outcome: "model_error"; error: ModelError };

export interface CallModelParams {
  adapter: ModelAdapter;
  request: ChatRequest;
  now: () => number;
  deadlineAtMs: number;
  callTimeoutMs: number;
  callerSignal?: AbortSignal;
}

/**
 * One `adapter.chat` call, raced against its own time budget (the smaller of
 * `callTimeoutMs` and however much of the run's `maxRunMs` is left) and the
 * caller's own cancel signal — never just a signal handed to the adapter and
 * trusted to reject in time. `tests/helpers/scriptedAdapter.ts` (Task 3)
 * resolves or throws synchronously and never inspects the signal it is given,
 * so a test can only exercise "this call was aborted" by scripting the SAME
 * `ModelError("...", "aborted")` a real adapter throws once ITS OWN fetch is
 * cancelled — this function still builds a real `AbortController` and passes
 * it through (`controller.signal`), so a genuine Ollama request over the
 * network is actually cancelled either way; the race is what makes the
 * OUTCOME deterministic even when the adapter under test cannot cancel
 * itself.
 *
 * `cancelled` distinguishes the two ways a raced rejection can happen — the
 * caller's own signal firing vs. this function's own timer — since both
 * surface as the same `ModelError("...", "aborted")` shape. Either way the
 * outcome carries the ACTUAL `ModelError` that won the race (this function's
 * own synthetic one, or whatever the adapter itself threw) so the caller can
 * persist its real `kind`/`message` verbatim — `outcome` is the loop's own
 * classification of what to do next, not a replacement for what happened.
 */
export async function callModel(params: CallModelParams): Promise<ModelCallOutcome> {
  const callerSignal = params.callerSignal;
  // Short-circuit rather than let `Promise.race` sort it out: a synchronously
  // (or already-)resolving adapter would otherwise win the race over an
  // already-rejected `cancelGuard` (native promises settle FIFO), reporting
  // "ok" for a call that should never have been attempted at all.
  if (callerSignal?.aborted) {
    return { outcome: "cancelled", error: new ModelError("run cancelled", "aborted") };
  }

  const remainingRunMs = params.deadlineAtMs - params.now();
  const effectiveMs = Math.max(0, Math.min(params.callTimeoutMs, remainingRunMs));
  const controller = new AbortController();
  let cancelled = false;

  let rejectTimeout!: (err: ModelError) => void;
  const timeoutGuard = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectTimeout(new ModelError("model call exceeded its time budget", "aborted"));
  }, effectiveMs);

  let rejectCancel!: (err: ModelError) => void;
  const cancelGuard = new Promise<never>((_, reject) => {
    rejectCancel = reject;
  });
  const onAbort = () => {
    cancelled = true;
    controller.abort();
    rejectCancel(new ModelError("run cancelled", "aborted"));
  };
  callerSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await Promise.race([params.adapter.chat(params.request, controller.signal), timeoutGuard, cancelGuard]);
    return { outcome: "ok", response };
  } catch (err) {
    if (err instanceof ModelError && err.kind === "aborted") {
      return cancelled ? { outcome: "cancelled", error: err } : { outcome: "timeout", error: err };
    }
    if (err instanceof ModelError) return { outcome: "model_error", error: err };
    // Adapters are only supposed to throw ModelError (types.ts's own
    // contract) — wrapped defensively so a rogue throw still ends the run
    // cleanly as `model_error` instead of crashing the process.
    const message = err instanceof Error ? err.message : String(err);
    return { outcome: "model_error", error: new ModelError(message, "network") };
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onAbort);
  }
}
