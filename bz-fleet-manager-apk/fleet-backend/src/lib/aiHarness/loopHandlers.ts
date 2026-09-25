import type { ChatMessage, ModelAdapter, ToolCall, ToolDefinition } from "./types.js";
import type { HarnessConfig } from "./config.js";
import { serializeToolResult, canonicalArgs } from "./serialize.js";
import { PROPOSE_DECISION_NAME, validateProposal, type Proposal } from "./decision.js";
import { feasibleIdsFromToolResult, type Baseline } from "./baseline.js";
import { DISPATCH_PROMPT_V1 } from "./prompts/dispatch-v1.js";
import type { invokeTool } from "../dispatchTools/invoke.js";
import type { RunStore, StepKind, StoredStep, ToolCallSummary, ToolResultSummary } from "./runStore.js";
import { collectEvidence } from "./evidence.js";
import { statusForTermination, callModel } from "./loopGuards.js";
import { toolResultMessage, failureContent, failuresContent, feasibilityRowsFromProjectedResult, sumTokens, maxToken, KEEP_ALIVE } from "./loopMessages.js";
import type { RunStatus, TerminationReason, RunStats, RunOutcome } from "./loop.js";

// aiHarness/loopHandlers.ts (Qwen Harness v0.1): the
// per-concern pieces of the agent loop — one model turn, one propose_decision
// attempt, one other tool call, and ending the run — extracted out of
// loop.ts's `runDispatchDecision` so that function reads as orchestration
// (which handler runs next) rather than a single 300-line body. Every
// counter/accumulator a run carries lives on one `RunState` object passed by
// reference; `RunContext` is the read-only configuration/dependencies each
// handler needs. `persistStep` stays a closure in loop.ts (it needs `onStep`
// and the store's own decisionId) and is passed in explicitly.

/** Everything a run accumulates turn to turn — one instance per run, mutated
 *  in place by whichever handler is running (no handler ever receives a
 *  COPY, so a mutation here is always visible to the next call). */
export interface RunState {
  baseline: Baseline | null;
  messages: ChatMessage[];
  feasibleSet: Set<string>;
  repeatedCallMap: Map<string, number>;
  contentsBySeq: Map<number, string>;
  successfulToolNames: Set<string>;
  toolCallSummaries: ToolCallSummary[];
  toolResultSummaries: ToolResultSummary[];
  stepLog: StoredStep[];
  modelCalls: number;
  toolCallsCount: number;
  repeatedCount: number;
  invalidCount: number;
  consecutiveInvalid: number;
  bytesUsed: number;
  promptTokens: number | null;
  completionTokens: number | null;
  /** The highest single call's `promptTokens` seen so far (I3) — see
   *  `RunStats.maxPromptTokens`'s own doc comment in loop.ts for why this is
   *  tracked separately from the running `promptTokens` sum above. */
  maxPromptTokens: number | null;
  nudgeCount: number;
}

export function createRunState(initialMessages: ChatMessage[]): RunState {
  return {
    baseline: null,
    messages: initialMessages,
    feasibleSet: new Set<string>(),
    repeatedCallMap: new Map<string, number>(),
    contentsBySeq: new Map<number, string>(),
    successfulToolNames: new Set<string>(),
    toolCallSummaries: [],
    toolResultSummaries: [],
    stepLog: [],
    modelCalls: 0,
    toolCallsCount: 0,
    repeatedCount: 0,
    invalidCount: 0,
    consecutiveInvalid: 0,
    bytesUsed: 0,
    promptTokens: null,
    completionTokens: null,
    maxPromptTokens: null,
    nudgeCount: 0,
  };
}

/** Read-only for the run's whole lifetime (never reassigned by a handler) —
 *  everything a handler needs to know about WHERE it's running and WHAT it
 *  may call, as opposed to `RunState`'s WHAT HAS HAPPENED SO FAR. */
export interface RunContext {
  orgId: string;
  loadId: string;
  decisionId: string;
  config: HarnessConfig;
  adapter: ModelAdapter;
  tools: ToolDefinition[];
  invoke: typeof invokeTool;
  now: () => number;
  deadlineAtMs: number;
  signal?: AbortSignal;
  store: RunStore;
  startedAtMs: number;
  onStatus: (status: RunStatus) => void;
}

export type PersistStepFn = (
  kind: StepKind,
  name: string | null,
  payload: unknown,
  durationMs?: number | null,
) => Promise<StoredStep>;

