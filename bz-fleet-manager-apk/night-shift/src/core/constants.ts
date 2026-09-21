// Every threshold the rules use, named, with the reason it has that value.
// Rule code contains no literal numbers; a tune is an edit here and in
// tests/constants.test.ts, deliberately.

/** Demo speed. 1 on the road: the minutes in this file are the product. A
 *  pitch that cannot wait fifty minutes for the ladder sets
 *  NIGHT_SHIFT_TIME_SCALE=0.2 before the worker starts; the stop rule and
 *  the ladder cooldowns shrink together so the shape of the night is kept.
 *  Delay, gone-dark and off-route are not scaled: those are claims about
 *  the road, not about patience. The worker logs the scale at startup so a
 *  demo can never be mistaken for the road. */
export const TIME_SCALE = ((): number => {
  const raw = typeof process !== "undefined" ? process.env.NIGHT_SHIFT_TIME_SCALE : undefined;
  if (raw === undefined || raw === "") return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 1;
})();

// STOP_MIN, DELAY_BEHIND_PLAN_MIN, DARK_MIN, DARK_AT_STOP_MIN, OFF_ROUTE_MI,
// OFF_ROUTE_MIN, MAX_CALLS and CALL_RETRY_MIN used to live here as module
// constants. They are now `Policy` fields (core/policy.ts) — STANDARD holds
// their old values — because a dispatcher configures them per trip instead
// of an engineer editing this file. Every rule that read one of them now
// reads `policy.<field>` (scaled by TIME_SCALE exactly where the constant
// used to be — see policy.ts's field comments for which ones scale).

/** "At" a planned stop means inside this fence — matches DWELL_RADIUS_MI. */
export const PLANNED_STOP_RADIUS_MI = 0.5;
/** A mandatory break counts as on-plan anywhere in this window around when
 *  it is due. Drivers stop early for a good spot or late for a bad one. */
export const BREAK_WINDOW_SLACK_MIN = 45;
/** A rest stop is "the one on the plan" if within this of the break point. */
export const REST_STOP_SEARCH_MI = 35;

/** A position older than this is spoken of as "as of HH:MM", never as now.
 *  One missed reporting interval is noise; five minutes is a fact worth
 *  stating. */
export const STALE_FIX_MIN = 5;

/** Ladder cooldowns (spec §7). RUNG1/RUNG2 are fixed pacing between rungs,
 *  not policy — the retry-at-the-same-rung gap is `policy.rungGapMin`. */
export const RUNG1_COOLDOWN_MIN = 10 * TIME_SCALE;
export const RUNG2_COOLDOWN_MIN = 15 * TIME_SCALE;
/** If the link has not been opened this long, rung 2 also sends an SMS. */
export const LINK_UNOPENED_SMS_MIN = 30;

/** Arrival: inside this of the destination, stationary this long. */
export const ARRIVAL_RADIUS_MI = 0.5;
export const ARRIVAL_DWELL_MIN = 5;

/** No accept by departure + this is the first escalation. */
export const ACCEPT_GRACE_MIN = 30;

/** Below this the classifier says "unknown". Unknown stays unknown. */
export const CLASSIFY_FLOOR = 0.7;

/** Milliseconds in a minute. Every rule thinks in minutes and every clock in
 *  ms; this is the one place the conversion is written. */
export const MIN_MS = 60_000;

/** Sheet cadence while tracking (spec §8). Escalations write immediately. */
export const SHEET_WRITE_EVERY_MIN = 15;
/** A named landmark within this is how a place is described to a human:
 *  "near Bethany, MO" rather than a coordinate. */
export const LANDMARK_RADIUS_MI = 5;

/** Consecutive failed deliveries on one rung before "I could not reach him"
 *  becomes the news itself and goes to the dispatcher. Three: one is a blip,
 *  two is a pattern, three is a gateway that is down for the night. */
export const MAX_DELIVERY_FAILURES = 3;
