const ACTIVE_STATUS_LIST = ["assigned", "tendered", "in_progress"] as const;

/** The statuses in which an assignment still occupies its driver and equipment.
 *  `tendered` counts: an outstanding offer holds capacity, so the truck must
 *  not be double-booked while the driver decides. Defined once — every busy,
 *  overlap and yard query imports this, so they can never disagree about
 *  whether a truck is free. */
export const ACTIVE_STATUSES: readonly string[] = ACTIVE_STATUS_LIST;

/** Literal-typed view of the same three values, derived from the list above
 *  (not hand-copied) so a call site that has to switch on *which* active
 *  status a row has — e.g. the late-risk projection choosing between
 *  late-start and behind-schedule math — gets a compile error, not a silent
 *  fallthrough, the day a status is added or removed here. */
export type ActiveStatus = (typeof ACTIVE_STATUS_LIST)[number];
