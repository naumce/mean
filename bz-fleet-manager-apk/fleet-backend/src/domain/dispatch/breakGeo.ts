// Where a break lands, geographically. Pure; no Date, no I/O.
//
// This is a great-circle interpolation along the leg, NOT a point on a road.
// That is why every BreakPoint carries `precision`: at 'estimated' the caller
// must render it as approximate. A break point presented as surveyed truth
// would be exactly the "confidently wrong" failure the spec warns about
// (§7) — worse than offering nothing at all.

import type { GeoPoint } from "./types.js";

const toRad = (d: number): number => (d * Math.PI) / 180;
const toDeg = (r: number): number => (r * 180) / Math.PI;

/**
 * Great-circle interpolation between two points. `fraction` is clamped to
 * [0,1].
 */
export function interpolate(from: GeoPoint, to: GeoPoint, fraction: number): GeoPoint {
  const f = Math.min(1, Math.max(0, fraction));
  if (f === 0) return { lat: from.lat, lng: from.lng };
  if (f === 1) return { lat: to.lat, lng: to.lng };

  const lat1 = toRad(from.lat);
  const lng1 = toRad(from.lng);
  const lat2 = toRad(to.lat);
  const lng2 = toRad(to.lng);

  const dLat = lat2 - lat1;
  const dLng = lng2 - lng1;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const d = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  // Coincident endpoints: sin(d) is 0 and the slerp below divides by zero.
  if (d === 0) return { lat: from.lat, lng: from.lng };

  const a = Math.sin((1 - f) * d) / Math.sin(d);
  const b = Math.sin(f * d) / Math.sin(d);
  const x = a * Math.cos(lat1) * Math.cos(lng1) + b * Math.cos(lat2) * Math.cos(lng2);
  const y = a * Math.cos(lat1) * Math.sin(lng1) + b * Math.cos(lat2) * Math.sin(lng2);
  const z = a * Math.sin(lat1) + b * Math.sin(lat2);

  return {
    lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
    lng: toDeg(Math.atan2(y, x)),
  };
}
