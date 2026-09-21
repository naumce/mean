// Detection rules. Deterministic: each returns an Anomaly with the evidence
// that fired it, or null. No rule ever guesses; the thresholds are named in
// constants.ts with their reasons. Task 5 adds delay, gone-dark and off-route
// to this file.
import { dwellSegments, haversineMi } from "../domain.js";
import { MIN_MS, PLANNED_STOP_RADIUS_MI, TIME_SCALE } from "./constants.js";
import { projectOntoRoute } from "./geo.js";
import { liveEtaMs, minutesBehindPlan } from "./plan.js";
import type { Policy } from "./policy.js";
import type { Anomaly, GeoPoint, Ping, Plan, RestStop } from "./types.js";

const near = (a: GeoPoint, b: GeoPoint, mi: number): boolean => haversineMi(a, b) <= mi;

/** Stationary at the latest position for policy.stopMin (scaled by
 *  TIME_SCALE, same as STOP_MIN was), away from every planned stop and every
 *  registered rest/fuel stop. A stop the truck has already left is not
 *  raised: there is nothing open to ask about. */
export function detectUnplannedStop(plan: Plan, policy: Policy, pings: Ping[], restStops: RestStop[], nowMs: number): Anomaly | null {
  if (pings.length === 0) return null;
  const last = pings[pings.length - 1];
  const stopMin = policy.stopMin * TIME_SCALE;

  // The fence is centred on where the truck IS. dwellSegments then tells us
  // how long it has evidently been there.
  const open = dwellSegments(pings, last).find((s) => !s.departureObserved && s.lastSeenMs === last.atMs);
  if (!open || open.observedMin < stopMin) return null;

  if (plan.plannedStops.some((s) => near(s, last, PLANNED_STOP_RADIUS_MI))) return null;

  // A registered rest or fuel stop is a legitimate place to be stopped — in
  // the break window it is compliance, outside it it is fueling or rest. A
  // stop long enough to cost the deadline is the delay rule's business.
  if (restStops.some((r) => near(r, last, PLANNED_STOP_RADIUS_MI))) return null;

  const w = plan.breakWindow;
  const inBreakWindow = !!w && open.firstSeenMs >= w.startMs && open.firstSeenMs <= w.endMs;

  return {
    kind: "unplanned_stop",
    key: "unplanned_stop@" + open.firstSeenMs,
    atMs: nowMs,
    evidence: {
      firstSeenMs: open.firstSeenMs,
      lastSeenMs: open.lastSeenMs,
      observedMin: Math.round(open.observedMin),
      pingCount: open.pingCount,
      at: { lat: last.lat, lng: last.lng },
      thresholdMin: stopMin,
      inBreakWindow,
    },
  };
}

/** Live ETA past the deadline, or more than policy.delayMin behind the plan
 *  line (NOT scaled by TIME_SCALE — a claim about the road, not about
 *  patience, same as DELAY_BEHIND_PLAN_MIN was). The key is constant: a
 *  delay is one situation for the whole trip, and re-raising it on every
 *  ping would restart the ladder forever.
 *
 *  `asOfMs` is when the position `at` was actually taken. It is carried in
 *  the evidence with its age so that everything downstream can say "as of
 *  07:50" instead of speaking an hour-old fix as if it were now. */
export function detectDelay(plan: Plan, policy: Policy, at: GeoPoint, asOfMs: number, nowMs: number, breakTaken: boolean, breakCreditMin = 0): Anomaly | null {
  const etaMs = liveEtaMs(plan, at, nowMs, breakTaken, breakCreditMin);
  const behindMin = minutesBehindPlan(plan, at, nowMs, breakCreditMin);
  const pastDeadline = etaMs > plan.deadlineAtMs;
  const behindPlan = behindMin > policy.delayMin;
  if (!pastDeadline && !behindPlan) return null;
  return {
    kind: "delay",
    key: "delay",
    atMs: nowMs,
    evidence: {
      etaMs,
      deadlineAtMs: plan.deadlineAtMs,
      behindMin: Math.round(behindMin),
      thresholdBehindMin: policy.delayMin,
      pastDeadline,
      behindPlan,
      at: { lat: at.lat, lng: at.lng },
      asOfMs,
      fixAgeMin: Math.round((nowMs - asOfMs) / MIN_MS),
      // With no hours on file the plan carries no break, so this ETA is a
      // drive-only figure. Everything that repeats it has to say so.
      hosKnown: plan.hosKnown,
    },
  };
}