export type AssistantTurnResult =
  | { kind: "aborted"; reason: "timeout" | "cancelled" | "model_error"; errorKind: string; errorMessage: string }
  | { kind: "nudged" }
  | { kind: "no_decision" }
  | { kind: "tool_calls"; toolCalls: ToolCall[] };

/**
 * One full turn: race the model call, persist thinking/assistant, replay the
 * turn into `state.messages`, then decide what the caller does next — abort
 * (the call itself failed), nudge and continue, end as `no_decision` (this is
 * the second content-only answer in a row), or hand back the tool calls to
 * process. Never persists a step past what `loop.ts`'s own deadline/cancel
 * pre-checks already allowed to start.
 */
export async function handleAssistantTurn(
  state: RunState,
  ctx: RunContext,
  persistStep: PersistStepFn,
): Promise<AssistantTurnResult> {
  state.modelCalls += 1;
  const callStartedAtMs = ctx.now();
  const callOutcome = await callModel({
    adapter: ctx.adapter,
    request: {
      model: ctx.config.model,
      messages: state.messages,
      tools: ctx.tools,
      think: ctx.config.think,
      temperature: ctx.config.temperature,
      numCtx: ctx.config.numCtx,
      keepAlive: KEEP_ALIVE,
    },
    now: ctx.now,
    deadlineAtMs: ctx.deadlineAtMs,
    callTimeoutMs: ctx.config.modelCallTimeoutMs,
    callerSignal: ctx.signal,
  });

  if (callOutcome.outcome !== "ok") {
    return { kind: "aborted", reason: callOutcome.outcome, errorKind: callOutcome.error.kind, errorMessage: callOutcome.error.message };
  }

  const response = callOutcome.response;
  const callDurationMs = ctx.now() - callStartedAtMs;
  state.promptTokens = sumTokens(state.promptTokens, response.stats.promptTokens);
  state.completionTokens = sumTokens(state.completionTokens, response.stats.completionTokens);
  state.maxPromptTokens = maxToken(state.maxPromptTokens, response.stats.promptTokens);

  // Truthy, not "!== undefined": an empty string carries no thinking worth a
  // step, even though `ChatMessage.thinking` technically allows one.
  if (response.message.thinking) {
    await persistStep("thinking", null, { text: response.message.thinking });
  }

  const toolCalls = response.message.toolCalls ?? [];
  await persistStep(
    "assistant",
    null,
    {
      content: response.message.content,
      toolCalls: toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
      stats: response.stats,
      doneReason: response.doneReason,
    },
    callDurationMs,
  );

  // Passed through exactly as the adapter delivered it, EXCEPT `thinking`
  // (I3): the spec treats thinking as display-only, but replaying it back on
  // every later call was never free — it cost 0.5-2k tokens a turn and grew
  // with each one, materially shrinking how many real turns fit in
  // `config.numCtx` before Ollama starts silently dropping history. Dropping
  // it here changes nothing about how the run proceeds (thinking already
  // never drove control flow), and it is still persisted as its own step
  // above for the transcript/UI.
  state.messages = [
    ...state.messages,
    {
      role: "assistant",
      content: response.message.content,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    },
  ];

  if (toolCalls.length === 0) {
    if (state.nudgeCount === 0) {
      state.nudgeCount += 1;
      await persistStep("nudge", null, { content: DISPATCH_PROMPT_V1.nudge });
      state.messages = [...state.messages, { role: "user", content: DISPATCH_PROMPT_V1.nudge }];
      return { kind: "nudged" };
    }
    return { kind: "no_decision" };
  }

  return { kind: "tool_calls", toolCalls };
}

export type ProposeCallResult = { kind: "proposed"; proposal: Proposal } | { kind: "rejected" };

/** One `propose_decision` attempt: valid ends the run (the caller persists no
 *  further steps for this message — `ignoredCalls` already recorded what was
 *  skipped); invalid is persisted as a `tool_result` and answered back to the
 *  model so it can correct itself within its remaining turns. */
