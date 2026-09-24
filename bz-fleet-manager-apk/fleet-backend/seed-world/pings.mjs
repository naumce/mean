import { alongRoute, offsetFromLine } from "./geo.mjs";

// DriverLocation builders for in_progress loads. Every function here is
// pure given its inputs — no PRNG, no clock reads — so a scenario's "6 mi
// off the line" or "90 min behind plan" is exact by construction and the
// test can recompute the same expected point independently and compare.

/** The ordinary case: 3 recent pings tracing the great-circle
 *  line from `origin` toward `destination`, ending at `progressFraction`
 *  (0..1) of the way there, most recent at `nowMs`. */
export function alongRoutePings(driverId, origin, destination, progressFraction, nowMs) {
  const fractions = [Math.max(0, progressFraction - 0.04), Math.max(0, progressFraction - 0.02), progressFraction];
  const offsetsMin = [10, 5, 0];
  return fractions.map((f, i) => {
    const p = alongRoute(origin, destination, f);
    return { driverId, latitude: p.lat, longitude: p.lng, createdAt: new Date(nowMs - offsetsMin[i] * 60_000) };
  });
}

/** Scenario I: the truck is actually only as far along as it would be if it
 *  had `behindMinutes` LESS drive time than the plan assumes — 3 pings
 *  clustered at that lagging position, all recent (so this reads as "behind
 *  schedule", not also "gone dark"). `totalDriveMin` is the plan's own
 *  full-route drive time, used to convert `behindMinutes` into a fraction of
 *  the route. */
export function behindPlanPings(driverId, origin, destination, planFraction, behindMinutes, totalDriveMin, nowMs) {
  const laggingFraction = Math.max(0, planFraction - behindMinutes / totalDriveMin);
  const offsetsMin = [15, 8, 2];
  return offsetsMin.map((min) => {
    const p = alongRoute(origin, destination, laggingFraction);
    return { driverId, latitude: p.lat, longitude: p.lng, createdAt: new Date(nowMs - min * 60_000) };
  });
}

/** Scenario K: the last 4 pings are IDENTICAL (same lat/lng), spanning
 *  `spanMinutes`, at `stopFraction` along the route — a point that is
 *  neither the pickup nor the delivery stop, i.e. genuinely unplanned. */
export function identicalStopPings(driverId, origin, destination, stopFraction, spanMinutes, nowMs) {
  const p = alongRoute(origin, destination, stopFraction);
  const step = spanMinutes / 3;
  return [3, 2, 1, 0].map((stepsAgo) => ({
    driverId, latitude: p.lat, longitude: p.lng, createdAt: new Date(nowMs - stepsAgo * step * 60_000),
  }));
}

/** Scenario L: the most recent ping is `ageMinutes` old (nothing since) —
 *  built as 3 pings tracing the line as usual, but all shifted back in time
 *  so the LATEST one sits at `nowMs - ageMinutes`. */
export function staleDarkPings(driverId, origin, destination, progressFraction, ageMinutes, nowMs) {
  const lastAtMs = nowMs - ageMinutes * 60_000;
  const fractions = [Math.max(0, progressFraction - 0.04), Math.max(0, progressFraction - 0.02), progressFraction];
  const offsetsMin = [10, 5, 0];
  return fractions.map((f, i) => {
    const p = alongRoute(origin, destination, f);
    return { driverId, latitude: p.lat, longitude: p.lng, createdAt: new Date(lastAtMs - offsetsMin[i] * 60_000) };
  });
}

/** Scenario N: the last 3 pings sit `offsetMi` to the side of the
 *  origin-destination line, not on it. */
export function offRoutePings(driverId, origin, destination, progressFraction, offsetMi, nowMs) {
  const fractions = [Math.max(0, progressFraction - 0.04), Math.max(0, progressFraction - 0.02), progressFraction];
  const offsetsMin = [10, 5, 0];
  return fractions.map((f, i) => {
    const p = offsetFromLine(origin, destination, f, offsetMi);
    return { driverId, latitude: p.lat, longitude: p.lng, createdAt: new Date(nowMs - offsetsMin[i] * 60_000) };
  });
}
