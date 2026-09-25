import { toolDefinitionsForModel } from "../dispatchTools/invoke.js";
import { PROPOSE_DECISION_DEFINITION } from "./decision.js";
import type { ChatMessage, ToolDefinition } from "./types.js";

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
 *  plus the one terminal tool, which is not part of that registry. The set
 *  never changes turn to turn, so the loop builds it once per run. */
export function harnessToolDefinitions(): ToolDefinition[] {
  return [...toolDefinitionsForModel(), PROPOSE_DECISION_DEFINITION];
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

interface RawFeasibilityRow {
  driverId?: unknown;
  feasible?: unknown;
  score?: unknown;
  blockedReason?: unknown;
}

export interface FeasibilityRow {
  driverId: string;
  feasible: boolean;
  score: number | null;
  blockedReason: string | null;
}

/**
 * Every candidate row out of a raw `findFeasibleDrivers` result — feasible
 * AND blocked, unlike `baseline.ts`'s `feasibleIdsFromToolResult`, which
 * keeps only feasible ids for seeding the run's feasible set. The loop
 * attaches this onto that tool's OWN `tool_result` step payload (an optional
 * `feasibility` field, ignored by the UI on every other tool) so
 * `evidence.ts` can read reliable rows later without depending on the step's
 * 512-char `preview`. Logic is intentionally duplicated from
 * `feasibleIdsFromToolResult` rather than built on it: that function already
 * commits to returning only ids, and this file must not reach into Task 4's
 * baseline.ts for a second, differently-shaped parse of the same value.
 * Never throws — same defensive shape-checking, same reasoning.
 */
export function feasibilityRowsFromRawResult(value: unknown): FeasibilityRow[] {
  if (value === null || typeof value !== "object") return [];
  const candidates = (value as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return [];

  const rows: FeasibilityRow[] = [];
  for (const row of candidates as RawFeasibilityRow[]) {
    if (row == null || typeof row !== "object" || typeof row.driverId !== "string") continue;
    rows.push({
      driverId: row.driverId,
      feasible: row.feasible === true,
      score: typeof row.score === "number" ? row.score : null,
      blockedReason: typeof row.blockedReason === "string" ? row.blockedReason : null,
    });
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
