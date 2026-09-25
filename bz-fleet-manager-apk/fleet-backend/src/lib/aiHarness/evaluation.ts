import { prisma } from "../../db.js";
import type { RunStatus, RunStats } from "./loop.js";
import type { Baseline } from "./baseline.js";
import type { Proposal } from "./decision.js";
import {
  fetchDriverNames,
  fetchScenarios,
  humanVerdictOf,
  loadRefOfContext,
  type RunScenario,
} from "./runView.js";

// aiHarness/evaluation.ts (Qwen Harness v0.1, Task 6): a pure read-side
// mapping over one experiment's runs — how often Qwen agreed with the
// deterministic ⚡Suggest baseline, how a dispatcher verdicted each run, and
// the loop-effort numbers (turns/tool calls/latency) per run and averaged.
// Nothing here writes; nothing here re-runs anything. The step transcript is
// not read at all — everything here comes off AiDecisionRecord's own columns
// (baseline/proposedDecision/stats/humanDecision), the same source
// runView.ts's RunDetail reads for a single run.

interface EvaluationPick { driverId: string; name: string | null }

export interface EvaluationRow {
  runId: string;
  loadId: string | null;
  loadRef: string | null;
  scenario: RunScenario | null;
  status: RunStatus;
  terminationReason: string | null;
  deterministicTop: EvaluationPick | null;
  deterministicRankOfPick: number | null;
  pick: { driverId: string | null; name: string | null } | null;
  confidence: number | null;
  humanVerdict: string | null;
  humanDriverId: string | null;
  matchesDeterministicTop: boolean | null;
  turns: number;
  toolCalls: number;
  uniqueTools: number;
  repeatedCalls: number;
  invalidCalls: number;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  startedAt: string | null;
}

export interface EvaluationSummary {
  runs: number;
  byTermination: Record<string, number>;
  proposed: number;
  matchedDeterministicTop: number;
  accepted: number;
  rejected: number;
  meanTurns: number | null;
  meanToolCalls: number | null;
  meanLatencyMs: number | null;
}

export interface Evaluation {
  experimentId: string;
  rows: EvaluationRow[];
  summary: EvaluationSummary;
}

/** 1-based position of `driverId` in the baseline's own candidate order (not
 *  just its feasible ones — "where did the deterministic engine rank this
 *  driver at all"). Null when there is no pick, no baseline, or the pick's
 *  driver never appeared in the baseline's candidate list. */
function deterministicRankOf(baseline: Baseline | null, driverId: string | null): number | null {
  if (!baseline || driverId === null) return null;
  const index = baseline.candidates.findIndex((c) => c.driverId === driverId);
  return index === -1 ? null : index + 1;
}

