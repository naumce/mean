// The itinerary: the whole run laid out in time before the truck moves
// (slice 2, 2026-09-19). Where `Plan` answers "how far along should he be
// right now", the itinerary answers what a night dispatcher wants to see
// at a glance — every stop with its planned arrival, every legal break the
// clock forces and roughly where, whether the driver's remaining hours can
// even carry the run, and what that does to the delivery appointment.
//
// Pure over brief + route + rest stops. Every number that is a guess rather
// than a fact carries `assumed: true` so no screen renders it as measured
// (the same rule dwell/detention follow): a dwell the dispatcher never set,
// a fuel stop with no tank reading behind it.
import { BREAK_DURATION_MIN, BREAK_THRESHOLD_MIN, haversineMi } from "../domain.js";
import { MIN_MS, REST_STOP_SEARCH_MI } from "./constants.js";
import { pointAlongRoute, projectOntoRoute, routeMiles } from "./geo.js";
import type { Brief, BriefStop, GeoPoint, RestStop, RouteAnswer } from "./types.js";

/** Dwell planned at a stop the dispatcher gave no dwell for. */
export const ASSUMED_DWELL_MIN = 60;
/** FMCSA daily limits: 11 h driving, then a 10 h rest. */
export const DRIVE_LIMIT_MIN = 660;
export const REST_DURATION_MIN = 600;
/** A conservative class-8 range between fuel stops; a guess until the
 *  platform carries tank level, and marked as one. */
export const FUEL_RANGE_MI = 800;

export type LegKind = "drive" | "stop" | "wait" | "break" | "rest" | "fuel";

export interface ItineraryLeg {
  kind: LegKind;
  startMs: number;
  endMs: number;
  /** Where this leg happens (a stop) or ends (a drive). */
  at: GeoPoint & { name: string };
  /** Miles along the route where the leg happens / ends. */
  alongMi: number;
  /** Stop legs: the stop's type and window; `late` when the planned arrival
   *  is after the window closes. */
  stopType?: BriefStop["type"];
  windowStartMs?: number | null;
  windowEndMs?: number | null;
  late?: boolean;
  /** Set on any duration that is a planning assumption, not a fact. */
  assumed?: boolean;
  /** An assumed dwell that came from this place's own history rather than
   *  the flat default. */
  dwellSource?: "history";
  /** Break/rest/fuel: the nearest registered rest stop, when one is near. */
  recommended?: RestStop | null;
}

export interface Itinerary {
  legs: ItineraryLeg[];
  /** Arrival at the last stop. */
  etaAtMs: number;
  /** Minutes of slack against the delivery deadline; negative = late. */
  slackMin: number;
  breaks: number;
  rests: number;
  /** Null when the brief carries no HOS clock — nothing to judge against. */
  hos: { feasible: boolean; reason: string | null } | null;
  /** True when any duration in the itinerary is an assumption. */
  hasAssumptions: boolean;
}

interface Waypoint extends GeoPoint {
  name: string;
  type: BriefStop["type"];
  windowStartMs: number | null;
  windowEndMs: number | null;
  dwellMin: number | null;
}

function waypoints(brief: Brief): Waypoint[] {
  const stops = brief.context?.stops ?? [];
  if (stops.length >= 2) return stops.map((s) => ({ name: s.name, lat: s.lat, lng: s.lng, type: s.type, windowStartMs: s.windowStartMs, windowEndMs: s.windowEndMs, dwellMin: s.dwellMin }));
  return [
    { ...brief.origin, type: "pickup", windowStartMs: null, windowEndMs: brief.departAtMs, dwellMin: null },
    { ...brief.destination, type: "delivery", windowStartMs: null, windowEndMs: brief.deadlineAtMs, dwellMin: null },
  ];
}

function nearestRestStop(at: GeoPoint, stops: RestStop[]): RestStop | null {
  let best: { stop: RestStop; mi: number } | null = null;
  for (const stop of stops) {
    const mi = haversineMi(at, stop);
    if (mi <= REST_STOP_SEARCH_MI && (!best || mi < best.mi)) best = { stop, mi };
  }
  return best?.stop ?? null;
}

/** Miles along the route in the PROVIDER's miles. The geometry's own
 *  haversine length runs a little short of the provider's distance (curves
 *  between vertices), so a projection is rescaled to the distance every
 *  pace and ETA is priced in — otherwise the last stop lands a mile early. */
function alongRouteMi(route: RouteAnswer, p: GeoPoint): number {
  const geomMi = routeMiles(route.geometry);
  const { alongMi } = projectOntoRoute(route.geometry, p);
  return geomMi > 0 ? (alongMi * route.distanceMi) / geomMi : 0;
}

