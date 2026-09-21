import { prisma } from "../db.js";
import type { LoadInput } from "../domain/dispatch/types.js";

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

/** How familiar each org driver is with this lane: completed runs scaled to
 *  0..1 (saturates at FAMILIARITY_SATURATION_RUNS). Empty history = all 0 —
 *  the scorer's lane weight simply stays dormant, as designed. */
export async function laneFamiliarity(orgId: string, key: string | null): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  if (!key) return scores;

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

  const runs = new Map<string, number>();
  for (const a of completed) {
    const pickup = a.load.stops.find((s) => s.type === "pickup");
    const delivery = [...a.load.stops].reverse().find((s) => s.type === "delivery");
    if (pickup?.lat == null || pickup.lng == null || delivery?.lat == null || delivery.lng == null) continue;
    const k = laneKey({ lat: pickup.lat, lng: pickup.lng }, { lat: delivery.lat, lng: delivery.lng });
    if (k !== key) continue;
    runs.set(a.driverId, (runs.get(a.driverId) ?? 0) + 1);
  }

  for (const [driverId, count] of runs) {
    scores.set(driverId, Math.min(1, count / FAMILIARITY_SATURATION_RUNS));
  }
  return scores;
}
