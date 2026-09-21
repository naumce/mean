/** Load.status vocabularies the Cockpit reads (plan A3, spec §8.2). Load
 *  statuses, not Assignment busy statuses — the active-statuses guard exempts
 *  these two literals by exact text; do not add others here. */
export const COVERED_LOAD_STATUSES = ["assigned", "in_progress", "delivered"] as const;
export const ROLLING_LOAD_STATUSES = ["assigned", "in_progress"] as const;
