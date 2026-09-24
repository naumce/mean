import { prisma } from "../db.js";
import { laneKey } from "./lanes.js";
import { cityStateFromAddress } from "./driverAvailability.js";
import { scanDetention } from "./detentionScan.js";
import { deliveryWindowEndOf, isLateAssignment } from "./onTime.js";

// Customer service (AI Dispatch Foundation, Task 3): the read side of the
// real Customer entity loadWriter.ts's deriveCustomer links loads to.
// customerHistory is the one piece of actual logic here — plain CRUD lives
// directly in the route (dispatcherCustomers.ts), the same convention
// dispatcherCarriers.ts already uses (there is no separate "carriers
// service" file either).

const DETENTION_LOOKBACK_DAYS = 180;
const COMMON_LANES_LIMIT = 5;

export interface CommonLane { laneKey: string; originCity: string | null; destCity: string | null; runs: number }

export interface CustomerHistory {
  totalLoads: number;
  completedLoads: number;
  lateLoads: number;
  /** on-time / evaluable completed loads; null when nothing was evaluable —
   *  no completed load had both a completedAt and a delivery window to
   *  measure it against (see onTime.ts). */
  onTimeRate: number | null;
  commonLanes: CommonLane[];
  /** how many of this customer's stops carry OWED detention — not merely
   *  observed dwell. `scanDetention` also reports a real, well-evidenced
   *  dwell that stayed inside the agreed free time (`claim: null`, a true,
   *  useful fact shown elsewhere), and that must never inflate this count. */
  detentionEvents: number;
  lastLoadAt: Date | null;
}

interface StopForHistory {
  type: string;
  address: string;
  lat: number | null;
  lng: number | null;
  appointment: { windowEnd: Date } | null;
}

/** This load's lane: its first stop to its last stop, BY POSITION
 *  (sequence order) — the brief's own "first/last stop" wording for this
 *  summary, deliberately simpler than laneFamiliarity's pickup/delivery-BY-
 *  TYPE lookup (that precision matters for scoring a driver; a customer's
 *  lane list is a coarser, display-only rollup). `null` when either end has
 *  no fix yet — an ungeocoded stop cannot bucket into a lane key at all. */
function laneOf(stops: StopForHistory[]): { key: string; originCity: string | null; destCity: string | null } | null {
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last || first.lat == null || first.lng == null || last.lat == null || last.lng == null) return null;
  return {
    key: laneKey({ lat: first.lat, lng: first.lng }, { lat: last.lat, lng: last.lng }),
    originCity: cityStateFromAddress(first.address).city,
    destCity: cityStateFromAddress(last.address).city,
  };
}

/**
 * A customer's whole track record with this org: volume, on-time
 * performance, its most-run lanes, and how often detention has been owed on
 * its loads — everything a customer detail page needs in one call.
 *
 * `completed` = `Assignment.status === "completed"` on the customer's loads
 * (a load with no assignment at all, or one still running, still counts in
 * `totalLoads` but not `completedLoads`). `onTimeRate` measures only the
 * completed loads that are evaluable at all: a completed load with no
 * delivery appointment is real volume, not a late one, and must not
 * silently drag the rate toward "on time" or "late" either way.
 */
export async function customerHistory(orgId: string, customerId: string): Promise<CustomerHistory> {
  const loads = await prisma.load.findMany({
    where: { orgId, customerId },
    select: {
      id: true,
      createdAt: true,
      assignment: { select: { status: true, completedAt: true } },
      stops: {
        orderBy: { sequence: "asc" },
        select: { type: true, address: true, lat: true, lng: true, appointment: { select: { windowEnd: true } } },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const totalLoads = loads.length;
  // createdAt, not shipDate: every load has one, and a broker row's shipDate
  // can itself be the very cell loadWriter refused to read ("can't read SHIP
  // DATE") — this column is never absent the way that one can be.
  const lastLoadAt = loads[0]?.createdAt ?? null;

  const completed = loads.filter((l) => l.assignment?.status === "completed");
  const completedLoads = completed.length;

  let lateLoads = 0;
  let evaluable = 0;
  const lanes = new Map<string, CommonLane>();

  for (const load of completed) {
    const late = isLateAssignment(load.assignment!.completedAt, deliveryWindowEndOf(load.stops));
    if (late !== null) {
      evaluable += 1;
      if (late) lateLoads += 1;
    }
    const lane = laneOf(load.stops);
    if (lane) {
      const existing = lanes.get(lane.key);
      // Replace, never mutate the stored accumulator — same immutable-update
      // style as the route's own `({ stops, ...load }) => ({ ...load, ... })`.
      lanes.set(lane.key, existing
        ? { ...existing, runs: existing.runs + 1 }
        : { laneKey: lane.key, originCity: lane.originCity, destCity: lane.destCity, runs: 1 });
    }
  }

  const onTimeRate = evaluable === 0 ? null : (evaluable - lateLoads) / evaluable;
  const commonLanes = [...lanes.values()].sort((a, b) => b.runs - a.runs).slice(0, COMMON_LANES_LIMIT);

  const sinceMs = Date.now() - DETENTION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const detentions = await scanDetention(orgId, sinceMs);
  const loadIds = new Set(loads.map((l) => l.id));
  // `d.claim !== null` is the whole point: scanDetention returns a row for
  // every stop it could observe a real dwell at, INCLUDING one that stayed
  // within the agreed free time (StopDetention.claim is null there, with
  // noClaimReason saying so) — that is a true fact worth showing elsewhere,
  // but it is not OWED detention, and must not inflate this count.
  const detentionEvents = detentions.filter((d) => loadIds.has(d.loadId) && d.claim !== null).length;

  return { totalLoads, completedLoads, lateLoads, onTimeRate, commonLanes, detentionEvents, lastLoadAt };
}