const hoursLabel = (min: number): string => {
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;
};

/** Walks the route stop by stop at the provider's pace, inserting what the
 *  clock forces along the way. The truck is at the pickup at the brief's
 *  `departAtMs` (the PU appointment), dwells there, then rolls — so the
 *  itinerary's ETA sits one pickup dwell later than `Plan.etaAtMs`, which
 *  treats that instant as wheels-turning. The plan line keeps measuring
 *  delay as it always has; the itinerary is what the dispatcher reads. */
export function buildItinerary(brief: Brief, route: RouteAnswer, restStops: RestStop[]): Itinerary {
  if (!(route.distanceMi > 0) || !(route.driveMin > 0)) throw new Error("route has no length or drive time");
  const pace = route.distanceMi / route.driveMin; // mi per min
  const points = waypoints(brief);
  const alongOf = points.map((p) => alongRouteMi(route, p));
  const hos = brief.context?.hos ?? null;
  const memory = brief.context?.memory ?? null;
  const hosKnown = brief.minutesSinceBreakAtDepart !== null;

  let nowMs = brief.departAtMs;
  let sinceBreak = brief.minutesSinceBreakAtDepart ?? 0;
  let drivenToday = hos ? DRIVE_LIMIT_MIN - hos.driveRemainingMin : 0;
  let sinceFuel = 0;
  let breaks = 0;
  let rests = 0;
  let hasAssumptions = false;
  const legs: ItineraryLeg[] = [];

  const place = (alongMi: number, name: string): GeoPoint & { name: string } => ({ ...pointAlongRoute(route.geometry, Math.min(1, Math.max(0, alongMi / route.distanceMi))), name });

  const arriveAt = (i: number): void => {
    const p = points[i];
    const at = { name: p.name, lat: p.lat, lng: p.lng };
    // Early for the window: wait until it opens — a real, planned stop.
    if (p.windowStartMs != null && nowMs < p.windowStartMs) {
      legs.push({ kind: "wait", startMs: nowMs, endMs: p.windowStartMs, at, alongMi: alongOf[i], stopType: p.type });
      nowMs = p.windowStartMs;
    }
    // Dwell: what the dispatcher set; failing that, what this place has
    // cost before (slice 4 memory, when there is a median to quote); failing
    // that, the flat assumption. The last two are both assumptions and say so.
    const remembered = memory?.places[p.name]?.medianDwellMin ?? null;
    const dwell = p.dwellMin ?? remembered ?? ASSUMED_DWELL_MIN;
    const assumed = p.dwellMin == null;
    if (assumed) hasAssumptions = true;
    legs.push({
      kind: "stop", startMs: nowMs, endMs: nowMs + dwell * MIN_MS, at, alongMi: alongOf[i],
      stopType: p.type, windowStartMs: p.windowStartMs, windowEndMs: p.windowEndMs,
      late: p.windowEndMs != null && nowMs > p.windowEndMs, assumed,
      ...(assumed && remembered !== null ? { dwellSource: "history" as const } : {}),
    });
    nowMs += dwell * MIN_MS;
  };

  arriveAt(0);
  for (let i = 1; i < points.length; i++) {
    let fromMi = alongOf[i - 1];
    const toMi = Math.max(fromMi, alongOf[i]);
    // Drive in pieces, stopping wherever the clock or the tank says so.
    while (fromMi < toMi) {
      const legMi = toMi - fromMi;
      const legMin = legMi / pace;
      const untilBreak = hosKnown ? Math.max(0, BREAK_THRESHOLD_MIN - sinceBreak) : Infinity;
      const untilRest = hos ? Math.max(0, DRIVE_LIMIT_MIN - drivenToday) : Infinity;
      const untilFuel = Math.max(0, FUEL_RANGE_MI - sinceFuel) / pace;
      const piece = Math.min(legMin, untilBreak, untilRest, untilFuel);
      if (piece > 0) {
        const endMi = fromMi + piece * pace;
        legs.push({ kind: "drive", startMs: nowMs, endMs: nowMs + piece * MIN_MS, at: place(endMi, endMi >= toMi - 1e-6 ? points[i].name : "en route"), alongMi: endMi });
        nowMs += piece * MIN_MS;
        sinceBreak += piece;
        drivenToday += piece;
        sinceFuel += piece * pace;
        fromMi = endMi;
      }
      if (fromMi >= toMi - 1e-6) break;
      const here = place(fromMi, "");
      const recommended = nearestRestStop(here, restStops);
      // Float tolerance: `piece` lands exactly on a limit, give or take rounding.
      const EPS = 1e-6;
      if (hos && drivenToday >= DRIVE_LIMIT_MIN - EPS) {
        legs.push({ kind: "rest", startMs: nowMs, endMs: nowMs + REST_DURATION_MIN * MIN_MS, at: { ...here, name: recommended?.name ?? "10-hour rest" }, alongMi: fromMi, recommended });
        nowMs += REST_DURATION_MIN * MIN_MS;
        drivenToday = 0;
        sinceBreak = 0;
        rests += 1;
      } else if (hosKnown && sinceBreak >= BREAK_THRESHOLD_MIN - EPS) {
        legs.push({ kind: "break", startMs: nowMs, endMs: nowMs + BREAK_DURATION_MIN * MIN_MS, at: { ...here, name: recommended?.name ?? "30-minute break" }, alongMi: fromMi, recommended });
        nowMs += BREAK_DURATION_MIN * MIN_MS;
        sinceBreak = 0;
        breaks += 1;
      } else if (sinceFuel >= FUEL_RANGE_MI - EPS) {
        legs.push({ kind: "fuel", startMs: nowMs, endMs: nowMs + 20 * MIN_MS, at: { ...here, name: recommended?.name ?? "fuel" }, alongMi: fromMi, recommended, assumed: true });
        nowMs += 20 * MIN_MS;
        sinceFuel = 0;
        hasAssumptions = true;
      } else {
        break; // nothing forced a stop; the loop's `piece` covered the rest
      }
    }
    arriveAt(i);
  }

  const last = legs[legs.length - 1];
  const arrival = [...legs].reverse().find((l) => l.kind === "stop") ?? last;
  const etaAtMs = arrival.startMs;
  const slackMin = (brief.deadlineAtMs - etaAtMs) / MIN_MS;

  let hosVerdict: Itinerary["hos"] = null;
  if (hos) {
    const driveMin = legs.filter((l) => l.kind === "drive").reduce((n, l) => n + (l.endMs - l.startMs) / MIN_MS, 0);
    const onDutyMin = legs.filter((l) => l.kind !== "rest" && l.kind !== "wait").reduce((n, l) => n + (l.endMs - l.startMs) / MIN_MS, 0);
    const reason = rests > 0
      ? `needs a 10-hour rest on the way: ${hoursLabel(driveMin)} drive against ${hoursLabel(hos.driveRemainingMin)} remaining`
      : onDutyMin > hos.windowRemainingMin
        ? `needs ${hoursLabel(onDutyMin)} on-duty; ${hoursLabel(hos.windowRemainingMin)} left in the 14h window`
        : onDutyMin > hos.cycleRemainingMin
          ? `needs ${hoursLabel(onDutyMin)} on-duty; ${hoursLabel(hos.cycleRemainingMin)} left in cycle`
          : null;
    hosVerdict = { feasible: reason === null, reason };
  }

  return { legs, etaAtMs, slackMin, breaks, rests, hos: hosVerdict, hasAssumptions };
}

