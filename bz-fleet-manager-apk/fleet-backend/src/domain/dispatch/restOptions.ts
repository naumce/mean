// Which rest stops a driver can actually reach at a break point, ranked by
// what the detour costs. Pure: the DB query that produced `candidates` lives
// in the route layer, so this stays unit-testable and the engine stays
// framework-free.

import { haversineMi } from "./distance.js";
import type { GeoPoint } from "./types.js";

export const REST_SEARCH_RADIUS_MI = 35;

export interface RestCandidate {
  id: string;
  name: string;
  kind: string;
  lat: number;
  lng: number;
  /** NULL when the facility's capacity is unknown. Never coerce to 0. */
  spaces: number | null;
}

export interface RestOption extends RestCandidate {
  /** extra miles vs. driving the leg straight through */
  detourMi: number;
  /** miles from the break point itself */
  offRouteMi: number;
}

/**
 * Rank the reachable rest stops at `point` on a leg ending at `legEnd`.
 * Detour is the extra distance vs. driving straight through, so a stop
 * directly on the route scores ~0 and one behind the driver scores roughly
 * double its offset — which is the honest ordering for a driver who has to
 * come back.
 */
export function rankRestOptions(
  point: GeoPoint,
  legEnd: GeoPoint,
  candidates: RestCandidate[],
  radiusMi: number = REST_SEARCH_RADIUS_MI,
): RestOption[] {
  const straight = haversineMi(point, legEnd);
  return candidates
    .map((c) => {
      const here = { lat: c.lat, lng: c.lng };
      const offRouteMi = haversineMi(point, here);
      const detourMi = Math.max(0, offRouteMi + haversineMi(here, legEnd) - straight);
      return { ...c, offRouteMi, detourMi };
    })
    .filter((o) => o.offRouteMi <= radiusMi)
    .sort((a, b) => a.detourMi - b.detourMi || a.offRouteMi - b.offRouteMi);
}
