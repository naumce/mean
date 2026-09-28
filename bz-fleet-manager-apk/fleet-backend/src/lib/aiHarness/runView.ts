import { prisma } from "../../db.js";
import type { AiDecisionRecord, Prisma } from "@prisma/client";
import type { HarnessConfig } from "./config.js";
import type { RunStatus, RunStats } from "./loop.js";
import type { Baseline } from "./baseline.js";
import type { Proposal } from "./decision.js";
import type { Evidence } from "./evidence.js";

// aiHarness/runView.ts (Qwen Harness v0.1, Task 6): read-side shaping shared
// by dispatcherAi.ts/dispatcherAiRuns.ts (the HTTP responses) and
// evaluation.ts (the analysis table) — one place that turns a raw
// AiDecisionRecord's JSON columns into the wire shapes both consumers agree
// on, so a RunSummary built for a list and the same run's numbers inside an
// Evaluation row never drift apart. Pure/DB-read-only: nothing here writes.

export interface RunScenario { code: string; title: string; hint: string }

export interface HumanDecision {
  verdict: "accept" | "reject" | "other";
  driverId: string | null;
  note: string | null;
  byDispatcherId: string | null;
}

export interface RunSummary {
  id: string;
  loadId: string | null;
  loadRef: string | null;
  scenario: RunScenario | null;
  status: RunStatus;
  terminationReason: string | null;
  driverId: string | null;
  driverName: string | null;
  confidence: number | null;
  humanVerdict: string | null;
  /** Snapshotted at enqueue from the experiment's own value (runner.ts) — an
   *  experiment whose promptVersion later changes (dispatcherAi.ts's PATCH,
   *  gated to zero runs) never rewrites an already-queued/finished row, so a
   *  run list can show a mix of prompts across one experiment's history. */
  promptVersion: string | null;
  stats: RunStats | null;
  startedAt: string;
  completedAt: string | null;
  parentRunId: string | null;
}

export interface RunDetail extends RunSummary {
  experimentId: string;
  kind: string;
  modelConfig: HarnessConfig | null;
  promptVersion: string | null;
  baseline: Baseline | null;
  evidence: Evidence | null;
  proposedDecision: Proposal | null;
  reason: string | null;
  humanDecision: HumanDecision | null;
  decidedAt: string | null;
  error: string | null;
}

/** Same defensive parse dispatcherLoadboard.ts's scenarioHintOf uses for
 *  Load.extras — untyped JSON at the schema level, so a malformed or foreign
 *  shape reads as "no scenario" rather than throwing. Duplicated rather than
 *  imported: that function is not exported (route-local), and this is the
 *  harness's own read of the same convention, not a caller of that route. */
export function scenarioOf(extras: unknown): RunScenario | null {
  if (!extras || typeof extras !== "object") return null;
  const scenario = (extras as Record<string, unknown>).scenario;
  if (!scenario || typeof scenario !== "object") return null;
  const { code, title, hint } = scenario as Record<string, unknown>;
  if (typeof code !== "string" || typeof title !== "string" || typeof hint !== "string") return null;
  return { code, title, hint };
}

/** `AiDecisionRecord.context`'s `loadRef` — captured once at enqueue time
 *  (runner.ts), read back verbatim rather than re-derived from the load,
 *  which may have changed (or been deleted) since. */
export function loadRefOfContext(context: unknown): string | null {
  if (!context || typeof context !== "object") return null;
  const loadRef = (context as Record<string, unknown>).loadRef;
  return typeof loadRef === "string" ? loadRef : null;
}

/** `AiDecisionRecord.humanDecision` back into its typed shape. `verdict` is
 *  checked against the closed set — anything else (a hand-edited row, a
 *  future value this reader predates) reads as "no decision" rather than
 *  handing a caller an unchecked string. */
export function humanVerdictOf(humanDecision: unknown): HumanDecision | null {
  if (!humanDecision || typeof humanDecision !== "object") return null;
  const { verdict, driverId, note, byDispatcherId } = humanDecision as Record<string, unknown>;
  if (verdict !== "accept" && verdict !== "reject" && verdict !== "other") return null;
  return {
    verdict,
    driverId: typeof driverId === "string" ? driverId : null,
    note: typeof note === "string" ? note : null,
    byDispatcherId: typeof byDispatcherId === "string" ? byDispatcherId : null,
  };
}