/** The itinerary re-timed from where the truck actually is: legs at or
 *  behind the truck are done, the leg it is on keeps only what is left of
 *  it, and everything after shifts to start when that finishes. A break the
 *  agent observed the truck taking (`breakTaken`) is not planned twice. */
export function remainingItinerary(itin: Itinerary, route: RouteAnswer, at: GeoPoint, nowMs: number, breakTaken: boolean): Itinerary {
  const alongMi = alongRouteMi(route, at);
  const pace = route.distanceMi / route.driveMin;
  const idx = itin.legs.findIndex((l) => l.alongMi > alongMi + 0.5);
  const deadline = itin.etaAtMs + itin.slackMin * MIN_MS;
  if (idx < 0) return { ...itin, legs: [], etaAtMs: nowMs, slackMin: (deadline - nowMs) / MIN_MS };
  let cursor = nowMs;
  let creditedBreak = false;
  const legs: ItineraryLeg[] = [];
  for (let i = idx; i < itin.legs.length; i++) {
    const l = itin.legs[i];
    if (l.kind === "break" && breakTaken && !creditedBreak) { creditedBreak = true; continue; }
    const dur = i === idx && l.kind === "drive" ? (Math.max(0, l.alongMi - alongMi) / pace) * MIN_MS : l.endMs - l.startMs;
    legs.push({ ...l, startMs: cursor, endMs: cursor + dur, late: l.kind === "stop" && l.windowEndMs != null ? cursor > l.windowEndMs : l.late });
    cursor += dur;
  }
  const arrival = [...legs].reverse().find((l) => l.kind === "stop");
  const etaAtMs = arrival ? arrival.startMs : cursor;
  return { ...itin, legs, etaAtMs, slackMin: (deadline - etaAtMs) / MIN_MS };
}
