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