/** `startedAt` is only set once a run actually leaves "queued" (loop.ts's
 *  first write); a still-queued run has none yet. RunSummary/RunDetail still
 *  need one orderable, always-present timestamp (a run list has to sort and
 *  display SOMETHING), so a queued row falls back to `proposedAt` — the
 *  row's own creation time (Task 1's schema named it for a different,
 *  pre-harness purpose; it is set by `@default(now())` on every insert). */
export function startedAtIso(record: { startedAt: Date | null; proposedAt: Date }): string {
  return (record.startedAt ?? record.proposedAt).toISOString();
}

/** One `driver.findMany` for a batch of ids — the same shape
 *  dispatcherAlerts.ts already uses for its own driverName lookup. Ids that
 *  are null/undefined (no driver referenced) are dropped before the query;
 *  an empty result skips the query entirely. `orgId` is defense in depth
 *  : every id passed in today already came from an org-checked
 *  source, so this never changes a correct caller's result — it just stops
 *  a future bug (a bad id slipping into one of these lists some other way)
 *  from resolving a name that belongs to a different tenant. `null` means
 *  "no single org to scope to" — the one legitimate case is an unscoped
 *  (legacy/dev) dispatcher's cross-org `GET /ai/runs`, where the existing
 *  "sees everything" convention (middleware/orgScope.ts) already applies. */
export async function fetchDriverNames(ids: readonly (string | null | undefined)[], orgId: string | null): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  if (uniqueIds.length === 0) return new Map();
  const rows = await prisma.driver.findMany({
    where: { id: { in: uniqueIds }, ...(orgId ? { orgId } : {}) },
    select: { id: true, name: true },
  });
  return new Map(rows.map((d) => [d.id, d.name]));
}

/** One `load.findMany` for a batch of load ids, projected down to each
 *  load's scenario hint — the RunSummary-list equivalent of fetchDriverNames
 *  above, so a page of runs never issues one Load query per row. Same
 *  `orgId` defense-in-depth reasoning as fetchDriverNames. */
export async function fetchScenarios(loadIds: readonly (string | null | undefined)[], orgId: string | null): Promise<Map<string, RunScenario | null>> {
  const uniqueIds = [...new Set(loadIds.filter((id): id is string => typeof id === "string"))];
  if (uniqueIds.length === 0) return new Map();
  const rows = await prisma.load.findMany({
    where: { id: { in: uniqueIds }, ...(orgId ? { orgId } : {}) },
    select: { id: true, extras: true },
  });
  return new Map(rows.map((l) => [l.id, scenarioOf(l.extras)]));
}

/**
 * Exactly the `AiDecisionRecord` columns `toRunSummary` below reads — nothing
 * from the heavy JSON columns (`baseline`, `evidence`, `context` is the only
 * JSON field here and it is tiny, `toolCalls`, `toolResults`,
 * `proposedDecision`). a run list route selects only this, rather than
 * `findMany` with no `select` at all pulling every column (baseline/evidence
 * alone run tens of KB per row) just to build a summary that was always
 * going to discard them. `Pick<AiDecisionRecord, ...>` rather than a
 * hand-written interface: this stays in lockstep with the real column types
 * (nullability included) with no separate shape to drift out of sync.
 */
export const RUN_SUMMARY_SELECT = {
  id: true,
  loadId: true,
  context: true,
  status: true,
  terminationReason: true,
  driverId: true,
  confidence: true,
  humanDecision: true,
  promptVersion: true,
  stats: true,
  startedAt: true,
  proposedAt: true,
  completedAt: true,
  parentRunId: true,
} satisfies Prisma.AiDecisionRecordSelect;

export type RunSummarySource = Pick<AiDecisionRecord, keyof typeof RUN_SUMMARY_SELECT>;

