import type { StoredStep } from "./runStore.js";
import type { ProposalV2 } from "./prompts/dispatch-v2.js";

// aiHarness/protocol.ts (dispatch-v2 A/B experiment, Task 1): dispatch-v2's
// own evidence-derived rules — which feasible candidates a run actually
// investigated, read back purely from its persisted `tool_call`/`tool_result`
// steps, and the comparison/confidence checks one `propose_decision` attempt
// must pass before dispatch-v2's profile accepts it. Every fact here comes
// from steps already written to the run's own transcript (`ok: true`
// tool_result steps) — never from the model's own prose, and this module
// never calls a tool or the database itself.

export interface ProtocolContext {
  orgId: string;
  loadId: string;
  feasibleDriverIds: ReadonlySet<string>;
  /** Persisted so far — the loop hands this in fresh on every propose_decision
   *  attempt (see prompts/index.ts's dispatch-v2 profile). */
  steps: StoredStep[];
}

/**
 * Which evidence categories a driver's successful, this-load tool calls have
 * covered so far:
 *
 * | tool                       | covers                                                                        |
 * |-----------------------------|--------------------------------------------------------------------------------|
 * | getDispatchCandidateDetails | availability, location, deadhead, hos, equipment, lane, response, preferences  |
 * | getDriverAvailability       | availability, location                                                        |
 * | getDriverMetrics            | metrics, lane, response                                                       |
 * | getDriverHistory            | lane                                                                          |
 * | getDriver                   | equipment                                                                     |
 * | getDriverLocationHistory    | location                                                                      |
 *
 * `getDispatchCandidateDetails` never sets `metrics` on its own — its
 * on-time/response-rate fields land under `response`/`lane` instead, which is
 * why `isCandidateInvestigated` below accepts either `metrics` or `response`.
 * A driver counts as investigated once its coverage has `availability` plus
 * either of those: `getDispatchCandidateDetails` alone qualifies, and so does
 * the smaller `getDriverAvailability` + `getDriverMetrics` pair (with or
 * without `getDriver` added for equipment) — but `getDriverMetrics` alone
 * never does, since it never confirms the driver is even available.
 */
export interface Investigation {
  driverId: string;
  /** Distinct successful tool names that contributed to this driver's
   *  coverage, in first-seen order. */
  tools: string[];
  covers: {
    availability: boolean;
    location: boolean;
    deadhead: boolean;
    hos: boolean;
    equipment: boolean;
    metrics: boolean;
    lane: boolean;
    response: boolean;
    preferences: boolean;
  };
}

type Coverage = Investigation["covers"];

const NO_COVERAGE: Coverage = {
  availability: false,
  location: false,
  deadhead: false,
  hos: false,
  equipment: false,
  metrics: false,
  lane: false,
  response: false,
  preferences: false,
};

/** The per-tool contribution table this module's own header comment states —
 *  kept as one map so `investigationsFromSteps`/`DRIVER_ID_TOOLS` both read
 *  off the same source rather than two hand-kept lists drifting apart. */
const TOOL_COVERAGE: Record<string, Partial<Coverage>> = {
  getDispatchCandidateDetails: {
    availability: true,
    location: true,
    deadhead: true,
    hos: true,
    equipment: true,
    lane: true,
    response: true,
    preferences: true,
  },
  getDriverAvailability: { availability: true, location: true },
  getDriverMetrics: { metrics: true, lane: true, response: true },
  getDriverHistory: { lane: true },
  getDriver: { equipment: true },
  getDriverLocationHistory: { location: true },
};

const DRIVER_ID_TOOLS = new Set(Object.keys(TOOL_COVERAGE));

interface StepPayloadLike {
  name?: unknown;
  arguments?: unknown;
  ok?: unknown;
}

function payloadOf(step: StoredStep): StepPayloadLike | null {
  return step.payload != null && typeof step.payload === "object" ? (step.payload as StepPayloadLike) : null;
}

