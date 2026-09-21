// IFTA fuel-tax attribution: which state burned which gallons.
//
// We do not have route geometry, so we do not know where along a leg the
// truck crossed a state line. A leg whose two endpoints are the SAME known
// state is the only case we can attribute without guessing: the whole leg
// necessarily happened inside that state. Every other leg — different
// states at each end, or either end unknown — is reported as
// `unattributedGal`, never split or estimated (Global Constraint 6).
//
// This is deliberately unhelpful for real interstate lanes. A large
// `unattributedGal` is not a bug in this module; it is the module telling
// its caller that filing from this data would need routed miles we don't
// have. Spreading the remainder across the known states "to make the
// totals look right" would fabricate evidence for a tax filing — see
// Step 5 of the task brief, which proves that version fails on purpose.

import type { FuelBurn } from "./fuel.js";

export interface AttributionLeg {
  /** state of the stop this leg departs, or null when unresolved */
  fromState: string | null;
  /** state of the stop this leg arrives at, or null when unresolved */
  toState: string | null;
  miles: number;
}

export interface StateGallons {
  state: string;
  gallons: number;
}

export interface IftaAttribution {
  byState: StateGallons[];
  /** gallons we could NOT attribute to a state. Reported, never distributed. */
  unattributedGal: number;
  /** true only when unattributedGal is 0 — the flag a filing UI must gate on */
  complete: boolean;
}

/**
 * Attribute a plan's fuel burn to states, leg by leg, weighted by each leg's
 * share of total miles. A leg is attributable only when both its endpoints
 * are known and identical; everything else — cross-state legs, legs with an
 * unknown endpoint — lands wholly in `unattributedGal`. Never renormalised:
 * the remainder is reported, not hidden by spreading it over states we DO
 * know about.
 */
export function attributeGallons(burn: FuelBurn, legs: AttributionLeg[]): IftaAttribution {
  // No burn, no attribution to make. `complete` stays false here even though
  // unattributedGal is 0 — there is nothing to file, not a finished filing.
  if (burn.mpgUsed === null) {
    return { byState: [], unattributedGal: 0, complete: false };
  }

  const totalMiles = legs.reduce((sum, leg) => sum + leg.miles, 0);
  if (totalMiles === 0) {
    return { byState: [], unattributedGal: 0, complete: false };
  }

  const byState = new Map<string, number>();
  let unattributedGal = 0;

  for (const leg of legs) {
    const legGal = burn.totalGal * (leg.miles / totalMiles);
    const sameKnownState =
      leg.fromState !== null && leg.toState !== null && leg.fromState === leg.toState;

    if (sameKnownState) {
      // fromState/toState narrowed to non-null string by sameKnownState above.
      const state = leg.fromState as string;
      byState.set(state, (byState.get(state) ?? 0) + legGal);
    } else {
      unattributedGal += legGal;
    }
  }

  const rows = [...byState.entries()]
    .map(([state, gallons]): StateGallons => ({ state, gallons }))
    .sort((a, b) => a.state.localeCompare(b.state));

  return {
    byState: rows,
    unattributedGal,
    complete: unattributedGal === 0,
  };
}
