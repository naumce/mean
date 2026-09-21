// The ⚡Suggest scorer (Control Tower §4E). Runs the feasibility engine + economics
// over every candidate driver and produces a ranked, explainable list. Pure and
// deterministic. V1 is a transparent weighted score (no ML — ML rides on
// accumulated history later, via the lane weight starting at 0).
//
// Infeasible drivers are RANKED LAST but never hidden: the dispatcher sees "Dale
// ❌ HOS" with the reason, exactly as the spec requires.

import { computeEconomics, DEFAULT_RATE_CONFIG, type RateConfig } from "./economics.js";
import { evaluate } from "./evaluate.js";
import type {
  DriverInput,
  EvalContext,
  LoadInput,
  TractorInput,
  TrailerInput,
} from "./types.js";

export interface SuggestWeights {
  margin: number;
  deadhead: number;
  hos: number;
  appt: number;
  hometime: number;
  lane: number;
}

/** V1 weights (sum 1.0). Lane starts at 0.05 but its input is 0 until history accrues. */
export const DEFAULT_WEIGHTS: SuggestWeights = {
  margin: 0.3,
  deadhead: 0.3,
  hos: 0.15,
  appt: 0.15,
  hometime: 0.05,
  lane: 0.05,
};

export interface Candidate {
  driverId: string;
  driver: DriverInput;
  tractor: TractorInput;
  trailer: TrailerInput;
  context?: EvalContext;
}

export interface SuggestConfig {
  weights?: SuggestWeights;
  /** Cost model each candidate is priced at. Either ONE RateConfig applied to
   *  every candidate (single-org callers; existing behavior), or a per-driver
   *  resolver — e.g. each driver's own carrier, falling back to their org —
   *  so a ranking of drivers on different carriers prices each one at their
   *  OWN model instead of one shared config (T1 Task 3b). Defaults to
   *  DEFAULT_RATE_CONFIG when omitted, same as before. */
  rate?: RateConfig | ((driverId: string) => RateConfig);
  /** 0..1 preference for this driver's home-time on this lane; default 0.5 (neutral) */
  homeTimePref?: (driverId: string) => number;
  /** 0..1 historical lane performance for this driver; default 0 (no data yet) */
  lanePerfScore?: (driverId: string) => number;
}

export interface SuggestRow {
  driverId: string;
  feasible: boolean;
  /** 0..100 for feasible candidates; null when infeasible (greyed in the UI) */
  score: number | null;
  deadheadMi: number;
  loadedMi: number;
  /** epoch ms the load completes under this assignment */
  etaMs: number;
  marginCents: number;
  marginPct: number;
  /** first blocking conflict's reason, when infeasible */
  blockedReason?: string;
  /** non-blocking warnings (tight arrivals, reefer sub-checks) */
  warnings: string[];
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const norm = (v: number, lo: number, hi: number): number => clamp01((v - lo) / (hi - lo));

/**
 * Rank candidate drivers for a load. Feasible first (best score first), then
 * infeasible with their blocking reason.
 */
export function suggest(
  load: LoadInput,
  candidates: Candidate[],
  config: SuggestConfig = {},
): SuggestRow[] {
  const weights = config.weights ?? DEFAULT_WEIGHTS;
  // Normalize to a per-driver lookup either way, so the map() below never
  // needs to know whether the caller supplied one shared config or a resolver.
  // Bound to a const first: TypeScript will not narrow `config.rate` inside the
  // closure below (a property could change between calls), so reading it
  // directly leaves the union unresolved and fails to compile.
  const rate = config.rate;
  const rateFor: (driverId: string) => RateConfig =
    typeof rate === "function" ? rate : () => rate ?? DEFAULT_RATE_CONFIG;
  const revenueCents = load.revenueCents ?? 0;

  const rows: SuggestRow[] = candidates.map((c) => {
    const res = evaluate(load, c.driver, c.tractor, c.trailer, c.context);
    const econ = computeEconomics(
      { revenueCents, deadheadMi: res.plan.deadheadMi, loadedMi: res.plan.loadedMi },
      rateFor(c.driverId),
    );
    const warnings = res.conflicts.filter((x) => x.severity === "warn").map((x) => x.detail);

    if (!res.feasible) {
      const block = res.conflicts.find((x) => x.severity === "block");
      return {
        driverId: c.driverId,
        feasible: false,
        score: null,
        deadheadMi: res.plan.deadheadMi,
        loadedMi: res.plan.loadedMi,
        etaMs: res.plan.proposedEnd,
        marginCents: econ.marginCents,
        marginPct: econ.marginPct,
        blockedReason: block?.detail,
        warnings,
      };
    }

    const hos = c.driver.hos;
    const driveSlack = hos.driveRemainingMin > 0 ? (hos.driveRemainingMin - res.plan.driveMin) / hos.driveRemainingMin : 0;
    const dutySlack = hos.windowRemainingMin > 0 ? (hos.windowRemainingMin - res.plan.onDutyMin) / hos.windowRemainingMin : 0;
    const apptRisk = warnings.length > 0 ? 0.5 : 0;

    const marginScore = norm(econ.marginPct, 0.05, 0.35);
    const deadheadScore = clamp01(1 - res.plan.deadheadMi / 300);
    const hosScore = clamp01(Math.min(driveSlack, dutySlack));
    const apptScore = 1 - apptRisk;
    const homeTimeScore = clamp01(config.homeTimePref?.(c.driverId) ?? 0.5);
    const laneScore = clamp01(config.lanePerfScore?.(c.driverId) ?? 0);

    const score = Math.round(
      100 *
        (weights.margin * marginScore +
          weights.deadhead * deadheadScore +
          weights.hos * hosScore +
          weights.appt * apptScore +
          weights.hometime * homeTimeScore +
          weights.lane * laneScore),
    );

    return {
      driverId: c.driverId,
      feasible: true,
      score,
      deadheadMi: res.plan.deadheadMi,
      loadedMi: res.plan.loadedMi,
      etaMs: res.plan.proposedEnd,
      marginCents: econ.marginCents,
      marginPct: econ.marginPct,
      warnings,
    };
  });

  return rows.sort((a, b) => {
    if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
    if (a.feasible) return (b.score ?? 0) - (a.score ?? 0);
    return a.deadheadMi - b.deadheadMi; // among infeasible, closest first
  });
}
