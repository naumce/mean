import { prisma } from "../db.js";
import { deliveryWindowEndOf, isLateAssignment, lateMinutes } from "./onTime.js";
import { laneKey } from "./lanes.js";
import { cityStateFromAddress } from "./driverAvailability.js";
import { scanDetention, type StopDetention } from "./detentionScan.js";
import { responseMetricsFor, type TripForResponseMetrics } from "./driverResponseMetrics.js";

// Driver metrics (AI Dispatch Foundation, Task 4): every field here replays
// rows that already exist — completed assignments and their stops/
// appointments, scanDetention's own claims, and the Night Shift agent's own
// event trail (AgentTrip/AgentEvent). Nothing subjective or self-reported
// (no "reliability", no "rating") is ever mixed in — a number that cannot be
// traced back to a row does not belong on this type. See
// driverResponseMetrics.ts for the Night-Shift-evidence half of this file.

const DETENTION_LOOKBACK_DAYS = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * MS_PER_DAY;
const LANE_EXPERIENCE_LIMIT = 10;
// "Night" per the brief: plannedStart, in the ORG's own timezone, at or after
// 20:00 or before 06:00.
const NIGHT_START_HOUR = 20;
const NIGHT_END_HOUR = 6;
const DEFAULT_TIMEZONE = "America/Chicago"; // Org.timezone's own schema default

export interface LaneExperience {
  laneKey: string;
  originCity: string | null;
  destCity: string | null;
  runs: number;
  lastRunAt: Date | null;
}

export interface DriverMetrics {
  driverId: string;
  asOf: Date;
  completedLoads: number;
  onTimeLoads: number;
  lateLoads: number;
  onTimeRate: number | null;
  averageDelayMinutes: number | null;
  averageDetentionMinutes: number | null;
  averageResponseMinutes: number | null;
  responseRate: number | null;
  noResponseIncidents: number;
  breakdownIncidents: number;
  accidentIncidents: number;
  loadsLast30Days: number;
  nightLoads: number;
  laneExperience: LaneExperience[];
  evidence: { assignments: number; agentTrips: number; agentEvents: number };
}

interface StopRow {
  type: string;
  address: string;
  lat: number | null;
  lng: number | null;
  appointment: { windowEnd: Date } | null;
}

interface AssignmentRow {
  driverId: string;
  loadId: string;
  plannedStart: Date;
  completedAt: Date | null;
  load: { stops: StopRow[] };
}

// ---------------------------------------------------------------------------
// Lane-of-stops (pickup/delivery BY TYPE — lib/lanes.ts's own convention)
// ---------------------------------------------------------------------------

/**
 * An assignment's lane by PICKUP/DELIVERY stop TYPE — the identical rule
 * lib/lanes.ts's laneKeyOfLoad/laneFamiliarity/laneRunCounts already use
 * (never customers.ts's simpler by-POSITION rule, a deliberately coarser
 * convention for that file's own display-only rollup).
 *
 * Reimplemented here rather than calling lanes.ts's laneRunCounts: that
 * function runs its OWN `assignment.findMany`, and driverMetricsBatch must
 * stay at a fixed number of queries no matter how many driverIds it is
 * given (brief) — calling laneRunCounts once per driver would make the query
 * count grow with the batch. This runs the same rule over stops the ONE
 * assignments query below already fetched. Exported so the
 * /drivers/:id/history route (dispatcherDriverSupply.ts) can label each row
 * the same way without a third copy of the rule.
 */
