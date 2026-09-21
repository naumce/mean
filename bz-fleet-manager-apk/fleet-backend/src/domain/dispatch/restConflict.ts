// Turns "the driver must break here" into a dispatch conflict when there is
// demonstrably nowhere to do it — and, just as importantly, into SILENCE when
// we simply do not know.
//
// Global Constraint 1: absent must never render as measured. An org that has
// imported no rest stops has told us nothing about parking; refusing its plans
// would be inventing a fact.

import { REST_SEARCH_RADIUS_MI, type RestOption } from "./restOptions.js";
import type { BreakPoint, Conflict } from "./types.js";

/** How far around a break point we look before concluding the org has data
 *  about this corridor at all. Deliberately wider than the reachability
 *  radius: stops 100 mi up the interstate prove coverage without being
 *  usable for this break. */
export const COVERAGE_RADIUS_MI = 150;

export interface RestCoverage {
  /** true when the org has ANY rest stop within COVERAGE_RADIUS_MI of the
   *  break point — i.e. we are in a position to say anything at all */
  hasData: boolean;
  options: RestOption[];
}

export function restConflict(bp: BreakPoint, coverage: RestCoverage): Conflict | null {
  // No position -> nothing to say about it (Task 2 leaves `at` null when a
  // leg has no destination).
  if (!bp.at) return null;
  if (coverage.options.length > 0) return null;
  if (!coverage.hasData) return null; // silence, not a refusal

  const approx = bp.precision === "estimated" ? "≈" : "";
  const where = `${approx}${bp.at.lat.toFixed(2)}, ${approx}${bp.at.lng.toFixed(2)}`;
  return {
    kind: "no_rest",
    severity: "block",
    detail: `30-min break falls near ${where} with no rest option within ${REST_SEARCH_RADIUS_MI} mi`,
  };
}