/** No ping for policy.darkMin — or policy.darkAtStopMin if the last one was
 *  at a stop, where a phone loses GPS indoors. Neither is scaled by
 *  TIME_SCALE (same as DARK_MIN / DARK_AT_STOP_MIN were). */
export function detectGoneDark(plan: Plan, policy: Policy, pings: Ping[], restStops: RestStop[], nowMs: number): Anomaly | null {
  if (pings.length === 0) return null;
  const last = pings[pings.length - 1];
  const gapMin = (nowMs - last.atMs) / MIN_MS;
  const atStop =
    plan.plannedStops.some((s) => near(s, last, PLANNED_STOP_RADIUS_MI)) ||
    restStops.some((r) => near(r, last, PLANNED_STOP_RADIUS_MI));
  const limitMin = atStop ? policy.darkAtStopMin : policy.darkMin;
  if (gapMin < limitMin) return null;
  return {
    kind: "gone_dark",
    key: "gone_dark@" + last.atMs,
    atMs: nowMs,
    evidence: { lastPingMs: last.atMs, gapMin: Math.round(gapMin), limitMin, atStop, lastAt: { lat: last.lat, lng: last.lng } },
  };
}

/** The contiguous run of pings, ending at the latest one, that all sit more
 *  than policy.offRouteMi from the line — raised once that run has lasted
 *  policy.offRouteMin (neither scaled by TIME_SCALE, same as OFF_ROUTE_MI /
 *  OFF_ROUTE_MIN were). The key is anchored to the run's FIRST ping, so the
 *  same excursion keeps the same key however long it lasts; a trailing-
 *  window key slides a minute per tick and the ladder can never find its own
 *  entry. One ping back on the route ends the run, and with it the anomaly. */
export function detectOffRoute(plan: Plan, policy: Policy, pings: Ping[], nowMs: number): Anomaly | null {
  if (pings.length === 0) return null;
  const offs: number[] = [];
  let start = pings.length;
  for (let i = pings.length - 1; i >= 0; i -= 1) {
    const off = projectOntoRoute(plan.route.geometry, pings[i]).offRouteMi;
    if (off <= policy.offRouteMi) break;
    offs.push(off);
    start = i;
  }
  if (offs.length < 2) return null;
  const first = pings[start];
  const last = pings[pings.length - 1];
  const minutes = (last.atMs - first.atMs) / MIN_MS;
  if (minutes < policy.offRouteMin) return null;
  return {
    kind: "off_route",
    key: "off_route@" + first.atMs,
    atMs: nowMs,
    evidence: { sinceMs: first.atMs, minutes: Math.round(minutes), minOffRouteMi: Math.min(...offs), thresholdMi: policy.offRouteMi },
  };
}

export function detectAnomalies(plan: Plan, policy: Policy, pings: Ping[], restStops: RestStop[], nowMs: number, breakTaken: boolean, breakCreditMin = 0): Anomaly[] {
  const out: Anomaly[] = [];
  const stop = detectUnplannedStop(plan, policy, pings, restStops, nowMs);
  if (stop) out.push(stop);
  if (pings.length > 0) {
    const last = pings[pings.length - 1];
    const delay = detectDelay(plan, policy, last, last.atMs, nowMs, breakTaken, breakCreditMin);
    if (delay) out.push(delay);
  }
  const dark = detectGoneDark(plan, policy, pings, restStops, nowMs);
  if (dark) out.push(dark);
  const off = detectOffRoute(plan, policy, pings, nowMs);
  if (off) out.push(off);
  return out;
}
