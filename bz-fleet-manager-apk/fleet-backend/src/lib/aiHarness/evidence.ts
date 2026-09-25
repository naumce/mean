import type { StoredStep } from "./runStore.js";
import type { Proposal } from "./decision.js";
import type { Baseline } from "./baseline.js";

// aiHarness/evidence.ts (Qwen Harness v0.1, Task 5): reconstructs what a run's
// proposal actually rests on, purely from its own persisted transcript — pure
// and DB-free so it can run inside the loop right after a proposal (fed the
// run's in-memory step log) and, unchanged, over any past run's
// `store.listSteps()` output later (a replay/re-evaluation tool, not built in
// v0.1). The step history is the source of truth; nothing here re-queries the
// database or re-asks the model.

export interface ToolCallCount {
  name: string;
  count: number;
}

export interface FeasibilitySeenRow {
  driverId: string;
  feasible: boolean;
  score: number | null;
  blockedReason: string | null;
  source: "baseline" | "tool";
}

export interface FactCited {
  text: string;
  forDriverId: string | null;
}

export interface Evidence {
  toolsCalled: ToolCallCount[];
  candidatesInspected: string[];
  feasibilitySeen: FeasibilitySeenRow[];
  metricsInspected: string[];
  historyInspected: string[];
  factsCited: FactCited[];
  supportingSteps: number[];
}

interface ToolCallPayloadLike {
  name?: unknown;
  arguments?: unknown;
}

interface ToolResultPayloadLike {
  name?: unknown;
  feasibility?: unknown;
}

interface FeasibilityRowLike {
  driverId?: unknown;
  feasible?: unknown;
  score?: unknown;
  blockedReason?: unknown;
}

function toolCallSteps(steps: StoredStep[]): StoredStep[] {
  return steps.filter((s) => s.kind === "tool_call");
}

function nameOf(payload: unknown): string | null {
  if (payload == null || typeof payload !== "object") return null;
  const name = (payload as ToolCallPayloadLike | ToolResultPayloadLike).name;
  return typeof name === "string" ? name : null;
}

function driverIdArgOf(payload: unknown): string | null {
  if (payload == null || typeof payload !== "object") return null;
  const args = (payload as ToolCallPayloadLike).arguments;
  if (args == null || typeof args !== "object") return null;
  const driverId = (args as Record<string, unknown>).driverId;
  return typeof driverId === "string" ? driverId : null;
}

/** First-seen order rather than sorted: evidence is meant to read like an
 *  investigation trail, not an arbitrary set. */
function dedupeInOrder(ids: string[]): string[] {
  return [...new Set(ids)];
}

function toolsCalledOf(steps: StoredStep[]): ToolCallCount[] {
  const counts = new Map<string, number>();
  for (const step of toolCallSteps(steps)) {
    const name = nameOf(step.payload);
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count }));
}

function driverIdsFromCallsNamed(steps: StoredStep[], toolName: string): string[] {
  const ids: string[] = [];
  for (const step of toolCallSteps(steps)) {
    if (nameOf(step.payload) !== toolName) continue;
    const id = driverIdArgOf(step.payload);
    if (id) ids.push(id);
  }
  return dedupeInOrder(ids);
}

/**
 * The `findFeasibleDrivers` rows loop.ts recorded onto its own `tool_result`
 * step payload (the `feasibility` field it adds for that one tool — see
 * loopMessages.ts's `feasibilityRowsFromRawResult`). NOT sourced from the
 * step's `preview`: that string is cut to 512 chars for compact display and
 * cannot be trusted to contain every row a real candidate list would have.
 */
function feasibilityRowsFromToolResultPayload(payload: unknown): FeasibilitySeenRow[] {
  if (payload == null || typeof payload !== "object") return [];
  const rows = (payload as ToolResultPayloadLike).feasibility;
  if (!Array.isArray(rows)) return [];

  const result: FeasibilitySeenRow[] = [];
  for (const row of rows as FeasibilityRowLike[]) {
    if (row == null || typeof row !== "object" || typeof row.driverId !== "string") continue;
    result.push({
      driverId: row.driverId,
      feasible: row.feasible === true,
      score: typeof row.score === "number" ? row.score : null,
      blockedReason: typeof row.blockedReason === "string" ? row.blockedReason : null,
      source: "tool",
    });
  }
  return result;
}