export async function handleProposeCall(
  call: ToolCall,
  ignoredCalls: ToolCall[],
  state: RunState,
  ctx: RunContext,
  persistStep: PersistStepFn,
): Promise<ProposeCallResult> {
  // every propose_decision ATTEMPT — accepted or rejected — gets its own
  // `tool_call` step first, stamped at request time. Before this, a rejected
  // attempt's own arguments (the reason/confidence/alternatives actually
  // being turned down) existed nowhere on the timeline except inside the
  // model's own `assistant` step payload; a developer reading the run had no
  // single place to see "this is the call that got rejected."
  await persistStep("tool_call", PROPOSE_DECISION_NAME, { name: PROPOSE_DECISION_NAME, arguments: call.arguments });

  const check = await validateProposal(call.arguments, { orgId: ctx.orgId, feasibleDriverIds: state.feasibleSet });
  if (check.ok) {
    await persistStep("final", PROPOSE_DECISION_NAME, {
      proposal: check.proposal,
      ...(ignoredCalls.length > 0 ? { ignoredCalls } : {}),
    });
    return { kind: "proposed", proposal: check.proposal };
  }

  state.invalidCount += 1;
  state.consecutiveInvalid += 1;
  const content = failuresContent(check.errors);
  const resultStep = await persistStep("tool_result", PROPOSE_DECISION_NAME, { name: PROPOSE_DECISION_NAME, ok: false, errors: check.errors });
  state.contentsBySeq.set(resultStep.seq, content);
  state.toolResultSummaries = [...state.toolResultSummaries, { seq: resultStep.seq, name: PROPOSE_DECISION_NAME, ok: false, truncated: false }];
  state.messages = [...state.messages, toolResultMessage(PROPOSE_DECISION_NAME, content)];
  return { kind: "rejected" };
}

/**
 * One non-`propose_decision` call: repeated (not executed, error names the
 * earlier result), invalid/erroring (`invokeTool`'s own `ok: false`), or a
 * real success — each branch persists its own step(s), updates `state`'s
 * counters/history, and (only on a genuinely new success) may widen the
 * run's feasible set. Never itself decides to end the run — the caller
 * checks the deadline and the caps after this returns.
 */
export async function handleToolCall(call: ToolCall, state: RunState, ctx: RunContext, persistStep: PersistStepFn): Promise<void> {
  // the `tool_call` step is persisted for EVERY call the model makes —
  // unknown tool, invalid params, and an identical repeat included — stamped
  // BEFORE the repeated-call check or invokeTool ever runs (request wall
  // time, not the time the result happened to come back). Before this, only
  // a call that actually succeeded got a `tool_call` step at all, so exactly
  // the calls a developer most needs to inspect (the ones that went wrong)
  // had their own arguments visible nowhere but the model's `assistant` step.
  const callStep = await persistStep("tool_call", call.name, { name: call.name, arguments: call.arguments });

  const key = `${call.name}:${canonicalArgs(call.arguments)}`;
  const seenAtSeq = state.repeatedCallMap.get(key);
  if (seenAtSeq !== undefined) {
    state.repeatedCount += 1;
    state.invalidCount += 1;
    state.consecutiveInvalid += 1;
    const error = `identical call already made; reuse the earlier result (step ${seenAtSeq})`;
    const content = failureContent(error);
    const resultStep = await persistStep("tool_result", call.name, { name: call.name, ok: false, error });
    state.contentsBySeq.set(resultStep.seq, content);
    state.toolResultSummaries = [...state.toolResultSummaries, { seq: resultStep.seq, name: call.name, ok: false, truncated: false }];
    state.messages = [...state.messages, toolResultMessage(call.name, content)];
    return;
  }

  const invokeStartedAtMs = ctx.now();
  const invokeResult = await ctx.invoke(ctx.orgId, call.name, call.arguments);
  const invokeDurationMs = ctx.now() - invokeStartedAtMs;

  if (!invokeResult.ok) {
    state.invalidCount += 1;
    state.consecutiveInvalid += 1;
    const content = failureContent(invokeResult.error);
    const resultStep = await persistStep("tool_result", call.name, { name: call.name, ok: false, error: invokeResult.error }, invokeDurationMs);
    state.contentsBySeq.set(resultStep.seq, content);
    state.toolResultSummaries = [...state.toolResultSummaries, { seq: resultStep.seq, name: call.name, ok: false, truncated: false }];
    state.messages = [...state.messages, toolResultMessage(call.name, content)];
    return;
  }

  // The per-result truncation ceiling is serializeToolResult's OWN default
  // (8192 bytes, spec §4) — never config.maxToolResultBytes, which is the
  // loop's separate, cumulative cap (bytesUsed below), checked once per call
  // across the whole run rather than the size of any one result.
  const serialized = serializeToolResult(invokeResult.value);
  state.toolCallSummaries = [...state.toolCallSummaries, { seq: callStep.seq, name: call.name }];

  // Only findFeasibleDrivers gets this extra field: it is the one tool whose
  // result evidence.ts must read back reliably later, and the preview alone
  // (cut to 512 chars) cannot be trusted for that on anything but a tiny
  // candidate list. `invokeResult.value` here is already the MODEL-FACING
  // projected shape (dispatchTools/invoke.ts), the same one just serialized
  // above — so this reports exactly the rows the model was shown, capped at
  // 25 feasible/25 blocked, never the engine's full candidate list (I2).
  const feasibility = call.name === "findFeasibleDrivers" ? feasibilityRowsFromProjectedResult(invokeResult.value) : undefined;
  const resultStep = await persistStep(
    "tool_result",
    call.name,
    {
      name: call.name,
      ok: true,
      truncated: serialized.truncated,
      originalSize: serialized.originalSize,
      returnedSize: serialized.returnedSize,
      preview: serialized.content.slice(0, 512),
      ...(feasibility ? { feasibility } : {}),
    },
    invokeDurationMs,
  );
  state.contentsBySeq.set(resultStep.seq, serialized.content);
  state.toolResultSummaries = [...state.toolResultSummaries, { seq: resultStep.seq, name: call.name, ok: true, truncated: serialized.truncated }];
  state.messages = [...state.messages, toolResultMessage(call.name, serialized.content)];

  state.repeatedCallMap.set(key, resultStep.seq);
  state.toolCallsCount += 1;
  state.bytesUsed += serialized.returnedSize;
  state.successfulToolNames.add(call.name);
  // Gated on THIS run's own loadId: a findFeasibleDrivers call the model
  // makes about a DIFFERENT load must never widen the terminal guard here —
  // that would let a driver infeasible for this load slip past
  // validateProposal's feasibility check.
  if (call.name === "findFeasibleDrivers" && call.arguments.loadId === ctx.loadId) {
    for (const id of feasibleIdsFromToolResult(invokeResult.value)) state.feasibleSet.add(id);
  }
  // Only a successful, non-repeated real tool call counts as "progress" —
  // every other branch above already left this alone.
  state.consecutiveInvalid = 0;
}

