import { prisma } from "../db.js";
import { deliveryWindowEndOf, isLateAssignment, lateMinutes } from "./onTime.js";
import { laneOfAssignmentStops } from "./driverMetrics.js";

// Driver history (AI Dispatch Foundation, Task 5): moved out of the
// GET /drivers/:id/history handler (dispatcherDriverSupply.ts) so
// dispatchTools/drivers.ts's getDriverHistory can call the identical query
// instead of a second copy of it. The route keeps its own HTTP-specific
// concern (parsing/clamping `?limit=` — see its own historyLimit()) and now
// just calls this with the already-resolved number.

export interface DriverHistoryRow {
  assignmentId: string;
  loadId: string;
  loadRef: string;
  customerName: string | null;
  customerId: string | null;
  originCity: string | null;
  destCity: string | null;
  laneKey: string | null;
  plannedStart: Date;
  plannedEnd: Date;
  completedAt: Date | null;
  deliveryWindowEnd: Date | null;
  late: boolean | null;
  lateMinutes: number | null;
}

/**
 * `driverId`'s completed assignments, newest (most recently completed)
 * first, capped at `limit` rows. late/lateMinutes reuse onTime.ts exactly as
 * driverMetrics.ts does, and originCity/destCity/laneKey reuse
 * driverMetrics.ts's own laneOfAssignmentStops — one rule, shared by this
 * function and driverMetrics.ts's own lane rollup (customers.ts's coarser
 * by-position lane rule is intentionally a different one).
 */
export async function driverHistory(orgId: string, driverId: string, limit: number): Promise<DriverHistoryRow[]> {
  const assignments = await prisma.assignment.findMany({
    where: { orgId, driverId, status: "completed" },
    orderBy: { completedAt: "desc" },
    take: limit,
    select: {
      id: true,
      loadId: true,
      plannedStart: true,
      plannedEnd: true,
      completedAt: true,
      load: {
        select: {
          externalId: true,
          customerId: true,
          customer: { select: { name: true } },
          stops: {
            orderBy: { sequence: "asc" },
            select: { type: true, address: true, lat: true, lng: true, appointment: { select: { windowEnd: true } } },
          },
        },
      },
    },
  });

  return assignments.map((a) => {
    const windowEnd = deliveryWindowEndOf(a.load.stops);
    const lane = laneOfAssignmentStops(a.load.stops);
    return {
      assignmentId: a.id,
      loadId: a.loadId,
      loadRef: a.load.externalId ?? a.loadId,
      customerName: a.load.customer?.name ?? null,
      customerId: a.load.customerId,
      originCity: lane?.originCity ?? null,
      destCity: lane?.destCity ?? null,
      laneKey: lane?.key ?? null,
      plannedStart: a.plannedStart,
      plannedEnd: a.plannedEnd,
      completedAt: a.completedAt,
      deliveryWindowEnd: windowEnd,
      late: isLateAssignment(a.completedAt, windowEnd),
      lateMinutes: lateMinutes(a.completedAt, windowEnd),
    };
  });
}
