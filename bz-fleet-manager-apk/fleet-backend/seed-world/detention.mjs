// Builds DriverLocation pings that, when read back through the REAL
// dwellSegments/detentionClaim (src/domain/dwell/segments.ts,detention.ts —
// scanDetention's own pure math), produce a specific billable claim. Pure
// and deterministic given its inputs: no PRNG needed, since the desired
// OUTPUT (a billableMin) pins every timestamp exactly.
//
// Mirrors detentionClaim's own arithmetic on purpose: clockStartMs is the
// LATER of first-seen and the appointment's windowStart, so pinning
// firstSeenMs to exactly windowStartMs makes clockStartMs = firstSeenMs and
// rawMin a plain (lastSeenMs - firstSeenMs) — the simplest case to reason
// about and to keep byte-identical across reruns.
const MIN_MS = 60_000;
/** Just outside dwellSegments' own 0.5 mi fence at any latitude this world
 *  uses (0.02 degrees is >=1 mi north-south and comfortably >0.5 mi
 *  east-west too, even at Texas latitudes) — the "departure observed" ping. */
const DEPARTURE_OFFSET_DEG = 0.02;

/**
 * `windowStartMs` — the stop's Appointment.windowStart (must be non-null, or
 * detentionClaim refuses the claim entirely). `billableMin`/`freeMin` pin the
 * exact claim scanDetention will compute. Returns DriverLocation rows
 * (`driverId` supplied by the caller) spanning the dwell, dense enough
 * (`intervalMin` apart) to stay well clear of GAP_REVIEW_MIN, plus one
 * departure ping outside the fence.
 */
export function buildDwellPings(driverId, center, { windowStartMs, billableMin, freeMin, intervalMin = 15 }) {
  const firstSeenMs = windowStartMs;
  const lastSeenMs = firstSeenMs + (billableMin + freeMin) * MIN_MS;

  const pings = [];
  for (let t = firstSeenMs; t < lastSeenMs; t += intervalMin * MIN_MS) {
    pings.push({ driverId, latitude: center.lat, longitude: center.lng, createdAt: new Date(t) });
  }
  // The exact end instant, always included even if the step above overshoots
  // it — this is what fixes rawMin to precisely billableMin + freeMin.
  pings.push({ driverId, latitude: center.lat, longitude: center.lng, createdAt: new Date(lastSeenMs) });
  // Departure: a ping well outside the fence, after the last in-fence one —
  // makes `departureObserved: true` so the claim carries one fewer review
  // reason than an open-ended trail would.
  pings.push({
    driverId,
    latitude: center.lat + DEPARTURE_OFFSET_DEG,
    longitude: center.lng + DEPARTURE_OFFSET_DEG,
    createdAt: new Date(lastSeenMs + intervalMin * MIN_MS),
  });
  return pings;
}
