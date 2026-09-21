// Pure distance/time helpers (Control Tower §4C fallback path).
// The real product prefers a routing-matrix provider; these deterministic
// haversine-based functions are the always-available fallback and the unit
// under test. No network, no Date.

import type { GeoPoint } from "./types.js";

const EARTH_RADIUS_MI = 3958.7613;
const DEFAULT_ROAD_FACTOR = 1.2;
const DEFAULT_SPEED_MPH = 50;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance between two points, in miles. */
export function haversineMi(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_MI * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Estimated road miles = great-circle * road factor (default 1.2). */
export function roadMiles(a: GeoPoint, b: GeoPoint, roadFactor = DEFAULT_ROAD_FACTOR): number {
  return haversineMi(a, b) * roadFactor;
}

/** Driving minutes to cover `miles` at `avgSpeedMph` (default 50). */
export function driveMinutes(miles: number, avgSpeedMph = DEFAULT_SPEED_MPH): number {
  if (avgSpeedMph <= 0) throw new Error("avgSpeedMph must be positive");
  return (miles / avgSpeedMph) * 60;
}
