// Late/on-time arithmetic (AI Dispatch Foundation, Task 3 for
// customerHistory below; shared with Task 4, exact names). Pure: both
// functions take an already-resolved delivery window end rather than a
// Load/LoadStop/Appointment shape of their own, so a caller decides ONCE
// which stop's appointment counts as "the" delivery window and every
// consumer of these two functions agrees with it by construction.
//
// The rule for finding that Date (src/lib/customers.ts's own stop-walk
// follows it): the `Appointment.windowEnd` of the load's LAST stop typed
// "delivery", falling back to the load's last stop's own appointment when no
// stop is typed "delivery" at all.

/**
 * `null` (not evaluable) whenever either fact is missing: a load still in
 * progress (`completedAt` null) or one with no delivery window to measure
 * against (`deliveryWindowEnd` null). Neither case is "on time" — an
 * evaluable/not-evaluable distinction a caller folds into an on-time RATE
 * must never quietly count a load that was never actually measured.
 */
export function isLateAssignment(completedAt: Date | null, deliveryWindowEnd: Date | null): boolean | null {
  if (completedAt === null || deliveryWindowEnd === null) return null;
  return completedAt.getTime() > deliveryWindowEnd.getTime();
}

/**
 * Minutes late, floored to the whole minute. `null` covers on-time, early,
 * AND not-evaluable alike — a non-null result already means "yes, and by
 * this much", so a caller never needs a separate "was it even late" branch
 * before using this number.
 */
export function lateMinutes(completedAt: Date | null, deliveryWindowEnd: Date | null): number | null {
  if (isLateAssignment(completedAt, deliveryWindowEnd) !== true) return null;
  return Math.floor((completedAt!.getTime() - deliveryWindowEnd!.getTime()) / 60_000);
}

/** The minimum stop shape deliveryWindowEndOf needs — deliberately narrower
 *  than any one caller's own stop type (customers.ts's StopForHistory also
 *  carries lat/lng/address for its own lane rollup; driverMetrics.ts's rows
 *  carry more still) so either can pass its stops straight through. */
export interface StopForDeliveryWindow {
  type: string;
  appointment: { windowEnd: Date } | null;
}

/**
 * The load's LAST stop typed "delivery", or — no stop is — its last stop:
 * moved here from customers.ts (Task 3) so Task 4's driverMetrics.ts shares
 * the identical rule rather than a second, drifting copy of it. Every caller
 * of isLateAssignment/lateMinutes above is expected to resolve its
 * deliveryWindowEnd through this one function.
 */
export function deliveryWindowEndOf(stops: StopForDeliveryWindow[]): Date | null {
  const delivery = [...stops].reverse().find((s) => s.type === "delivery");
  const stop = delivery ?? stops[stops.length - 1] ?? null;
  return stop?.appointment?.windowEnd ?? null;
}
