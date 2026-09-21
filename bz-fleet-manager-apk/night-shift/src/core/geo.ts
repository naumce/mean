import { haversineMi, interpolate } from "../domain.js";
import type { GeoPoint, LngLat } from "./types.js";

export const toPoint = (p: LngLat): GeoPoint => ({ lat: p[1], lng: p[0] });

/** Miles from the start at each vertex. Index 0 is 0. */
export function cumulativeMiles(geometry: LngLat[]): number[] {
  const out: number[] = [0];
  for (let i = 1; i < geometry.length; i += 1) {
    out.push(out[i - 1] + haversineMi(toPoint(geometry[i - 1]), toPoint(geometry[i])));
  }
  return out;
}

export function routeMiles(geometry: LngLat[]): number {
  const cum = cumulativeMiles(geometry);
  return cum[cum.length - 1] ?? 0;
}

/** The point at `fraction` (0..1) of the route's length, interpolated
 *  within the segment it falls in. Clamped: there is no "before the start". */
export function pointAlongRoute(geometry: LngLat[], fraction: number): GeoPoint {
  if (geometry.length === 0) throw new Error("pointAlongRoute: empty route");
  if (geometry.length === 1) return toPoint(geometry[0]);
  const cum = cumulativeMiles(geometry);
  const target = Math.min(1, Math.max(0, fraction)) * cum[cum.length - 1];
  for (let i = 1; i < cum.length; i += 1) {
    if (cum[i] >= target) {
      const seg = cum[i] - cum[i - 1];
      const t = seg === 0 ? 0 : (target - cum[i - 1]) / seg;
      return interpolate(toPoint(geometry[i - 1]), toPoint(geometry[i]), t);
    }
  }
  return toPoint(geometry[geometry.length - 1]);
}

/** Projection onto the nearest SEGMENT, not the nearest vertex. Snapping to
 *  a vertex is off by up to half the vertex spacing — a mile on a coarse
 *  line — and that error lands directly in "minutes behind plan". Each
 *  segment is projected in a local equirectangular frame around the point,
 *  which is accurate to well under a metre at road-segment lengths; the
 *  off-route distance is then measured properly, with haversine, to the
 *  foot of the perpendicular. */
export function projectOntoRoute(geometry: LngLat[], p: GeoPoint): { alongMi: number; offRouteMi: number } {
  if (geometry.length === 0) return { alongMi: 0, offRouteMi: Number.POSITIVE_INFINITY };
  if (geometry.length === 1) return { alongMi: 0, offRouteMi: haversineMi(toPoint(geometry[0]), p) };
  const cum = cumulativeMiles(geometry);
  const cosLat = Math.cos((p.lat * Math.PI) / 180);
  let best = { alongMi: 0, offRouteMi: Number.POSITIVE_INFINITY };
  for (let i = 1; i < geometry.length; i += 1) {
    const a = toPoint(geometry[i - 1]);
    const b = toPoint(geometry[i]);
    // Segment endpoints relative to p, in a frame where one unit is one
    // degree of latitude in both axes.
    const ax = (a.lng - p.lng) * cosLat;
    const ay = a.lat - p.lat;
    const bx = (b.lng - p.lng) * cosLat;
    const by = b.lat - p.lat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    // Parameter of p's foot on the segment, clamped to the segment itself.
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2));
    const foot = interpolate(a, b, t);
    const off = haversineMi(p, foot);
    if (off < best.offRouteMi) best = { alongMi: cum[i - 1] + t * (cum[i] - cum[i - 1]), offRouteMi: off };
  }
  return best;
}
