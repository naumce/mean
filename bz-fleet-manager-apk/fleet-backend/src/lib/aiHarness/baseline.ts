import { suggestForLoad, type SuggestCandidateRow } from "../suggestForLoad.js";

// aiHarness/baseline.ts (Qwen Harness v0.1, Task 4): a snapshot of what the
// existing ⚡Suggest pipeline already knows about a load, captured before a
// model run starts. Nothing here calls a model or writes anything; it exists
// so a later task can compare a run's transcript against the load's state at
// the moment the run began, rather than re-querying a pipeline whose answer
// may have moved on by the time anyone looks.

export interface BaselineCandidate {
  driverId: string;
  driverName: string | null;
  feasible: boolean;
  score: number | null;
  deadheadMi: number;
  marginCents: number;
  etaMs: number;
  blockedReason: string | null;
  context: {
    availabilityStatus: string | null;
    laneRuns: number | null;
    onTimeRate: number | null;
    responseRate: number | null;
    hosKnown: boolean | null;
  } | null;
}

export interface Baseline {
  capturedAt: string;
  requiredEquip: string | null;
  note: string | null;
  candidates: BaselineCandidate[];
  feasibleDriverIds: string[];
  topFeasibleDriverId: string | null;
}

/** One `SuggestCandidateRow` -> its `BaselineCandidate` summary. `context` is
 *  `null` for an "unmappable" row (suggestForLoad.ts's `unmappableRowsOf`) —
 *  a driver who never became a Candidate at all (no known position) has
 *  nothing to summarize either. */
function toBaselineCandidate(row: SuggestCandidateRow): BaselineCandidate {
  return {
    driverId: row.driverId,
    driverName: row.driverName,
    feasible: row.feasible,
    score: row.score,
    deadheadMi: row.deadheadMi,
    marginCents: row.marginCents,
    etaMs: row.etaMs,
    blockedReason: row.blockedReason ?? null,
    context: row.context
      ? {
          availabilityStatus: row.context.availability.status,
          laneRuns: row.context.laneRuns,
          onTimeRate: row.context.onTimeRate,
          responseRate: row.context.responseRate,
          hosKnown: row.hosKnown ?? null,
        }
      : null,
  };
}

/**
 * `suggestForLoad`'s result for `loadId`, reshaped into the fixed snapshot a
 * run is later compared against. Candidates keep the engine's own order —
 * never re-sorted here. Null when the load does not exist or belongs to
 * another org, exactly like `suggestForLoad` itself.
 */
export async function captureBaseline(orgId: string, loadId: string): Promise<Baseline | null> {
  const result = await suggestForLoad(orgId, loadId);
  if (!result) return null;

  const candidates = result.candidates.map(toBaselineCandidate);
  const feasibleDriverIds = candidates.filter((c) => c.feasible).map((c) => c.driverId);

  return {
    capturedAt: new Date().toISOString(),
    requiredEquip: result.requiredEquip,
    note: result.note ?? null,
    candidates,
    feasibleDriverIds,
    topFeasibleDriverId: feasibleDriverIds[0] ?? null,
  };
}

interface FeasibleRowLike {
  driverId?: unknown;
}

/**
 * The feasible driver ids out of a `findFeasibleDrivers` tool call's
 * MODEL-FACING result — `dispatchTools/invoke.ts`'s `projectForModel` compact
 * shape (`{ feasible: [{ driverId, ... }], blocked: [...], ... }`), the same
 * value the harness loop's `ctx.invoke` actually returns (I2: the loop must
 * seed its feasible set from what the model was shown, never from the
 * engine's full result — `captureBaseline` above is the one place that still
 * reads the latter, for the baseline snapshot). Every row already in
 * `feasible` is feasible by construction (the projection already split
 * feasible from blocked), so this only needs to collect ids off it. Never
 * throws: anything not shaped like `{ feasible: [...] }`, or whose rows are
 * not shaped like `{ driverId: string }`, is simply skipped.
 */
export function feasibleIdsFromToolResult(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  const feasible = (value as { feasible?: unknown }).feasible;
  if (!Array.isArray(feasible)) return [];

  const ids: string[] = [];
  for (const row of feasible as FeasibleRowLike[]) {
    if (row != null && typeof row === "object" && typeof row.driverId === "string") {
      ids.push(row.driverId);
    }
  }
  return ids;
}