export function toRunSummary(
  record: RunSummarySource,
  driverNames: Map<string, string>,
  scenarios: Map<string, RunScenario | null>,
): RunSummary {
  const human = humanVerdictOf(record.humanDecision);
  return {
    id: record.id,
    loadId: record.loadId,
    loadRef: loadRefOfContext(record.context),
    scenario: record.loadId ? scenarios.get(record.loadId) ?? null : null,
    status: record.status as RunStatus,
    terminationReason: record.terminationReason,
    driverId: record.driverId,
    driverName: record.driverId ? driverNames.get(record.driverId) ?? null : null,
    confidence: record.confidence,
    humanVerdict: human?.verdict ?? null,
    promptVersion: record.promptVersion,
    stats: record.stats as unknown as RunStats | null,
    startedAt: startedAtIso(record),
    completedAt: record.completedAt ? record.completedAt.toISOString() : null,
    parentRunId: record.parentRunId,
  };
}

export async function toRunSummaries(records: RunSummarySource[], orgId: string | null): Promise<RunSummary[]> {
  const driverNames = await fetchDriverNames(records.map((r) => r.driverId), orgId);
  const scenarios = await fetchScenarios(records.map((r) => r.loadId), orgId);
  return records.map((r) => toRunSummary(r, driverNames, scenarios));
}

export function toRunDetail(
  record: AiDecisionRecord,
  driverNames: Map<string, string>,
  scenarios: Map<string, RunScenario | null>,
): RunDetail {
  return {
    ...toRunSummary(record, driverNames, scenarios),
    experimentId: record.experimentId,
    kind: record.kind,
    modelConfig: record.modelConfig as unknown as HarnessConfig | null,
    promptVersion: record.promptVersion,
    baseline: record.baseline as unknown as Baseline | null,
    evidence: record.evidence as unknown as Evidence | null,
    proposedDecision: record.proposedDecision as unknown as Proposal | null,
    reason: record.reason,
    humanDecision: humanVerdictOf(record.humanDecision),
    decidedAt: record.decidedAt ? record.decidedAt.toISOString() : null,
    error: record.error,
  };
}

/** Every driverId referenced anywhere in one run's detail — the proposal's
 *  own pick and alternatives, the baseline's candidates, every driver
 *  evidence.ts recorded seeing, and (for completeness beyond the brief's own
 *  four sources) the run's own decided driverId and a human override's pick —
 *  so GET /ai/runs/:id's `driverNames` map can resolve a name for anything
 *  the run page might render, never just some of it. */
export function allReferencedDriverIds(record: AiDecisionRecord): string[] {
  const ids = new Set<string>();
  if (record.driverId) ids.add(record.driverId);

  const proposal = record.proposedDecision as unknown as Proposal | null;
  if (proposal) {
    if (proposal.driverId) ids.add(proposal.driverId);
    for (const alt of proposal.alternatives) ids.add(alt.driverId);
    // dispatch-v2's own `comparison` field — not part of v1's `Proposal`
    // type, so read defensively rather than widening that shared type for
    // one v2-only field only this loop cares about.
    const comparison = (proposal as { comparison?: unknown }).comparison;
    if (Array.isArray(comparison)) {
      for (const entry of comparison) {
        const driverId = entry && typeof entry === "object" ? (entry as { driverId?: unknown }).driverId : undefined;
        if (typeof driverId === "string") ids.add(driverId);
      }
    }
  }

  const baseline = record.baseline as unknown as Baseline | null;
  if (baseline) for (const c of baseline.candidates) ids.add(c.driverId);

  const evidence = record.evidence as unknown as Evidence | null;
  if (evidence) {
    for (const id of evidence.candidatesInspected) ids.add(id);
    for (const row of evidence.feasibilitySeen) ids.add(row.driverId);
    for (const id of evidence.metricsInspected) ids.add(id);
    for (const id of evidence.historyInspected) ids.add(id);
    for (const fact of evidence.factsCited) if (fact.forDriverId) ids.add(fact.forDriverId);
  }

  const human = humanVerdictOf(record.humanDecision);
  if (human?.driverId) ids.add(human.driverId);

  return [...ids];
}
