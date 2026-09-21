// Comparative fuel-buy advice: "buy N gal at stop X, save $Y vs stop Z".
// Pure: prices and states are already resolved by the caller (Task 7's price
// lookup + stateOf), so this module only has to pick the reachable stop that
// saves the most, subject to a minimum-saving floor so noise from an
// estimated burn and a possibly-stale price doesn't reach the dispatcher as
// "advice" (Global Constraint 5 — this never touches margin costing).

import type { FuelBurn } from "./fuel.js";

export interface PricedStop {
  sequence: number;
  /** human-readable, e.g. "Kansas City, MO" */
  label: string;
  /** caller has already resolved this; never null here */
  state: string;
  centsPerGal: number;
  /** Gallons still to be burned from THIS stop onward. Supplied by the caller,
   *  which is the only layer that knows the plan's leg structure.
   *
   *  Sizing advice to the whole plan's burn overstates it: fuel burned BEFORE
   *  the buy stop was already purchased somewhere else. On a lane with 285 mi
   *  of deadhead and 669 loaded, advising the pickup against the full burn
   *  inflates the saving by ~30% — a wrong number presented as measured,
   *  which is worse than no number (Global Constraint 1). */
  gallonsFromHere: number;
}

export interface FuelAdvice {
  /** where to buy */
  atSequence: number;
  atLabel: string;
  state: string;
  gallons: number;
  centsPerGal: number;
  /** the stop this is cheaper THAN — advice is always comparative */
  vsLabel: string;
  vsCentsPerGal: number;
  savingCents: number;
}

/** Savings below this are within the noise of an estimated burn and a
 * possibly-stale price; suppress the advice rather than show a figure this
 * data can't actually support. */
export const MIN_SAVING_CENTS = 500;

/**
 * Pick the cheapest stop the driver can still act on and compare it to the
 * most expensive stop at or after it on the route.
 *
 * A stop can only be advised as a place to buy fuel if the driver reaches it
 * *before* burning the fuel it would sell — so the last stop on the route
 * (a delivery) is never eligible as the "buy here" stop, even when it is the
 * cheapest price on the route. It can still be the stop the advice is
 * comparing *against* (the expensive one the driver avoids by buying
 * earlier).
 */
export function fuelAdvice(burn: FuelBurn, stops: PricedStop[]): FuelAdvice | null {
  if (burn.mpgUsed === null) return null;
  if (stops.length < 2) return null;

  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence);
  // Every stop except the last one: the last stop is a delivery, not a fuel
  // decision, so it is never a candidate to buy at.
  const reachable = ordered.slice(0, -1);

  const cheapest = reachable.reduce((min, s) => (s.centsPerGal < min.centsPerGal ? s : min));

  // Compared against the most expensive stop at or after the buy point —
  // the last stop is fair game *here*, since it's the price being avoided,
  // not the place being bought at.
  const comparedTo = ordered
    .filter((s) => s.sequence >= cheapest.sequence)
    .reduce((max, s) => (s.centsPerGal > max.centsPerGal ? s : max));

  // Only the fuel still ahead of the buy point can be bought there. Clamped to
  // the plan's total as a backstop against a caller that miscounts a leg.
  const gallons = Math.max(0, Math.min(burn.totalGal, cheapest.gallonsFromHere));

  const savingCents = Math.round(gallons * (comparedTo.centsPerGal - cheapest.centsPerGal));
  if (savingCents < MIN_SAVING_CENTS) return null;

  return {
    atSequence: cheapest.sequence,
    atLabel: cheapest.label,
    state: cheapest.state,
    gallons,
    centsPerGal: cheapest.centsPerGal,
    vsLabel: comparedTo.label,
    vsCentsPerGal: comparedTo.centsPerGal,
    savingCents,
  };
}
