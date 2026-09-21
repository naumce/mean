// T3 Break and Rest Planning, Task 7 — the DB-backed half of rest coverage.
//
// One query per break point (at most two per plan: the deadhead leg and the
// loaded leg that crosses BREAK_THRESHOLD_MIN). The query is a degree-box
// PREFILTER so the (orgId, lat, lng) index in prisma/schema.prisma is used,
// then the exact circle is drawn in memory with haversine. `hasData` and
// `options` both come from that SAME row set on purpose (spec/task-7-brief.md
// §Step 3): two separate queries could race a write between them and disagree
// about what the org knows, which is exactly the kind of "confidently wrong"
// the domain layer (restConflict.ts) is built to avoid.
import { prisma } from "../db.js";
import {
  COVERAGE_RADIUS_MI,
  haversineMi,
  rankRestOptions,
  type BreakPoint,
  type GeoPoint,
  type RestCandidate,
  type RestCoverage,
  type RestOption,
} from "../domain/dispatch/index.js";

/** Miles per degree of latitude is constant; longitude shrinks by cos(lat). */
const MILES_PER_DEGREE_LAT = 69;
/** Floor for cos(lat) in the longitude box-width divisor. Without this, a
 *  break point near a pole sends cos(lat) -> 0, the box width -> Infinity,
 *  and an indexed lookup becomes a full table scan (task-7-brief.md, "The
 *  coverageFor query — one correctness trap"). No real freight lane is near
 *  a pole; this only exists so a bad/test coordinate can't take the index out. */
const MIN_COS_LAT = 1e-6;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** One break point's full story for the API surface: where it is claimed to
 *  fall, how sure the engine is of that (`precision`), the reachable options
 *  ranked by detour, and whether the org has told us anything about this
 *  corridor at all. `hasCoverage: false` is NOT "no rest stops" — it is "we
 *  cannot say" (Global Constraint 1); the UI must render those two states
 *  differently. Consumed by Tasks 8 and 9. */
export interface BreakPlanEntry {
  atMs: number;
  at: GeoPoint | null;
  precision: "routed" | "estimated";
  options: RestOption[];
  hasCoverage: boolean;
}

/** Rest coverage around one break point. `legEnd` is the destination of the
 *  leg the break falls on (stops[0] for the deadhead leg, else the next
 *  stop) — rankRestOptions needs it to score a detour, not just an offset. */
export async function coverageFor(
  orgId: string,
  bp: BreakPoint,
  legEnd: GeoPoint,
): Promise<RestCoverage> {
  // No position -> no query to run; restConflict() treats this identically
  // to "no data" (silence, never a refusal — Global Constraint 1).
  if (!bp.at) return { hasData: false, options: [] };
  const { lat, lng } = bp.at;

  const latDeltaDeg = COVERAGE_RADIUS_MI / MILES_PER_DEGREE_LAT;
  const cosLat = Math.max(Math.cos(toRad(lat)), MIN_COS_LAT);
  const lngDeltaDeg = COVERAGE_RADIUS_MI / (MILES_PER_DEGREE_LAT * cosLat);

  const boxed = await prisma.restStop.findMany({
    where: {
      orgId,
      lat: { gte: lat - latDeltaDeg, lte: lat + latDeltaDeg },
      lng: { gte: lng - lngDeltaDeg, lte: lng + lngDeltaDeg },
    },
  });

  // The box over-includes its corners; draw the real circle here. Both
  // `hasData` and the candidates fed to rankRestOptions come from this one
  // filtered set, so the two can never disagree about what the org knows.
  const covered = boxed.filter(
    (r) => haversineMi({ lat, lng }, { lat: r.lat, lng: r.lng }) <= COVERAGE_RADIUS_MI,
  );

  const candidates: RestCandidate[] = covered.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    lat: r.lat,
    lng: r.lng,
    spaces: r.spaces,
  }));

  return {
    hasData: covered.length > 0,
    options: rankRestOptions(bp.at, legEnd, candidates),
  };
}
