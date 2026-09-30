// Shared numeric contract between the generator (drivers.mjs/history.mjs/
// current.mjs/seed-world.mjs) and tests/seed-world.test.ts. Every baseline
// count below is a FULL-SCALE (scale=1) figure; `scaled()` applies `scale`
// the same way everywhere so the test's expectations can never drift from
// what the generator actually computes — both sides import THIS file rather
// than each hand-copying the brief's numbers.
//
// Scale multiplies only the BULK counts. The *_CAST_SIZE / SCENARIO_*
// constants below are therefore never multiplied by scale — they are added
// on top of a scaled bulk count, exactly like a scaled driver count is
// "cast + round(150*scale)", never "round((150+cast)*scale)".

export const ORG_NAME = "Great Lakes Freight Co";
export const ORG_TIMEZONE = "America/Detroit";
export const DISPATCHER_EMAIL = "w@fleet.com";
export const DISPATCHER_PASSWORD = "pass123";
export const AGENT_POLICY_NAME = "Standard";
export const WORLD_LOAD_TAG = "W-";
export const WORLD_DRIVER_TAG = "WD-";
export const DRIVER_EMAIL_DOMAIN = "greatlakes.demo";

/** Round-half-up, applied consistently everywhere a baseline is scaled. */
export function scaled(baseline, scale) {
  return Math.round(baseline * scale);
}

// ---------------------------------------------------------------------------
// Customers — the 20 customers are fixed regardless of scale, always created
// in full.
// ---------------------------------------------------------------------------
export const CUSTOMER_COUNT = 20;
export const HIGH_PRIORITY_CUSTOMER_COUNT = 3;

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------
/** 13 lettered-scenario drivers (A,B,C,D,E,F,G,I,J,K,L,M,N — H has no driver
 *  of its own) + 2 dedicated "breakdown/accident evidence" drivers never
 *  referenced by a scenario letter. Fixed regardless of scale. */
export const SCENARIO_CAST_SIZE = 15;
export const BULK_DRIVER_BASELINE = 150;

export const EQUIPMENT_MIX = [
  { value: "DryVan", weight: 0.55 },
  { value: "Reefer", weight: 0.25 },
  { value: "Flatbed", weight: 0.15 },
  { value: "Tanker", weight: 0.05 },
];
export const HAZMAT_RATE = 0.2;
export const LOCATION_SHARING_RATE = 0.8;
export const SECOND_LANGUAGE_RATE = 0.4;

// ---------------------------------------------------------------------------
// Historical loads
// ---------------------------------------------------------------------------
export const HISTORICAL_BASELINE = 3000;
export const LANE_COUNT = 60;
export const HISTORICAL_LOOKBACK_DAYS = 180;

export const LATE_RATE = 0.12;
export const LATE_MIN_MINUTES = 20;
export const LATE_MAX_MINUTES = 240;
export const DETENTION_RATE = 0.15;
export const NIGHT_LOAD_RATE = 0.1;

/** Of every generic historical load: ESCALATION_RATE get a trip with an ask
 *  and a no-reply escalation (no reply at all); the next TRIP_RATE -
 *  ESCALATION_RATE get a trip with an ask, most of which (REPLY_GIVEN_RATE)
 *  also get a reply. Together these realize "~20% with a trip" and "~8%
 *  no-reply escalations" as two disjoint slices of the same 20%, rather than
 *  two independently-rolled (and therefore sometimes-overlapping,
 *  sometimes-short-of-target) events. */
export const TRIP_RATE = 0.2;
export const ESCALATION_RATE = 0.08;
export const REPLY_GIVEN_RATE = 0.8;

/** Milan Petrovski (scenario A): exactly 50 completed loads, 48 on time —
 *  exact numbers, asserted verbatim through driverMetrics(). */
export const MILAN_COMPLETED = 50;
export const MILAN_ON_TIME = 48;

/** Dwayne Okafor (scenario B): 18 asks / 11 replies -> responseRate 11/18 ~=
 *  0.611 ("61%"), and exactly 3 no-response escalations. One trip per load,
 *  one ask per trip (driverResponseMetrics.ts's per-trip open/close state
 *  machine), so 18 loads carries exactly 18 opened questions. */
export const DWAYNE_COMPLETED = 18;
export const DWAYNE_REPLIED = 11;
export const DWAYNE_ESCALATIONS = 3;

/** Marcus Webb (scenario F): 14 completed runs on the EXACT Chicago >
 *  Nashville lane key W-F-LANE's own load uses (same hub coordinates), so
 *  laneRunsByDriver(orgId, thatLaneKey) reports exactly 14 for him. */
