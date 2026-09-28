import { toolDefinitionsForModel } from "../dispatchTools/invoke.js";
import type { ChatMessage, ToolDefinition } from "./types.js";
// Type-only: RunState is DEFINED in loopHandlers.ts, which imports VALUES
// from this file — a type-only import back never creates a runtime cycle
// (erased at compile time), the same convention loop.ts/loopGuards.ts and
// loop.ts/loopHandlers.ts already use for their own back-references.
import type { RunState } from "./loopHandlers.js";

// aiHarness/loopMessages.ts (Qwen Harness v0.1, Task 5): the small, pure
// pieces of loop.ts that shape a `ChatMessage` or a raw tool value rather than
// decide what happens next — split out so loop.ts itself reads as the turn/
// cap-checked-call algorithm, not a mix of control flow and formatting.

/**
 * Keeps Ollama's model resident in memory for 10 minutes after this run's
 * last call (spec-fixed value) — cuts cold-start latency for the run's own
 * next turn and for a back-to-back run against the same experiment. Not a
 * `HarnessConfig` field: like `numCtx`, it is an Ollama transport knob rather
 * than a decision-quality one (see ollamaAdapter.ts's own header comment on
 * `keepAlive`), and v0.1 ships exactly one adapter, so there is nowhere else
 * this needs to vary.
 */
export const KEEP_ALIVE = "10m";

/** The tools every turn offers the model: the 17 read-only dispatch tools
 *  plus `terminalDefinition` (the resolved `PromptProfile`'s own terminal
 *  schema — prompts/index.ts), which is not part of that registry. The set
 *  never changes turn to turn, so the loop builds it once per run. */
export function harnessToolDefinitions(terminalDefinition: ToolDefinition): ToolDefinition[] {
  return [...toolDefinitionsForModel(), terminalDefinition];
}

/** One handled tool call's answer, addressed back to the model by name — a
 *  turn can make more than one call, so the model needs `toolName` to tell
 *  results apart the same way it would on history replay. */
export function toolResultMessage(name: string, content: string): ChatMessage {
  return { role: "tool", content, toolName: name };
}

/** The wire content for a single-reason failure (an unknown tool, bad
 *  arguments, a tool that threw, or a repeated call) — both the `tool`
 *  message's content and, verbatim, what `evidence.ts` later searches via
 *  `contentsBySeq`. */
export function failureContent(error: string): string {
  return JSON.stringify({ ok: false, error });
}

/** Same as `failureContent`, for `propose_decision`'s multi-error shape
 *  (`validateProposal` can report several problems on one attempt). */
export function failuresContent(errors: string[]): string {
  return JSON.stringify({ ok: false, errors });
}

/**
 * The shared tail of every "this call did not succeed" branch in
 * loopHandlers.ts's `handleToolCall`/`handleProposeCall` (a repeated call, an
 * `invokeTool` failure, or a rejected `propose_decision`): key the failing
 * content by this step's own seq (for `evidence.ts`'s later substring
 * search), record the `ok: false` summary row, and replay the same content
 * back to the model as its own `tool` message. Only `persistStep` itself
 * (the actual write + its returned seq) stays in loopHandlers.ts — this is
 * everything after it, shared by every failed-result path.
 */
export function recordFailedResult(state: RunState, seq: number, name: string, content: string): void {
  state.contentsBySeq.set(seq, content);
  state.toolResultSummaries = [...state.toolResultSummaries, { seq, name, ok: false, truncated: false }];
  state.messages = [...state.messages, toolResultMessage(name, content)];
}

interface ProjectedFeasibleRowLike {
  driverId?: unknown;
  score?: unknown;
}

interface ProjectedBlockedRowLike {
  driverId?: unknown;
  blockedReason?: unknown;
}

export interface FeasibilityRow {
  driverId: string;
  feasible: boolean;
  score: number | null;
  blockedReason: string | null;
}

/**
 * Every candidate row out of a `findFeasibleDrivers` call's MODEL-FACING
 * result (`dispatchTools/invoke.ts`'s `projectForModel` compact shape) —
 * feasible AND blocked, unlike `baseline.ts`'s `feasibleIdsFromToolResult`,
 * which keeps only feasible ids for seeding the run's feasible set. this
 * reads the PROJECTED `{ feasible: [...], blocked: [...] }` shape (already
 * capped at 25 rows each), not the engine's raw, unbounded `candidates` array
 * — the loop attaches whatever comes back onto that tool's own `tool_result`
 * step payload (an optional `feasibility` field, ignored by the UI on every
 * other tool) so `evidence.ts` reports exactly the rows the model actually
 * saw, never the full engine result. Never throws: anything not shaped like
 * `{ feasible: [...], blocked: [...] }`, or whose rows are not shaped like
 * `{ driverId: string }`, is simply skipped.
 */
export function feasibilityRowsFromProjectedResult(value: unknown): FeasibilityRow[] {
  if (value === null || typeof value !== "object") return [];
  const feasible = (value as { feasible?: unknown }).feasible;
  const blocked = (value as { blocked?: unknown }).blocked;

  const rows: FeasibilityRow[] = [];
  if (Array.isArray(feasible)) {
    for (const row of feasible as ProjectedFeasibleRowLike[]) {
      if (row == null || typeof row !== "object" || typeof row.driverId !== "string") continue;
      rows.push({ driverId: row.driverId, feasible: true, score: typeof row.score === "number" ? row.score : null, blockedReason: null });
    }
  }
  if (Array.isArray(blocked)) {
    for (const row of blocked as ProjectedBlockedRowLike[]) {
      if (row == null || typeof row !== "object" || typeof row.driverId !== "string") continue;
      rows.push({
        driverId: row.driverId,
        feasible: false,
        score: null,
        blockedReason: typeof row.blockedReason === "string" ? row.blockedReason : null,
      });
    }
  }
  return rows;
}

/** Accumulates a run-level token total across turns: `null` means "no call so
 *  far reported this field" (never guessed as 0), and a `null` from one more
 *  call leaves the running total exactly as it was rather than resetting it —
 *  one silent provider on one turn must not erase every prior turn's count. */
export function sumTokens(current: number | null, addition: number | null): number | null {
  if (addition === null) return current;
  return (current ?? 0) + addition;
}

/** Tracks the HIGHEST single-call value seen so far (`stats.maxPromptTokens`
 *  is a per-call watermark, not the `sumTokens` running total) — same `null`
 *  convention as `sumTokens`: "no call so far reported this field" stays
 *  `null` rather than losing to a guessed `0`, and a later `null` never
 *  overwrites an already-known maximum. */
export function maxToken(current: number | null, candidate: number | null): number | null {
  if (candidate === null) return current;
  return current === null ? candidate : Math.max(current, candidate);
}
