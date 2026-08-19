export function canStart(trip: { status: string; preTripCheckCompleted: boolean }) {
  if (trip.status !== "assigned") return { ok: false as const, reason: `cannot start from '${trip.status}'` };
  if (!trip.preTripCheckCompleted) return { ok: false as const, reason: "pre-trip check incomplete" };
  return { ok: true as const };
}