function stringArg(args: unknown, key: string): string | null {
  if (args == null || typeof args !== "object") return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/**
 * `{ name, driverId }` for every SUCCESSFUL call of one of `DRIVER_ID_TOOLS`,
 * in ascending seq order. A `tool_call` step is paired with the next step of
 * the SAME name after it, by seq (real execution always resolves one call
 * before the next begins, so this is always its own result); a
 * `getDispatchCandidateDetails` call only counts when its own `loadId`
 * argument matches `loadId` — a call about another load says nothing about
 * this one.
 */
function successfulDriverCalls(steps: StoredStep[], loadId: string): { name: string; driverId: string }[] {
  const sorted = [...steps].sort((a, b) => a.seq - b.seq);
  const results: { name: string; driverId: string }[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const step = sorted[i];
    if (step.kind !== "tool_call") continue;
    const callPayload = payloadOf(step);
    const name = typeof callPayload?.name === "string" ? callPayload.name : null;
    if (!name || !DRIVER_ID_TOOLS.has(name)) continue;

    const driverId = stringArg(callPayload?.arguments, "driverId");
    if (!driverId) continue;
    if (name === "getDispatchCandidateDetails" && stringArg(callPayload?.arguments, "loadId") !== loadId) continue;

    const match = sorted.slice(i + 1).find((s) => s.kind === "tool_result" && payloadOf(s)?.name === name);
    if (!match || payloadOf(match)?.ok !== true) continue;

    results.push({ name, driverId });
  }

  return results;
}

/**
 * One entry per driver id that was ever the target of a successful,
 * this-load call to one of the six investigation tools — see this module's
 * header comment for what each tool contributes to `covers`.
 */
export function investigationsFromSteps(steps: StoredStep[], loadId: string): Map<string, Investigation> {
  const map = new Map<string, Investigation>();

  for (const { name, driverId } of successfulDriverCalls(steps, loadId)) {
    const contribution = TOOL_COVERAGE[name];
    if (!contribution) continue;
    const existing = map.get(driverId) ?? { driverId, tools: [] as string[], covers: { ...NO_COVERAGE } };
    map.set(driverId, {
      driverId,
      tools: existing.tools.includes(name) ? existing.tools : [...existing.tools, name],
      covers: { ...existing.covers, ...contribution },
    });
  }

  return map;
}

/** A driver counts as investigated once its own coverage confirms
 *  availability plus either metrics or response evidence — see this module's
 *  header comment for the worked combinations. */
export function isCandidateInvestigated(covers: Coverage): boolean {
  return covers.availability && (covers.metrics || covers.response);
}

function investigatedFeasibleIds(investigations: Map<string, Investigation>, feasibleDriverIds: ReadonlySet<string>): string[] {
  const ids: string[] = [];
  for (const id of feasibleDriverIds) {
    const inv = investigations.get(id);
    if (inv && isCandidateInvestigated(inv.covers)) ids.push(id);
  }
  return ids;
}

/** How many of `feasibleDriverIds` this run's own successful, this-load tool
 *  calls actually investigated — the one number loopHandlers.ts's own
 *  `finalizeRun` needs for `stats.candidatesInvestigated`, computed the exact
 *  same way `checkProtocolV2` itself decides which feasible candidates
 *  qualify (kept here, not duplicated in loopHandlers.ts, so the stat and the
 *  protocol check can never silently disagree). */
export function countInvestigatedFeasible(steps: StoredStep[], loadId: string, feasibleDriverIds: ReadonlySet<string>): number {
  return investigatedFeasibleIds(investigationsFromSteps(steps, loadId), feasibleDriverIds).length;
}

function label(id: string, driverNames?: ReadonlyMap<string, string>): string {
  return driverNames?.get(id) ?? id;
}

const MAX_NEXT_CALL_IDS = 3;

/** Uninvestigated feasible ids the model itself already named, in its own
 *  `alternatives`/`comparison` entries, first-seen order. Preferring these
 *  over any other feasible id means the "investigate one more" instruction
 *  never has to pick on its own — it only ever repeats back an id the model
 *  already surfaced. */
function proposalNamedUninvestigatedIds(proposal: ProposalV2, uninvestigated: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of [...proposal.alternatives.map((a) => a.driverId), ...proposal.comparison.map((e) => e.driverId)]) {
    if (uninvestigated.has(id) && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Up to `MAX_NEXT_CALL_IDS` feasible-but-uninvestigated driver ids to name in
 * the "investigate one more" message: the model's own uninvestigated
 * `alternatives`/`comparison` ids when it named any, otherwise every
 * uninvestigated feasible id sorted lexicographically — deliberately NEVER
 * `feasibleDriverIds`' own insertion order, which is the deterministic
 * baseline's own ranking (`baseline.ts`: "Candidates keep the engine's own
 * order"). Steering the model toward whichever driver a ranking engine
 * ranked first would make part of a v1-vs-v2 comparison a validator artefact
 * rather than prompt behaviour.
 */
function nextCallIds(proposal: ProposalV2, feasibleDriverIds: ReadonlySet<string>, investigatedIds: readonly string[]): string[] {
  const uninvestigated = new Set([...feasibleDriverIds].filter((id) => !investigatedIds.includes(id)));
  const named = proposalNamedUninvestigatedIds(proposal, uninvestigated);
  const ids = named.length > 0 ? named : [...uninvestigated].sort();
  return ids.slice(0, MAX_NEXT_CALL_IDS);
}

function nextCallText(ids: readonly string[]): string {
  return ids.length === 1 ? `driver ${ids[0]}` : `one of: ${ids.join(", ")}`;
}

/**
 * Every protocol problem with `proposal`, derived from `ctx.steps`/
 * `ctx.feasibleDriverIds` alone — never from the proposal's own prose.
 * `driverNames` is an optional id -> name lookup used only to make the
 * returned strings more readable; every id still falls back to its raw form
 * when no name is known for it (prompts/dispatch-v2.ts's `validate` is the
 * only real caller that supplies one, resolved with its own single query).
 */
export function checkProtocolV2(
  proposal: ProposalV2,
  ctx: ProtocolContext,
  driverNames?: ReadonlyMap<string, string>,
): string[] {
  // No feasible driver exists at all (e.g. a load none of the fleet can
  // cover) — item 7's `driverId: null` escape hatch is the only valid
  // proposal here. Every check below assumes at least one feasible candidate
  // exists and would otherwise reject any comparison entry as "not feasible"
  // for the wrong reason, so this returns before reaching them.
  if (ctx.feasibleDriverIds.size === 0) {
    const zeroFeasibleErrors: string[] = [];
    if (proposal.driverId !== null) {
      // Without a findFeasibleDrivers call in this run the empty set may only
      // mean the model has not looked yet — say so instead of asserting that
      // nobody can cover the load.
      const looked = ctx.steps.some((s) => s.kind === "tool_call" && s.name === "findFeasibleDrivers");
      zeroFeasibleErrors.push(
        looked
          ? `no feasible candidate exists for this load, so ${label(proposal.driverId, driverNames)} cannot be ` +
              "recommended — propose driverId null and explain why in your reason."
          : `no feasible candidate is known yet — call findFeasibleDrivers for load ${ctx.loadId} before proposing.`,
      );
    }
    if (proposal.comparison.length > 0) {
      zeroFeasibleErrors.push("no feasible candidate exists for this load — the comparison must be empty.");
    }
    return zeroFeasibleErrors;
  }

  const errors: string[] = [];
  const investigations = investigationsFromSteps(ctx.steps, ctx.loadId);
  const investigatedIds = investigatedFeasibleIds(investigations, ctx.feasibleDriverIds);

  if (ctx.feasibleDriverIds.size >= 2 && investigatedIds.length < 2) {
    const seen = investigatedIds.length > 0 ? investigatedIds.map((id) => label(id, driverNames)).join(", ") : "none";
    const nextIds = nextCallIds(proposal, ctx.feasibleDriverIds, investigatedIds);
    errors.push(
      `You have investigated ${investigatedIds.length} feasible candidate(s) (${seen}). Investigate at least one ` +
        `more feasible candidate before proposing — for ${nextCallText(nextIds)} call getDispatchCandidateDetails ` +
        `(load ${ctx.loadId}) or getDriverAvailability and getDriverMetrics.`,
    );
  }

  for (const entry of proposal.comparison) {
    if (!ctx.feasibleDriverIds.has(entry.driverId)) {
      errors.push(
        `comparison entry ${label(entry.driverId, driverNames)} is not a feasible candidate for this load — ` +
          "remove it or compare a feasible candidate instead.",
      );
      continue;
    }
    const inv = investigations.get(entry.driverId);
    if (!inv || !isCandidateInvestigated(inv.covers)) {
      errors.push(
        `comparison entry ${label(entry.driverId, driverNames)} has not been investigated yet — call ` +
          `getDispatchCandidateDetails (load ${ctx.loadId}) for driver ${entry.driverId}, or getDriverAvailability ` +
          "and getDriverMetrics, before comparing it.",
      );
    }
  }

  if (proposal.driverId !== null && !proposal.comparison.some((e) => e.driverId === proposal.driverId)) {
    errors.push(`the recommended driver ${label(proposal.driverId, driverNames)} must have its own entry in the comparison.`);
  }

  const minEntries = Math.min(2, ctx.feasibleDriverIds.size);
  if (proposal.comparison.length < minEntries) {
    errors.push(
      `the comparison must include at least ${minEntries} feasible candidate(s) — it currently has ${proposal.comparison.length}.`,
    );
  }

  if (proposal.driverId !== null) {
    const chosen = proposal.comparison.find((e) => e.driverId === proposal.driverId);
    const unknownCount = chosen?.unknowns.length ?? 0;
    if (chosen && proposal.confidence >= 0.9 && unknownCount > 0) {
      errors.push(
        "Confidence 0.90+ requires very little relevant uncertainty; you listed unknowns for the chosen driver. " +
          "Lower the confidence or resolve the unknowns with tools.",
      );
    } else if (chosen && proposal.confidence >= 0.7 && unknownCount >= 3) {
      errors.push(
        `Confidence 0.70+ requires limited relevant uncertainty; you listed ${unknownCount} unknowns for the ` +
          "chosen driver. Lower the confidence or resolve the unknowns with tools.",
      );
    }
  }

  return errors;
}