/**
 * Computes the run's final stats/evidence and writes the terminal
 * `updateRun` — the one place every exit from `runDispatchDecision` ends up,
 * whether via a proposal, a cap, or an abnormal stop `loop.ts`'s own
 * `abortRun`/`handleUnexpectedError` closures route through this.
 */
export async function finalizeRun(
  state: RunState,
  ctx: RunContext,
  terminationReason: TerminationReason,
  proposal: Proposal | null,
  errorMessage: string | null = null,
): Promise<RunOutcome> {
  const finishedAtMs = ctx.now();
  // 85% of this run's OWN numCtx (not a fixed byte count) — a smaller
  // experiment config has a proportionally smaller cushion before Ollama
  // starts silently dropping history, so the pressure threshold has to scale
  // with it too.
  const contextPressure = state.maxPromptTokens !== null && state.maxPromptTokens > ctx.config.numCtx * 0.85;
  const stats: RunStats = {
    modelCalls: state.modelCalls,
    toolCalls: state.toolCallsCount,
    uniqueTools: state.successfulToolNames.size,
    repeatedCalls: state.repeatedCount,
    invalidCalls: state.invalidCount,
    promptTokens: state.promptTokens,
    completionTokens: state.completionTokens,
    maxPromptTokens: state.maxPromptTokens,
    contextPressure,
    durationMs: finishedAtMs - ctx.startedAtMs,
  };
  const status = statusForTermination(terminationReason);
  // Evidence is only meaningful once there is something to justify — every
  // other termination leaves AiDecisionRecord.evidence untouched (still null
  // from row creation) rather than writing an empty shell.
  const evidence = proposal ? collectEvidence(state.stepLog, proposal, state.baseline, state.contentsBySeq) : null;

  await ctx.store.updateRun(ctx.decisionId, {
    status,
    terminationReason,
    completedAt: new Date(finishedAtMs),
    stats,
    toolCalls: state.toolCallSummaries,
    toolResults: state.toolResultSummaries,
    ...(errorMessage !== null ? { error: errorMessage } : {}),
    ...(evidence ? { evidence } : {}),
    ...(proposal
      ? { proposedDecision: proposal, reason: proposal.reason, confidence: proposal.confidence, driverId: proposal.driverId }
      : {}),
  });
  ctx.onStatus(status);

  return { status, terminationReason, proposal, stats };
}
