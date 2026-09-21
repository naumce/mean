// The plan: what the row implies once the road is known. Built at invite,
// consulted on every ping. Pure.
import { BREAK_DURATION_MIN, BREAK_THRESHOLD_MIN, breaksRequired, haversineMi } from "../domain.js";
import { BREAK_WINDOW_SLACK_MIN, MIN_MS, REST_STOP_SEARCH_MI } from "./constants.js";
import { pointAlongRoute, projectOntoRoute } from "./geo.js";
import { buildItinerary } from "./itinerary.js";
import type { Brief, BreakWindow, GeoPoint, Plan, RestStop, RouteAnswer } from "./types.js";

function nearestRestStop(at: GeoPoint, stops: RestStop[]): RestStop | null {
  let best: { stop: RestStop; mi: number } | null = null;
  for (const stop of stops) {
    const mi = haversineMi(at, stop);
    if (mi <= REST_STOP_SEARCH_MI && (!best || mi < best.mi)) best = { stop, mi };
  }
  return best?.stop ?? null;
}

export function buildPlan(brief: Brief, route: RouteAnswer, restStops: RestStop[]): Plan {
  // Every pace, ETA and "minutes behind" divides by these two. A zero or a
  // NaN from the provider makes all of them NaN, and NaN compares false
  // against every threshold — the agent would run the whole night and never
  // once notice anything. It refuses the route instead. (`!(x > 0)` catches
  // NaN, which `x <= 0` does not.)
  if (!(route.distanceMi > 0) || !(route.driveMin > 0)) throw new Error("route has no length or drive time");
  // The platform's own HOS rule decides whether a break is due on this run.
  // With no hours on file there is nothing to decide FROM: plan no break and
  // say so (hosKnown: false), rather than assume a fresh clock and later nag
  // a driver for a break the plan never knew he was owed.
  const hosKnown = brief.minutesSinceBreakAtDepart !== null;
  const sinceBreak = brief.minutesSinceBreakAtDepart ?? 0;
  const breaks = hosKnown ? breaksRequired(sinceBreak, route.driveMin) : 0;
  let breakWindow: BreakWindow | null = null;
  if (breaks >= 1) {
    const atDriveMin = Math.max(0, BREAK_THRESHOLD_MIN - sinceBreak);
    const at = pointAlongRoute(route.geometry, atDriveMin / route.driveMin);
    const dueMs = brief.departAtMs + atDriveMin * MIN_MS;
    breakWindow = {
      atDriveMin,
      at,
      startMs: dueMs - BREAK_WINDOW_SLACK_MIN * MIN_MS,
      endMs: dueMs + BREAK_WINDOW_SLACK_MIN * MIN_MS,
      recommended: nearestRestStop(at, restStops),
    };
  }
  return {
    route,
    itinerary: buildItinerary(brief, route, restStops),
    departAtMs: brief.departAtMs,
    deadlineAtMs: brief.deadlineAtMs,
    // Every geocoded stop the platform knows, so a planned intermediate
    // is never asked about as an unplanned stop. A brief without context
    // (file mode, replays) plans exactly what it always did.
    plannedStops: brief.context?.stops.length ? brief.context.stops.map(({ name, lat, lng }) => ({ name, lat, lng })) : [brief.origin, brief.destination],
    breakWindow,
    hosKnown,
    etaAtMs: brief.departAtMs + (route.driveMin + breaks * BREAK_DURATION_MIN) * MIN_MS,
  };
}

/** Planned average pace: the provider's distance over its drive time, so
 *  "on plan" means "at the pace the route was priced at". */
const milesPerMin = (plan: Plan): number => plan.route.distanceMi / plan.route.driveMin;

/** Miles the plan expects covered by wall-clock `nowMs`. Holds still for the
 *  break the truck is observed taking; failing that, for the break the plan
 *  expects. The window exists so a driver may take his legal 30 early at a
 *  good spot or late at a bad one — measuring him against a line that only
 *  pauses at the planned minute charges him the whole break as "behind plan",
 *  and with hours unknown there is no planned minute to pause at at all. */
export function expectedAlongMi(plan: Plan, nowMs: number, breakCreditMin = 0): number {
  let driveMin = (nowMs - plan.departAtMs) / MIN_MS;
  if (driveMin <= 0) return 0;
  const w = plan.breakWindow;
  if (breakCreditMin > 0) driveMin -= Math.min(BREAK_DURATION_MIN, breakCreditMin);
  else if (w && driveMin > w.atDriveMin) driveMin = Math.max(w.atDriveMin, driveMin - BREAK_DURATION_MIN);
  return Math.min(plan.route.distanceMi, Math.max(0, driveMin) * milesPerMin(plan));
}

export function planLinePoint(plan: Plan, nowMs: number, breakCreditMin = 0): GeoPoint {
  return pointAlongRoute(plan.route.geometry, expectedAlongMi(plan, nowMs, breakCreditMin) / plan.route.distanceMi);
}

/** Now + remaining miles at planned pace + whatever of the break is still
 *  owed. `breakCreditMin` is time already spent on a break in progress: a
 *  driver sixteen minutes into his thirty owes fourteen, not thirty. Charging
 *  him the full thirty projects an ETA past the deadline in the middle of the
 *  one stop the plan itself required — and then messages him for it. */
export function liveEtaMs(plan: Plan, at: GeoPoint, nowMs: number, breakTaken: boolean, breakCreditMin = 0): number {
  const { alongMi } = projectOntoRoute(plan.route.geometry, at);
  const remainingMi = Math.max(0, plan.route.distanceMi - alongMi);
  let remainingMin = remainingMi / milesPerMin(plan);
  if (plan.breakWindow && !breakTaken) remainingMin += Math.max(0, BREAK_DURATION_MIN - breakCreditMin);
  return nowMs + remainingMin * MIN_MS;
}

/** Positive = behind the plan line, negative = ahead. `breakCreditMin` moves
 *  the line to the break the truck is observed taking, so the thirty minutes
 *  the law requires are never counted against him. */
export function minutesBehindPlan(plan: Plan, at: GeoPoint, nowMs: number, breakCreditMin = 0): number {
  const { alongMi } = projectOntoRoute(plan.route.geometry, at);
  return (expectedAlongMi(plan, nowMs, breakCreditMin) - alongMi) / milesPerMin(plan);
}