function feasibilitySeenOf(steps: StoredStep[], baseline: Baseline | null): FeasibilitySeenRow[] {
  const fromBaseline: FeasibilitySeenRow[] = baseline
    ? baseline.candidates.map((c) => ({
        driverId: c.driverId,
        feasible: c.feasible,
        score: c.score,
        blockedReason: c.blockedReason,
        source: "baseline" as const,
      }))
    : [];
  const fromTools = steps
    .filter((s) => s.kind === "tool_result" && nameOf(s.payload) === "findFeasibleDrivers")
    .flatMap((s) => feasibilityRowsFromToolResultPayload(s.payload));
  return [...fromBaseline, ...fromTools];
}

function candidatesInspectedOf(steps: StoredStep[], feasibilitySeen: FeasibilitySeenRow[]): string[] {
  const fromArgs = toolCallSteps(steps)
    .map((s) => driverIdArgOf(s.payload))
    .filter((id): id is string => id !== null);
  const fromFeasibility = feasibilitySeen.map((r) => r.driverId);
  return dedupeInOrder([...fromArgs, ...fromFeasibility]);
}

function factsCitedOf(proposal: Proposal): FactCited[] {
  return [
    { text: proposal.reason, forDriverId: proposal.driverId },
    ...proposal.alternatives.map((a) => ({ text: a.reason, forDriverId: a.driverId })),
  ];
}

/**
 * Seqs of every `tool_result` step whose FULL content mentions the proposed
 * driver — never the persisted `preview`, which is deliberately cut to 512
 * chars for the transcript view and so cannot be trusted for a substring
 * search on anything longer. `contentsBySeq` is how the caller supplies that
 * full content: loop.ts keeps it in memory for exactly this call, since
 * neither `AiRunStep.payload` nor `StoredStep` retains more than the preview.
 */
function supportingStepsOf(steps: StoredStep[], proposal: Proposal, contentsBySeq: Map<number, string>): number[] {
  if (proposal.driverId === null) return [];
  const seqs: number[] = [];
  for (const step of steps) {
    if (step.kind !== "tool_result") continue;
    const content = contentsBySeq.get(step.seq);
    if (content && content.includes(proposal.driverId)) seqs.push(step.seq);
  }
  return seqs;
}

/**
 * Reconstructs a proposal's evidence from `steps` alone (plus the baseline
 * snapshot captured at run start): which tools ran and how often, which
 * driver ids were actually inspected, every feasibility row the run saw (from
 * the baseline and/or from `findFeasibleDrivers` calls), which drivers had
 * their metrics/history looked up, the facts the proposal itself cites, and
 * which tool results actually back the recommended driver.
 *
 * `contentsBySeq` is the run's full (untruncated) tool-result contents keyed
 * by step seq: `supportingSteps` needs the FULL content to search reliably,
 * and the persisted step only keeps a 512-char preview.
 */
export function collectEvidence(
  steps: StoredStep[],
  proposal: Proposal,
  baseline: Baseline | null,
  contentsBySeq: Map<number, string>,
): Evidence {
  const feasibilitySeen = feasibilitySeenOf(steps, baseline);
  return {
    toolsCalled: toolsCalledOf(steps),
    candidatesInspected: candidatesInspectedOf(steps, feasibilitySeen),
    feasibilitySeen,
    metricsInspected: driverIdsFromCallsNamed(steps, "getDriverMetrics"),
    historyInspected: driverIdsFromCallsNamed(steps, "getDriverHistory"),
    factsCited: factsCitedOf(proposal),
    supportingSteps: supportingStepsOf(steps, proposal, contentsBySeq),
  };
}
