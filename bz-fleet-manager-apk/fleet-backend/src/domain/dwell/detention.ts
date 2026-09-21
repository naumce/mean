// Detention claims: turns an observed dwell (segments.ts) into a figure a
// carrier can invoice a broker for -- or, more often than you'd expect,
// decides it can't (Control Tower T5).
//
// Detention is billed to a THIRD PARTY. A dispatcher hands this number to a
// broker, and the broker's first question is "how do you know?" A claim
// that can't answer that damages every *other* claim the carrier files. So
// here the refusals are worth more than the arithmetic: `null` is the
// honest answer whenever the evidence doesn't support a claim, never a
// zero-minute row that could get sent by accident (Global Constraint 1).
//
// Every inference below runs in the direction that SHRINKS the claim
// (Global Constraint 5): clockStartMs is the later of arrival and window
// open (never billed for arriving early), and billableMin is clamped at
// zero (never negative, never invented).
//
// Pure function: no DB, no Date, no I/O.

import type { DwellSegment } from "./segments.js";

export interface DetentionInput {
  segment: DwellSegment;
  /** appointment window open, epoch ms; null when the stop has no appointment */
  windowStartMs: number | null;
  /** free minutes before detention accrues */
  freeMin: number;
  /** whether the stop's coordinates are trustworthy (geocodeStatus === "ok") */
  geocodeOk: boolean;
}

export interface DetentionClaim {
  /** when the detention clock starts: arrival or window open, whichever is
   *  LATER -- a truck is not detained for arriving early */
  clockStartMs: number;
  freeMin: number;
  /** minutes beyond free time that we can evidence. Never negative. */
  billableMin: number;
  /** evidence, carried with the claim (Global Constraint 6) */
  evidence: {
    pingCount: number;
    maxGapMin: number;
    firstSeenMs: number;
    lastSeenMs: number;
    departureObserved: boolean;
  };
  /** true when a human should look before this is billed */
  needsReview: boolean;
  /** why it needs review, in words a dispatcher can act on; empty when not */
  reviewReasons: string[];
}

export const DEFAULT_FREE_MIN = 120;
/** a gap this large between pings makes the claim contestable */
export const GAP_REVIEW_MIN = 30;
/** past this many billable minutes, evidence density starts to matter */
export const LONG_CLAIM_MIN = 60;
/** fewer pings than this behind a long claim is worth a human look */
export const DENSE_EVIDENCE_PINGS = 4;

const MS_PER_MIN = 60_000;

/**
 * Decide whether an observed dwell segment supports a detention claim, and
 * if so, how big it honestly is.
 *
 * Four situations produce no claim at all (`null`, never a zero-minute
 * claim -- see the module doc and Global Constraint 1):
 *   - `geocodeOk: false` -- the fence is drawn around a city centroid, not a
 *     dock; presence inside it is not evidence of being at the stop.
 *   - `windowStartMs: null` -- no appointment means no agreed schedule to be
 *     detained against.
 *   - `segment.pingCount < 2` -- one ping proves presence, not duration.
 *   - `billableMin <= 0` -- inside free time is not a zero-dollar claim.
 *
 * Two situations still produce a claim, but flagged: a large gap between
 * pings, or a segment whose departure was never observed. Both get a
 * human-readable reason in `reviewReasons` (a later task renders them
 * verbatim -- this is final copy, not a debug string).
 */
export function detentionClaim(input: DetentionInput): DetentionClaim | null {
  const { segment, windowStartMs, freeMin, geocodeOk } = input;

  if (!geocodeOk) return null;
  if (windowStartMs === null) return null;
  if (segment.pingCount < 2) return null;

  // Later of arrival and window open -- never billed for arriving early.
  const clockStartMs = Math.max(segment.firstSeenMs, windowStartMs);
  const rawMin = (segment.lastSeenMs - clockStartMs) / MS_PER_MIN;
  const billableMin = Math.max(0, rawMin - freeMin);

  if (billableMin <= 0) return null;

  const reviewReasons: string[] = [];
  if (segment.maxGapMin > GAP_REVIEW_MIN) {
    // Rounded: maxGapMin is a raw ms/60000 quotient, and this string is
    // shown to a dispatcher verbatim. "a 187.53333333333333m gap" reads as a
    // bug, not a fact.
    reviewReasons.push(`evidence has a ${Math.round(segment.maxGapMin)}m gap`);
  }
  // A long claim resting on a handful of pings is the shape that gets a
  // carrier's whole detention file challenged: two pings twelve hours apart
  // produce a real ten-hour number with almost nothing behind it. The gap
  // reason above fires too, but it describes ONE hole; this describes how
  // thin the whole record is, which is the question a broker actually asks.
  if (billableMin > LONG_CLAIM_MIN && segment.pingCount < DENSE_EVIDENCE_PINGS) {
    reviewReasons.push(
      `claim rests on only ${segment.pingCount} pings over ${Math.round(billableMin)}m`,
    );
  }
  if (!segment.departureObserved) {
    reviewReasons.push(
      "departure never observed; dwell may be longer or the trail may simply end",
    );
  }

  return {
    clockStartMs,
    freeMin,
    billableMin,
    evidence: {
      pingCount: segment.pingCount,
      maxGapMin: segment.maxGapMin,
      firstSeenMs: segment.firstSeenMs,
      lastSeenMs: segment.lastSeenMs,
      departureObserved: segment.departureObserved,
    },
    needsReview: reviewReasons.length > 0,
    reviewReasons,
  };
}
