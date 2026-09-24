// Pure geo math for the demo world — deliberately re-implemented here rather
// than imported from src/domain/dispatch/distance.ts: seeds run under plain
// `node` (package.json has no ts-node/tsx loader wired into `node seed-world.mjs`),
// which cannot execute a .ts module directly, exactly like seed-demo.mjs and
// seed-control-tower.mjs already don't import src/. The constants below
// (earth radius, road factor, avg speed) are copied verbatim from
// distance.ts so a mile computed here and a mile computed there always agree
// — the seed-world test imports the REAL haversineMi from src/domain and
// checks seeded distances against it (e.g. scenario A's "~40 mi"), so any
// drift here would show up as a flaky test, not just a cosmetic mismatch.
const EARTH_RADIUS_MI = 3958.7613;
const ROAD_FACTOR = 1.2;
const AVG_SPEED_MPH = 50;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** Great-circle distance in miles — identical formula to distance.ts's own
 *  haversineMi, so a point placed here at "40 mi" reads back as ~40 mi when
 *  the test re-measures it with the real function. */
export function haversineMi(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_MI * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function roadMiles(a, b, roadFactor = ROAD_FACTOR) {
  return haversineMi(a, b) * roadFactor;
}

export function driveMinutes(miles, avgSpeedMph = AVG_SPEED_MPH) {
  return (miles / avgSpeedMph) * 60;
}

/** The point `distanceMi` from `origin` along initial bearing `bearingDeg`
 *  (0 = north, 90 = east), on the same sphere haversineMi assumes. This is
 *  haversine's own inverse — placing a point this way and then re-measuring
 *  it with haversineMi reproduces `distanceMi` to floating-point precision,
 *  which is what lets scenario A/B/D/E hit their exact "N mi away" targets
 *  without trial and error. */
export function destinationPoint(origin, bearingDeg, distanceMi) {
  const delta = distanceMi / EARTH_RADIUS_MI;
  const theta = toRad(bearingDeg);
  const phi1 = toRad(origin.lat);
  const lambda1 = toRad(origin.lng);

  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
  const lambda2 =
    lambda1 +
    Math.atan2(Math.sin(theta) * Math.sin(delta) * Math.cos(phi1), Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2));

  return { lat: toDeg(phi2), lng: toDeg(lambda2) };
}

/** Initial spherical bearing from `a` to `b`, in degrees — the standard
 *  great-circle formula (not a naive atan2 of plain lat/lng deltas, which
 *  drifts from the true bearing away from the equator). A great circle is
 *  fully determined by a start point plus this initial bearing: walking
 *  along it any distance (via destinationPoint) stays exactly on the same
 *  circle, which is what makes alongRoute/offsetFromLine below exact rather
 *  than approximate. Also the reference direction a cross-track-distance
 *  check (e.g. the seed-world test's own `crossTrackMi`) measures against. */
function bearingDeg(a, b) {
  const phi1 = toRad(a.lat);
  const phi2 = toRad(b.lat);
  const dLambda = toRad(b.lng - a.lng);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return toDeg(Math.atan2(y, x));
}

/** The point `fraction` (0..1) of the way from `a` to `b` along the great
 *  circle that actually connects them — `a`'s own initial bearing toward
 *  `b`, walked for `fraction * haversineMi(a, b)` miles via destinationPoint
 *  (haversine's exact inverse). Exact, not a flat lat/lng interpolation: the
 *  result always measures back at cross-track distance ~0 from the a->b
 *  line, which is what lets offsetFromLine's perpendicular step below land
 *  at very close to exactly `offsetMi`, not some fraction of it. */
export function alongRoute(a, b, fraction) {
  const totalMi = haversineMi(a, b);
  if (totalMi === 0) return { lat: a.lat, lng: a.lng };
  return destinationPoint(a, bearingDeg(a, b), fraction * totalMi);
}

/** A point `offsetMi` to the side of the great-circle line from `a` to `b`,
 *  at parameter `fraction` along it — used for scenario N (pings off route)
 *  and for a slice of ordinary in-progress pings so not every truck sits
 *  exactly on the line. Starts from the exact on-line point (alongRoute
 *  above) and steps `offsetMi` perpendicular to it (bearing + 90), so the
 *  result's true cross-track distance comes out at very close to exactly
 *  `offsetMi`. */
export function offsetFromLine(a, b, fraction, offsetMi) {
  const base = alongRoute(a, b, fraction);
  const forwardBearing = bearingDeg(a, b);
  return destinationPoint(base, forwardBearing + 90, offsetMi);
}