function toRow(
  record: {
    id: string;
    loadId: string | null;
    context: unknown;
    status: string;
    terminationReason: string | null;
    baseline: unknown;
    proposedDecision: unknown;
    confidence: number | null;
    humanDecision: unknown;
    stats: unknown;
    startedAt: Date | null;
  },
  driverNames: Map<string, string>,
  scenarios: Map<string, RunScenario | null>,
): EvaluationRow {
  const baseline = record.baseline as unknown as Baseline | null;
  const proposal = record.proposedDecision as unknown as Proposal | null;
  const stats = record.stats as unknown as RunStats | null;
  const human = humanVerdictOf(record.humanDecision);

  const deterministicTop: EvaluationPick | null = baseline?.topFeasibleDriverId
    ? { driverId: baseline.topFeasibleDriverId, name: driverNames.get(baseline.topFeasibleDriverId) ?? null }
    : null;
  const pick = proposal
    ? { driverId: proposal.driverId, name: proposal.driverId ? driverNames.get(proposal.driverId) ?? null : null }
    : null;
  // Null strictly means "nothing to compare" (no proposal yet, or no
  // baseline at all) — a proposal that explicitly recommends no driver
  // (`pick.driverId === null`) against a baseline that DOES have a top is a
  // real, reportable mismatch (false), not a missing comparison.
  const matchesDeterministicTop = pick && deterministicTop ? pick.driverId === deterministicTop.driverId : null;

  return {
    runId: record.id,
    loadId: record.loadId,
    loadRef: loadRefOfContext(record.context),
    scenario: record.loadId ? scenarios.get(record.loadId) ?? null : null,
    status: record.status as RunStatus,
    terminationReason: record.terminationReason,
    deterministicTop,
    deterministicRankOfPick: deterministicRankOf(baseline, pick?.driverId ?? null),
    pick,
    confidence: record.confidence,
    humanVerdict: human?.verdict ?? null,
    humanDriverId: human?.driverId ?? null,
    matchesDeterministicTop,
    turns: stats?.modelCalls ?? 0,
    toolCalls: stats?.toolCalls ?? 0,
    uniqueTools: stats?.uniqueTools ?? 0,
    repeatedCalls: stats?.repeatedCalls ?? 0,
    invalidCalls: stats?.invalidCalls ?? 0,
    latencyMs: stats?.durationMs ?? null,
    promptTokens: stats?.promptTokens ?? null,
    completionTokens: stats?.completionTokens ?? null,
    startedAt: record.startedAt ? record.startedAt.toISOString() : null,
  };
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function summarize(rows: EvaluationRow[]): EvaluationSummary {
  const byTermination: Record<string, number> = {};
  for (const row of rows) {
    if (row.terminationReason === null) continue;
    byTermination[row.terminationReason] = (byTermination[row.terminationReason] ?? 0) + 1;
  }

  // Effort/latency means are only meaningful over runs that actually reached
  // a proposal — an incomplete/failed/cancelled run's turn count reflects why
  // it stopped, not how much effort a normal run takes, and averaging it in
  // would understate the real cost of the runs that succeeded.
  const proposedRows = rows.filter((r) => r.status === "proposed");

  return {
    runs: rows.length,
    byTermination,
    proposed: proposedRows.length,
    matchedDeterministicTop: rows.filter((r) => r.matchesDeterministicTop === true).length,
    accepted: rows.filter((r) => r.humanVerdict === "accept").length,
    rejected: rows.filter((r) => r.humanVerdict === "reject").length,
    meanTurns: mean(proposedRows.map((r) => r.turns)),
    meanToolCalls: mean(proposedRows.map((r) => r.toolCalls)),
    meanLatencyMs: mean(proposedRows.map((r) => r.latencyMs).filter((v): v is number => v !== null)),
  };
}

/**
 * Every run belonging to `experimentId` (newest first, matching every other
 * run listing in this feature), mapped to one EvaluationRow each, plus the
 * summary rolled up from them. Null when the experiment does not exist or
 * belongs to another org — the same "caller passes a concrete orgId, this
 * function 404s a mismatch by returning null" convention suggestForLoad.ts
 * and captureBaseline already use.
 */
export async function evaluateExperiment(orgId: string, experimentId: string): Promise<Evaluation | null> {
  const experiment = await prisma.aiExperiment.findUnique({ where: { id: experimentId } });
  if (!experiment || experiment.orgId !== orgId) return null;

  const records = await prisma.aiDecisionRecord.findMany({
    where: { experimentId },
    orderBy: { proposedAt: "desc" },
  });

  const driverIds = records.flatMap((r) => {
    const baseline = r.baseline as unknown as Baseline | null;
    const proposal = r.proposedDecision as unknown as Proposal | null;
    const human = humanVerdictOf(r.humanDecision);
    return [baseline?.topFeasibleDriverId ?? null, proposal?.driverId ?? null, human?.driverId ?? null];
  });
  const [driverNames, scenarios] = await Promise.all([
    fetchDriverNames(driverIds, orgId),
    fetchScenarios(records.map((r) => r.loadId), orgId),
  ]);

  const rows = records.map((r) => toRow(r, driverNames, scenarios));

  return { experimentId, rows, summary: summarize(rows) };
}