export const MARCUS_LANE_RUNS = 14;

/** Two more dedicated drivers (not tied to any scenario letter) whose
 *  reply evidence realizes 6 breakdowns and 2 accidents total across
 *  specific drivers — situationKey-tagged replies, never a stored rating. */
export const BORIS_COMPLETED = 5;
export const BORIS_BREAKDOWNS = 4;
export const BORIS_ACCIDENTS = 1;
export const CHIDI_COMPLETED = 3;
export const CHIDI_BREAKDOWNS = 2;
export const CHIDI_ACCIDENTS = 1;

export const TOTAL_BREAKDOWN_INCIDENTS = BORIS_BREAKDOWNS + CHIDI_BREAKDOWNS; // 6
export const TOTAL_ACCIDENT_INCIDENTS = BORIS_ACCIDENTS + CHIDI_ACCIDENTS; // 2

export const NAMED_HISTORY_RESERVE = MILAN_COMPLETED + DWAYNE_COMPLETED + BORIS_COMPLETED + CHIDI_COMPLETED + MARCUS_LANE_RUNS;

// ---------------------------------------------------------------------------
// Current / future loads
// ---------------------------------------------------------------------------
/** Generic bulk baseline (full scale); the 14 scenario-current loads (8 open
 *  + 6 in_progress — M is historical, H needs no driver-bearing load beyond
 *  itself) are added on top, unscaled, exactly like SCENARIO_CAST_SIZE is
 *  for drivers. "Open" folds in the brief's separate "rest next-week" bucket
 *  — both are status "open", differing only in how far out the pickup
 *  window sits. */
export const CURRENT_OPEN_BASELINE = 80;
export const CURRENT_ASSIGNED_BASELINE = 80;
export const CURRENT_IN_PROGRESS_BASELINE = 40;
export const CURRENT_TENDERED_BASELINE = 10;

export const SCENARIO_OPEN_LOADS = 8; // A B C D E F G H
export const SCENARIO_IN_PROGRESS_LOADS = 6; // Ana's inbound + I J K L N

export const NEAR_TERM_PICKUP_HOURS = 48;
export const NEXT_WEEK_MIN_DAYS = 7;
export const NEXT_WEEK_MAX_DAYS = 13;
/** Share of "open" bulk loads whose pickup is next-week rather than
 *  near-term (next 48h) — flavor split within one DB status, not a separate
 *  status of its own. */
export const NEXT_WEEK_SHARE_OF_OPEN = 0.4;

// ---------------------------------------------------------------------------
// Own fleet (tractors/trailers) — flavor, not asserted by any test.
// ---------------------------------------------------------------------------
export const FLEET_BASELINE = 80;
export const FLEET_MINIMUM = 10;

export function fleetCount(scale) {
  return Math.max(FLEET_MINIMUM, scaled(FLEET_BASELINE, scale));
}

// ---------------------------------------------------------------------------
// Night Shift agent mix (seed-mix-brief.md, 2026-09-30): a small, honest set
// of agentEnabled loads instead of "every load the generic ~20% roll or a
// named driver's history happened to touch" — see history.mjs/namedHistory.mjs
// (history goes dark) and scenarioActive.mjs (the live mix) for where these
// are actually applied.
// ---------------------------------------------------------------------------

/** E.164, reserved fictional block +1 NPA 555 01xx (312 = Chicago). Only the
 *  cast drivers below ever get a `Driver.phone` — every bulk driver and every
 *  other cast member (including the deliberate missing-phone one) stays
 *  null. Keyed by cast.mjs's own `key`, read by drivers.mjs's castToSpec(). */
export const CAST_PHONES = {
  ana: "+13125550101",
  hassan: "+13125550102",
  wei: "+13125550103",
  dwayne: "+13125550104",
};

/** Dwayne's three most recent delivered loads (rule 3): the only historical
 *  loads that keep `agentEnabled: true`/`agentPill: "delivered"` once history
 *  otherwise goes dark. Exported so the test can name them without having to
 *  re-derive Dwayne's own PRNG draws. namedHistory.mjs's buildDwayneHistory()
 *  forces exactly these three to the smallest `daysAgo` among his 18 loads,
 *  so "most recent" is true by construction, not just by label. */
export const DWAYNE_DELIVERED_EXTERNAL_IDS = ["W-DWAYNE-009", "W-DWAYNE-010", "W-DWAYNE-011"];