export function laneOfAssignmentStops(
  stops: { type: string; address: string; lat: number | null; lng: number | null }[],
): { key: string; originCity: string | null; destCity: string | null } | null {
  const pickup = stops.find((s) => s.type === "pickup");
  const delivery = [...stops].reverse().find((s) => s.type === "delivery");
  if (pickup?.lat == null || pickup.lng == null || delivery?.lat == null || delivery.lng == null) return null;
  return {
    key: laneKey({ lat: pickup.lat, lng: pickup.lng }, { lat: delivery.lat, lng: delivery.lng }),
    originCity: cityStateFromAddress(pickup.address).city,
    destCity: cityStateFromAddress(delivery.address).city,
  };
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function meanOf(values: number[]): number | null {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

/** `null` beats any Date the other way — a lane's most-recent-run never
 *  loses to a run whose completion time is unknown. */
function laterOf(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/** The hour (0-23) `date` falls on in `timeZone`, via Intl rather than a new
 *  dependency (brief). `hour12: false` formats midnight as "24" rather than
 *  "00" on some ICU builds — `% 24` normalizes either spelling. */
function hourInTimeZone(date: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone })
    .formatToParts(date)
    .find((part) => part.type === "hour")?.value;
  return Number(hour ?? 0) % 24;
}

function isNightLoad(plannedStart: Date, timeZone: string): boolean {
  const hour = hourInTimeZone(plannedStart, timeZone);
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

// ---------------------------------------------------------------------------
// Per-driver aggregation over already-fetched rows (no further queries)
// ---------------------------------------------------------------------------

interface OnTimeStats {
  onTimeLoads: number;
  lateLoads: number;
  onTimeRate: number | null;
  averageDelayMinutes: number | null;
}

/** Late/on-time exactly as Task 3 (onTime.ts): a completed load with no
 *  delivery window to measure against is evaluable in NEITHER half of the
 *  rate, not folded into "on time" by omission. */
function onTimeStatsFor(assignments: AssignmentRow[]): OnTimeStats {
  let lateLoads = 0;
  let evaluable = 0;
  const delays: number[] = [];

  for (const a of assignments) {
    const windowEnd = deliveryWindowEndOf(a.load.stops);
    const late = isLateAssignment(a.completedAt, windowEnd);
    if (late === null) continue;
    evaluable += 1;
    if (late) {
      lateLoads += 1;
      const minutes = lateMinutes(a.completedAt, windowEnd);
      if (minutes !== null) delays.push(minutes);
    }
  }

  const onTimeLoads = evaluable - lateLoads;
  return {
    onTimeLoads,
    lateLoads,
    onTimeRate: evaluable === 0 ? null : onTimeLoads / evaluable,
    averageDelayMinutes: meanOf(delays),
  };
}

/** Top LANE_EXPERIENCE_LIMIT lanes this driver has actually run, most-run
 *  first (ties broken by most-recent) — the brief's exact ordering. */
function laneExperienceFor(assignments: AssignmentRow[]): LaneExperience[] {
  const byLane = new Map<string, LaneExperience>();
  for (const a of assignments) {
    const lane = laneOfAssignmentStops(a.load.stops);
    if (!lane) continue;
    const existing = byLane.get(lane.key);
    // Replace, never mutate the stored accumulator (same style as
    // lib/customers.ts's and lib/lanes.ts's own lane rollups).
    byLane.set(
      lane.key,
      existing
        ? { ...existing, runs: existing.runs + 1, lastRunAt: laterOf(existing.lastRunAt, a.completedAt) }
        : { laneKey: lane.key, originCity: lane.originCity, destCity: lane.destCity, runs: 1, lastRunAt: a.completedAt },
    );
  }
  return [...byLane.values()]
    .sort((a, b) => b.runs - a.runs || (b.lastRunAt?.getTime() ?? 0) - (a.lastRunAt?.getTime() ?? 0))
    .slice(0, LANE_EXPERIENCE_LIMIT);
}

/** Mean of this driver's OWED detention claims only (`claim !== null`) —
 *  scanDetention also reports a real, well-evidenced dwell that stayed
 *  inside the agreed free time (`claim: null`), and that must never pull
 *  this average toward zero the way including it would. */
function averageDetentionMinutesFor(driverId: string, detentions: StopDetention[]): number | null {
  const billableMinutes = detentions
    .filter((d) => d.driverId === driverId && d.claim !== null)
    .map((d) => d.claim!.billableMin);
  return meanOf(billableMinutes);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Metrics for every id in `driverIds`, batched: ONE `assignment.findMany`
 * covering every requested driver, ONE `agentTrip.findMany` covering every
 * load those assignments touch, and ONE `scanDetention` call — never one of
 * these per driver, so the query count stays fixed no matter how long
 * `driverIds` is (the candidate-ranking path this exists for, Task 6, can
 * call this with a whole org's worth of drivers). A driver with zero
 * completed assignments still gets an entry: every rate null, every count
 * zero — "no evidence" is itself a fact this function reports, not an
 * omission.
 */
export async function driverMetricsBatch(
  orgId: string,
  driverIds: string[],
  nowMs: number = Date.now(),
): Promise<Map<string, DriverMetrics>> {
  const result = new Map<string, DriverMetrics>();
  const uniqueIds = [...new Set(driverIds)];
  if (uniqueIds.length === 0) return result;

  const asOf = new Date(nowMs);
  const detentionSinceMs = nowMs - DETENTION_LOOKBACK_DAYS * MS_PER_DAY;

  // Three independent fetches, run together — none depends on another. The
  // assignments query is NOT filtered to status "completed": it also has to
  // resolve which driver an AgentTrip's load belongs to (below), and a trip
  // is normally still live while its assignment is "in_progress" — the brief
  // excludes a trip only when its "load has no assignment" at all, never by
  // that assignment's status. Completed-load metrics (on-time, lane
  // experience, night loads, loadsLast30Days) filter this same result down
  // to `status === "completed"` in memory instead, so there is still exactly
  // ONE assignments query regardless of how many driverIds are asked for.
  const [assignments, org, detentions] = await Promise.all([
    prisma.assignment.findMany({
      where: { orgId, driverId: { in: uniqueIds } },
      select: {
        driverId: true,
        loadId: true,
        status: true,
        plannedStart: true,
        completedAt: true,
        load: {
          select: {
            stops: {
              orderBy: { sequence: "asc" },
              select: { type: true, address: true, lat: true, lng: true, appointment: { select: { windowEnd: true } } },
            },
          },
        },
      },
    }),
    prisma.org.findUnique({ where: { id: orgId }, select: { timezone: true } }),
    scanDetention(orgId, detentionSinceMs),
  ]);

  const timezone = org?.timezone ?? DEFAULT_TIMEZONE;

  // Trip attribution (below) uses EVERY assignment, any status; the
  // completed-load metrics use only the completed subset.
  const driverIdByLoadId = new Map<string, string>();
  for (const a of assignments) driverIdByLoadId.set(a.loadId, a.driverId);

  const completedAssignments = assignments.filter((a) => a.status === "completed");
  const assignmentsByDriver = new Map<string, AssignmentRow[]>();
  for (const a of completedAssignments) {
    const list = assignmentsByDriver.get(a.driverId);
    if (list) list.push(a);
    else assignmentsByDriver.set(a.driverId, [a]);
  }

  // One findMany for every trip on any of these loads — `loadIds` already
  // spans every requested driver, so this never runs per-driver.
  const loadIds = assignments.map((a) => a.loadId);
  const trips = loadIds.length
    ? await prisma.agentTrip.findMany({
        where: { loadId: { in: loadIds } },
        select: { loadId: true, events: { orderBy: { atMs: "asc" }, select: { atMs: true, kind: true, evidence: true } } },
      })
    : [];

  const tripsByDriver = new Map<string, TripForResponseMetrics[]>();
  for (const trip of trips) {
    // A trip with no loadId, or one whose load has no assignment in this
    // batch (never assigned, or assigned to a driver outside `driverIds`),
    // belongs to nobody this call can attribute it to.
    const driverId = trip.loadId ? driverIdByLoadId.get(trip.loadId) : undefined;
    if (!driverId) continue;
    const list = tripsByDriver.get(driverId);
    if (list) list.push({ events: trip.events });
    else tripsByDriver.set(driverId, [{ events: trip.events }]);
  }

  for (const driverId of uniqueIds) {
    const driverAssignments = assignmentsByDriver.get(driverId) ?? [];
    const driverTrips = tripsByDriver.get(driverId) ?? [];
    const onTime = onTimeStatsFor(driverAssignments);
    const response = responseMetricsFor(driverTrips);

    const loadsLast30Days = driverAssignments.filter(
      (a) => a.completedAt !== null && a.completedAt.getTime() >= nowMs - THIRTY_DAYS_MS,
    ).length;
    const nightLoads = driverAssignments.filter((a) => isNightLoad(a.plannedStart, timezone)).length;

    result.set(driverId, {
      driverId,
      asOf,
      completedLoads: driverAssignments.length,
      onTimeLoads: onTime.onTimeLoads,
      lateLoads: onTime.lateLoads,
      onTimeRate: onTime.onTimeRate,
      averageDelayMinutes: onTime.averageDelayMinutes,
      averageDetentionMinutes: averageDetentionMinutesFor(driverId, detentions),
      averageResponseMinutes: response.averageResponseMinutes,
      responseRate: response.responseRate,
      noResponseIncidents: response.noResponseIncidents,
      breakdownIncidents: response.breakdownIncidents,
      accidentIncidents: response.accidentIncidents,
      loadsLast30Days,
      nightLoads,
      laneExperience: laneExperienceFor(driverAssignments),
      evidence: {
        assignments: driverAssignments.length,
        agentTrips: driverTrips.length,
        agentEvents: driverTrips.reduce((sum, t) => sum + t.events.length, 0),
      },
    });
  }

  return result;
}

/** One driver, implemented as `driverMetricsBatch` for a single id (brief) —
 *  never a second, drifting implementation of the same aggregation. */
export async function driverMetrics(orgId: string, driverId: string, nowMs: number = Date.now()): Promise<DriverMetrics> {
  const batch = await driverMetricsBatch(orgId, [driverId], nowMs);
  // driverMetricsBatch sets an entry for every id in its OWN de-duplicated
  // input list, which here is exactly `[driverId]` — this can never miss.
  return batch.get(driverId)!;
}
