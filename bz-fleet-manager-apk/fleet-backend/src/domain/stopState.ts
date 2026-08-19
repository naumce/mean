// A stop may be arrived only if the trip is running, the stop itself is
// still pending, and every earlier-sequence stop on the trip is completed
// (sequential unlock).
export function canArriveStop(
  trip: { status: string },
  stop: { status: string },
  earlierStops: { status: string }[],
) {
  if (trip.status !== "in_progress") return { ok: false as const, reason: `trip is not in progress (status '${trip.status}')` };
  if (stop.status !== "pending") return { ok: false as const, reason: `stop cannot be arrived from '${stop.status}'` };
  if (!earlierStops.every((s) => s.status === "completed"))
    return { ok: false as const, reason: "an earlier stop on this trip has not been completed yet" };
  return { ok: true as const };
}

// A stop may be completed only if it has been arrived and every REQUIRED
// signs-proof requirement on it has a matching proof on file.
export function canCompleteStop(
  stop: { status: string },
  requiredCount: number,
  providedCount: number,
) {
  if (stop.status !== "arrived") return { ok: false as const, reason: `stop cannot be completed from '${stop.status}'` };
  if (providedCount < requiredCount) return { ok: false as const, reason: "required signs-proof is missing" };
  return { ok: true as const };
}

// A trip may be completed only if it is running and every one of its stops
// has been completed.
export function canCompleteTrip(
  trip: { status: string },
  stops: { status: string }[],
) {
  if (trip.status !== "in_progress") return { ok: false as const, reason: `trip cannot be completed from '${trip.status}'` };
  if (stops.length === 0) return { ok: false as const, reason: "trip has no stops" };
  if (!stops.every((s) => s.status === "completed"))
    return { ok: false as const, reason: "not all stops are completed" };
  return { ok: true as const };
}
