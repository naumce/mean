import { nearestCity } from "./usCities.js";

// The single stop-to-state resolver (T4 Task 3). Every downstream number
// that depends on WHICH state a stop is in — diesel price lookup, IFTA
// gallon attribution — reads through this one function. A wrong state is
// worse than no state: it prices against the wrong number and attributes a
// taxable gallon nobody can trace back to a source. `null` is always the
// safe answer, and is returned whenever the input is not unambiguous —
// never guessed, never inferred beyond what's below.
//
// Full state names are deliberately NOT parsed. A name table is a lookup we
// have not built and cannot half-build safely — "Washington" is both a
// state and a district, "Kansas City" spans two states (MO and KS). Two
// letters after a comma, checked against the real state set, is a format we
// can verify; a name is not.

/** The 50 states plus DC, as two-letter USPS codes. Held as an explicit
 *  frozen array — not a `[A-Z]{2}` regex — so a shaped-right-but-wrong code
 *  like "XX" is rejected rather than accepted on format alone.
 *
 *  Exported so dispatcherFuelPrices.ts (T4 Task 6) validates `state` against
 *  this SAME list rather than hand-rolling a second one that could drift
 *  from the one this file's own parsing already trusts. */
export const US_STATE_CODES = Object.freeze([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC",
]);

/** How close a coordinate must be to a gazetteer city before we will read a
 *  STATE off it. Deliberately far tighter than nearestCity's 150-mi default,
 *  which is tuned for a lane label ("near Kansas City") where being one state
 *  over is cosmetic. Here it is not: the gazetteer holds ~139 cities, so a
 *  rural stop can sit 140 mi from the nearest entry and land across a state
 *  line — which would price fuel against the wrong state and attribute a
 *  taxable gallon to a state the truck never entered (Global Constraint 6).
 *  Beyond this radius the honest answer is null. */
export const STATE_MATCH_MAX_MI = 25;

export function isUsStateCode(code: string): boolean {
  return (US_STATE_CODES as readonly string[]).includes(code);
}

// Two letters immediately after the LAST comma in a "City, ST" or
// "City, ST 12345"/"City, ST 12345-6789" label, and nothing else after.
// This is the ONE parser both input paths below run through: `stop.address`
// directly, and nearestCity's `"Kansas City, MO"`-shaped label for the
// coordinate path. One parse function, two inputs — never a second
// state-extraction path.
const STATE_SUFFIX_RE = /,\s*([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$/;

function stateFromLabel(label: string): string | null {
  const match = STATE_SUFFIX_RE.exec(label);
  if (!match) return null;
  const code = match[1].toUpperCase();
  return isUsStateCode(code) ? code : null;
}

/** Two-letter uppercase state code, or null when it cannot be read off the
 *  stop. NEVER inferred from coordinates alone beyond the gazetteer's own
 *  nearest-city match, and never guessed. */
export function stateOf(stop: { address?: string | null; lat?: number | null; lng?: number | null }): string | null {
  if (stop.address) {
    const fromAddress = stateFromLabel(stop.address);
    if (fromAddress) return fromAddress;
  }
  if (typeof stop.lat === "number" && typeof stop.lng === "number") {
    const nearest = nearestCity(stop.lat, stop.lng, STATE_MATCH_MAX_MI);
    if (nearest) return stateFromLabel(nearest.label);
  }
  return null;
}
