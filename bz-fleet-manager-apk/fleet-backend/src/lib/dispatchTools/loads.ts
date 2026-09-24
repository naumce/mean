import { prisma } from "../../db.js";
import type { Prisma } from "@prisma/client";
import { ACTIVE_STATUSES } from "../activeStatuses.js";
import { clampLimit, MAX_LIST_LIMIT } from "./limit.js";

// dispatchTools/loads.ts (AI Dispatch Foundation, Task 5): read-only load
// lookups for the future AI harness. getLoad/searchLoads/getUncoveredLoads
// all return rows built from the SAME include (LOAD_DETAIL_INCLUDE) so a
// model reading any of the three sees one consistent shape for "a load",
// never three drifting projections of it.

const DEFAULT_LIST_LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

const LOAD_DETAIL_INCLUDE = {
  stops: { orderBy: { sequence: "asc" as const }, include: { appointment: true } },
  customer: { select: { id: true, name: true, priority: true } },
  assignment: { select: { id: true, status: true, driverId: true, plannedStart: true, plannedEnd: true } },
} satisfies Prisma.LoadInclude;

export type LoadDetail = Prisma.LoadGetPayload<{ include: typeof LOAD_DETAIL_INCLUDE }>;

type LoadStopForWindow = LoadDetail["stops"][number];

/** The load's first stop's pickup window, `windowStart ?? windowEnd` — the
 *  brief's rule for `searchLoads`'s `fromMs`/`toMs` bounds. `stops` is always
 *  pre-ordered by sequence ascending (LOAD_DETAIL_INCLUDE), so index 0 IS the
 *  first stop; null when that stop has no appointment at all. */
function firstStopPickupWindowMs(stops: LoadStopForWindow[]): number | null {
  const appt = stops[0]?.appointment;
  return appt ? (appt.windowStart ?? appt.windowEnd).getTime() : null;
}

/** The first stop's pickup window END specifically — getUncoveredLoads' own
 *  rule, deliberately narrower than firstStopPickupWindowMs above (which
 *  prefers windowStart): "just missed" is measured against the deadline, not
 *  the window's open. */
function firstStopPickupWindowEndMs(stops: LoadStopForWindow[]): number | null {
  const appt = stops[0]?.appointment;
  return appt ? appt.windowEnd.getTime() : null;
}

/** status "open" AND no assignment in ACTIVE_STATUSES — the brief's exact
 *  definition of "uncovered", shared by searchLoads's own `uncovered` filter
 *  and getUncoveredLoads below. */
function isUncovered(load: { status: string; assignment: { status: string } | null }): boolean {
  return load.status === "open" && (load.assignment == null || !ACTIVE_STATUSES.includes(load.assignment.status));
}

/** One load, in full: ordered stops+appointments, linked customer, current
 *  assignment; null when it does not exist or belongs to another org. */
export async function getLoad(orgId: string, loadId: string): Promise<LoadDetail | null> {
  const load = await prisma.load.findUnique({ where: { id: loadId }, include: LOAD_DETAIL_INCLUDE });
  if (!load || load.orgId !== orgId) return null;
  return load;
}

export interface SearchLoadsOptions {
  status?: string;
  customerId?: string;
  fromMs?: number;
  toMs?: number;
  uncovered?: boolean;
  limit?: number;
}

/** Loads matching the given filters, newest first. `status`/`customerId` are
 *  pushed down to the database; `fromMs`/`toMs` (against the first stop's
 *  pickup window) and `uncovered` are evaluated in memory afterward — Prisma
 *  has no way to filter "the first row of an ordered relation" directly in a
 *  `where`. A load whose first stop has no appointment never matches a
 *  from/to bound (there is nothing to compare). */
export async function searchLoads(orgId: string, options: SearchLoadsOptions = {}): Promise<LoadDetail[]> {
  const limit = clampLimit(options.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const loads = await prisma.load.findMany({
    where: {
      orgId,
      ...(options.status ? { status: options.status } : {}),
      ...(options.customerId ? { customerId: options.customerId } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: LOAD_DETAIL_INCLUDE,
  });

  const filtered = loads.filter((load) => {
    if (options.fromMs != null || options.toMs != null) {
      const pickupMs = firstStopPickupWindowMs(load.stops);
      if (pickupMs == null) return false;
      if (options.fromMs != null && pickupMs < options.fromMs) return false;
      if (options.toMs != null && pickupMs > options.toMs) return false;
    }
    if (options.uncovered != null && isUncovered(load) !== options.uncovered) return false;
    return true;
  });

  return filtered.slice(0, limit);
}

/**
 * Uncovered loads (status "open", no active assignment) whose pickup window
 * has not been over for more than 24h — a load that "just missed" its pickup
 * still needs a driver and still shows — ordered by that pickup window end,
 * soonest/most-overdue first. A load with no pickup appointment at all is
 * left out: there is no window to evaluate "≥ now - 24h" against, the same
 * not-evaluable-is-not-a-default philosophy onTime.ts's isLateAssignment
 * uses for a completed load with no delivery window.
 */
export async function getUncoveredLoads(orgId: string, nowMs: number = Date.now()): Promise<LoadDetail[]> {
  const cutoffMs = nowMs - DAY_MS;
  const loads = await prisma.load.findMany({
    where: { orgId, status: "open" },
    include: LOAD_DETAIL_INCLUDE,
  });

  return loads
    .filter((load) => {
      if (!isUncovered(load)) return false;
      const windowEnd = firstStopPickupWindowEndMs(load.stops);
      return windowEnd != null && windowEnd >= cutoffMs;
    })
    .sort((a, b) => firstStopPickupWindowEndMs(a.stops)! - firstStopPickupWindowEndMs(b.stops)!);
}
