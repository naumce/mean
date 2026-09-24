import { prisma } from "../db.js";
import type { LoadInput } from "../domain/dispatch/types.js";
import { cityStateFromAddress } from "./driverAvailability.js";
import { laterOf } from "./onTime.js";

// Lane intelligence: a "lane" is a recurring origin->destination pattern,
// keyed by coordinate buckets (1 decimal ≈ 11km) so nearby facilities group
// into one lane without any address parsing. History = completed assignments;
// a driver who has actually run a lane scores familiarity toward the suggest
// weight that was reserved for exactly this (DEFAULT_WEIGHTS.lane).

export interface LatLng {
  lat: number;
  lng: number;
}

/** Runs on a lane before familiarity saturates at 1.0. */
export const FAMILIARITY_SATURATION_RUNS = 3;

export function laneKey(origin: LatLng, destination: LatLng): string {
  return `${origin.lat.toFixed(1)},${origin.lng.toFixed(1)}>${destination.lat.toFixed(1)},${destination.lng.toFixed(1)}`;
}

/** Lane key for an engine load input: first pickup -> last delivery. */
export function laneKeyOfLoad(load: LoadInput): string | null {
  const stops = [...load.stops].sort((a, b) => a.sequence - b.sequence);
  const pickup = stops.find((s) => s.type === "pickup");
  const delivery = [...stops].reverse().find((s) => s.type === "delivery");
  if (!pickup || !delivery) return null;
  return laneKey(pickup.location, delivery.location);
}

/** Every org driver's completed-run COUNT on lane `key` — the raw numerator
 *  laneFamiliarity below saturates into its 0..1 score, exposed on its own
 *  for a candidate-context "you've run this lane N times" figure (AI
 *  Dispatch Foundation, Task 6). `null` key (a load with no resolvable
 *  pickup/delivery) returns an empty Map, exactly like laneFamiliarity's own
 *  early-out did before this was split out of it. */
export async function laneRunsByDriver(orgId: string, key: string | null): Promise<Map<string, number>> {
  const runs = new Map<string, number>();
  if (!key) return runs;

  const completed = await prisma.assignment.findMany({
    where: { orgId, status: "completed" },
    select: {
      driverId: true,
      load: {
        select: {
          stops: { orderBy: { sequence: "asc" }, select: { type: true, lat: true, lng: true } },
        },
      },
    },
  });

  for (const a of completed) {
    const pickup = a.load.stops.find((s) => s.type === "pickup");
    const delivery = [...a.load.stops].reverse().find((s) => s.type === "delivery");
    if (pickup?.lat == null || pickup.lng == null || delivery?.lat == null || delivery.lng == null) continue;
    const k = laneKey({ lat: pickup.lat, lng: pickup.lng }, { lat: delivery.lat, lng: delivery.lng });
    if (k !== key) continue;
    runs.set(a.driverId, (runs.get(a.driverId) ?? 0) + 1);
  }
  return runs;
}

/** How familiar each org driver is with this lane: completed runs scaled to
 *  0..1 (saturates at FAMILIARITY_SATURATION_RUNS). Empty history = all 0 —
 *  the scorer's lane weight simply stays dormant, as designed. Runs =
 *  laneRunsByDriver's own query, unchanged (Task 6 split the counting out of
 *  this function; the saturation math below is identical to before). */
export async function laneFamiliarity(orgId: string, key: string | null): Promise<Map<string, number>> {
  const runs = await laneRunsByDriver(orgId, key);
  const scores = new Map<string, number>();
  for (const [driverId, count] of runs) {
    scores.set(driverId, Math.min(1, count / FAMILIARITY_SATURATION_RUNS));
  }
  return scores;
}

// ---------------------------------------------------------------------------
// Lane run counts (AI Dispatch Foundation, Task 4): how many times a lane has
// actually been run, with the cities and the most recent run — for a driver
// detail page ("this driver has run KC->Dallas 4 times") rather than
// laneFamiliarity's single 0..1 score for the SUGGEST weight above. Kept as
// its own query (not built from laneFamiliarity's) because that function
// already commits to one specific lane KEY passed in; this one has no target
// key at all, it discovers every lane a driver (or the whole org) has run.

interface StopForLaneRun {
  type: string;
  address: string;
  lat: number | null;
  lng: number | null;
}

/** One assignment's lane by PICKUP/DELIVERY stop TYPE — the same convention
 *  laneKeyOfLoad/laneFamiliarity above already use (never customers.ts's
 *  simpler by-POSITION rule, which is a deliberately coarser, display-only
 *  convention for that file's own coarser rollup). `null` when either end
 *  has no fix yet, exactly like laneFamiliarity's own per-row skip. */
function laneOfStops(stops: StopForLaneRun[]): { key: string; originCity: string | null; destCity: string | null } | null {
  const pickup = stops.find((s) => s.type === "pickup");
  const delivery = [...stops].reverse().find((s) => s.type === "delivery");
  if (pickup?.lat == null || pickup.lng == null || delivery?.lat == null || delivery.lng == null) return null;
  return {
    key: laneKey({ lat: pickup.lat, lng: pickup.lng }, { lat: delivery.lat, lng: delivery.lng }),
    originCity: cityStateFromAddress(pickup.address).city,
    destCity: cityStateFromAddress(delivery.address).city,
  };
}

/**
 * Every lane run to completion, org-wide or (when `driverId` is given) for
 * one driver — one `prisma.assignment.findMany`, keyed by the same
 * `laneKey()` every other function in this file uses. `laneFamiliarity` is
 * untouched: this is an additive export for a driver/lane detail view, not a
 * replacement for the suggest-weight score above.
 */
export async function laneRunCounts(
  orgId: string,
  driverId?: string,
): Promise<Map<string, { laneKey: string; originCity: string | null; destCity: string | null; runs: number; lastRunAt: Date | null }>> {
  const completed = await prisma.assignment.findMany({
    where: { orgId, status: "completed", ...(driverId ? { driverId } : {}) },
    select: {
      completedAt: true,
      load: {
        select: {
          stops: { orderBy: { sequence: "asc" }, select: { type: true, address: true, lat: true, lng: true } },
        },
      },
    },
  });

  const runs = new Map<string, { laneKey: string; originCity: string | null; destCity: string | null; runs: number; lastRunAt: Date | null }>();
  for (const a of completed) {
    const lane = laneOfStops(a.load.stops);
    if (!lane) continue;
    const existing = runs.get(lane.key);
    // Replace, never mutate the stored accumulator — same immutable-update
    // style as customerHistory's own lane rollup (lib/customers.ts).
    runs.set(lane.key, existing
      ? { ...existing, runs: existing.runs + 1, lastRunAt: laterOf(existing.lastRunAt, a.completedAt) }
      : { laneKey: lane.key, originCity: lane.originCity, destCity: lane.destCity, runs: 1, lastRunAt: a.completedAt });
  }
  return runs;
}
