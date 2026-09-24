import { haversineMi } from "../../domain/dispatch/distance.js";
import type { GeoPoint } from "../../domain/dispatch/types.js";

// Pure geometry for the simulation (AI Dispatch Foundation Task 8). No DB, no
// Date.now() — every function here takes plain numbers/points and returns
// plain numbers/points, so engine.ts's orchestration is the only place that
// touches Prisma or a clock.

/** Exported for engine.ts's own fraction math (`clamp((simNowMs - plannedStart) / ..., 0, 1)`)
 *  — one definition of "clamp", not a second copy sitting next to this one. */
export const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

type Vec3 = readonly [number, number, number];

const toVector = (p: GeoPoint): Vec3 => {
  const lat = toRad(p.lat);
  const lng = toRad(p.lng);
  return [Math.cos(lat) * Math.cos(lng), Math.cos(lat) * Math.sin(lng), Math.sin(lat)];
};

const toGeoPoint = ([x, y, z]: Vec3): GeoPoint => ({
  lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
  lng: toDeg(Math.atan2(y, x)),
});

/** A point `fraction` of the way from `a` to `b` along the great circle that
 *  joins them (spherical slerp on the unit sphere — NOT a straight lat/lng
 *  lerp, which would cut inside the earth on a long leg). `fraction` outside
 *  [0,1] is clamped: a caller passing 1.0000001 from float drift gets `b`,
 *  not a point past it. */
export function greatCircleInterpolate(a: GeoPoint, b: GeoPoint, fraction: number): GeoPoint {
  const f = clamp(fraction, 0, 1);
  const va = toVector(a);
  const vb = toVector(b);
  const dot = clamp(va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2], -1, 1);
  const theta = Math.acos(dot);
  // Coincident (or antipodal-within-float-error, which never happens for two
  // stops on the same continent) points have no defined direction to slerp
  // along — `a` (== `b` for the coincident case this actually hits) is exact.
  if (theta < 1e-12) return a;
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - f) * theta) / sinTheta;
  const wb = Math.sin(f * theta) / sinTheta;
  return toGeoPoint([wa * va[0] + wb * vb[0], wa * va[1] + wb * vb[1], wa * va[2] + wb * vb[2]]);
}

export interface GeocodableStop {
  sequence: number;
  lat: number | null;
  lng: number | null;
}

/** Where a truck sits `fraction` of the way through its plan, walking the
 *  load's GEOCODED stops in sequence order and interpolating by cumulative
 *  great-circle distance (so a plan with an unequal mix of short and long
 *  legs still spends most of `fraction`'s range on its longest leg, matching
 *  how long the truck would actually be on it).
 *
 *  Stops missing lat/lng are skipped — an un-geocoded intermediate stop
 *  must not freeze the truck at the last stop we could place. Fewer than 2
 *  geocoded stops means the plan has no measurable route at all: null, so
 *  the caller writes no ping rather than inventing a position. */
export function positionAlong(stops: readonly GeocodableStop[], fraction: number): GeoPoint | null {
  const geocoded = [...stops]
    .filter((s): s is GeocodableStop & { lat: number; lng: number } => s.lat != null && s.lng != null)
    .sort((a, b) => a.sequence - b.sequence);
  if (geocoded.length < 2) return null;

  const legs = geocoded.slice(1).map((to, i) => {
    const from = geocoded[i];
    return { from, to, miles: haversineMi(from, to) };
  });
  const totalMiles = legs.reduce((sum, leg) => sum + leg.miles, 0);
  if (totalMiles === 0) return geocoded[0];

  const targetMiles = clamp(fraction, 0, 1) * totalMiles;
  let covered = 0;
  for (const [i, leg] of legs.entries()) {
    const isLastLeg = i === legs.length - 1;
    if (targetMiles <= covered + leg.miles || isLastLeg) {
      const legFraction = leg.miles === 0 ? 0 : (targetMiles - covered) / leg.miles;
      return greatCircleInterpolate(leg.from, leg.to, legFraction);
    }
    covered += leg.miles;
  }
  // Unreachable (the loop's last iteration always satisfies isLastLeg), kept
  // so this stays a total function rather than declaring a return type the
  // compiler cannot verify.
  return geocoded[geocoded.length - 1];
}

/** Earth's mean radius in miles. domain/dispatch/distance.ts keeps the same
 *  constant for haversineMi but does not export it, and that module is out
 *  of scope for this task — duplicated here as a physical constant, not
 *  business logic, so the two can never disagree about what a "mile" is
 *  worth without both being edited. */
const EARTH_RADIUS_MI = 3958.7613;

/** A due-east (bearing 90°) displacement of `miles` at latitude `atLat`, as
 *  a lat/lng delta — what `POST /sim/drivers/:id/mode`'s `offsetMi` becomes
 *  before it is stored on `SimDriverState.offsetLat/offsetLng`. Latitude is
 *  unchanged: moving strictly east follows a line of constant latitude under
 *  the equirectangular approximation, which is indistinguishable from a true
 *  geodesic at the offsets this endpoint allows (<= 50 mi — far under a
 *  degree of longitude at any US latitude). */
export function eastOffsetDeg(atLat: number, miles: number): { offsetLat: number; offsetLng: number } {
  const offsetLng = toDeg(miles / (EARTH_RADIUS_MI * Math.cos(toRad(atLat))));
  return { offsetLat: 0, offsetLng };
}
