import { Router } from "express";
import { prisma } from "../db.js";
import { orgWhere } from "../middleware/orgScope.js";
import { computeLateRisk, type RiskCandidate } from "../lib/lateRisk.js";
import { ACTIVE_STATUSES, type ActiveStatus } from "../lib/activeStatuses.js";
import { ROLLING_LOAD_STATUSES } from "../lib/loadStatuses.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Live late-risk feed: which active loads are in danger of missing their
// delivery window RIGHT NOW. Computed fresh on every call (never persisted —
// risk changes as the clock runs), from real state only: planned timelines,
// appointment windows, and the driver's last reported position. Mounted under
// dispatcherRouter with attachOrgScope.
export const dispatcherRiskRouter = Router();

dispatcherRiskRouter.get("/risk", asyncRoute(async (req, res) => {
  const scope = orgWhere(req);

  const assignments = await prisma.assignment.findMany({
    where: { ...scope, status: { in: [...ACTIVE_STATUSES] } },
    select: {
      id: true, loadId: true, driverId: true, status: true,
      plannedStart: true, plannedEnd: true,
      driver: { select: { name: true, lastLat: true, lastLng: true } },
      load: {
        select: {
          externalId: true, orderRef: true,
          stops: {
            orderBy: { sequence: "asc" },
            select: { type: true, lat: true, lng: true, appointment: { select: { windowEnd: true } } },
          },
        },
      },
    },
  });

  const candidates: RiskCandidate[] = assignments.map((a) => {
    const finalDelivery = [...a.load.stops].reverse().find((s) => s.type === "delivery");
    return {
      assignmentId: a.id,
      loadId: a.loadId,
      ref: a.load.externalId ?? a.load.orderRef ?? a.loadId.slice(0, 8),
      driverId: a.driverId,
      driverName: a.driver.name,
      status: a.status as ActiveStatus,
      plannedStartMs: a.plannedStart.getTime(),
      plannedEndMs: a.plannedEnd.getTime(),
      deadlineMs: finalDelivery?.appointment?.windowEnd.getTime() ?? null,
      driverPos:
        a.driver.lastLat != null && a.driver.lastLng != null
          ? { lat: a.driver.lastLat, lng: a.driver.lastLng }
          : null,
      finalDrop:
        finalDelivery?.lat != null && finalDelivery.lng != null
          ? { lat: finalDelivery.lat, lng: finalDelivery.lng }
          : null,
    };
  });

  // Plan A3 (spec §8.4): covered brokered loads run on someone else's truck.
  // No GPS in this slice, so only a missed pickup window can be seen.
  const brokered = await prisma.load.findMany({
    where: { ...scope, assignment: null, carrierId: { not: null }, status: { in: [...ROLLING_LOAD_STATUSES] } },
    select: { id: true, externalId: true, orderRef: true, boardLoadNo: true, status: true, carrier: { select: { name: true } },
      stops: { orderBy: { sequence: "asc" }, select: { type: true, lat: true, lng: true, appointment: { select: { windowStart: true, windowEnd: true } } } } },
  });
  for (const l of brokered) {
    const pickup = l.stops.find((s) => s.type === "pickup");
    const finalDelivery = [...l.stops].reverse().find((s) => s.type === "delivery");
    const startMs = pickup?.appointment?.windowStart?.getTime() ?? pickup?.appointment?.windowEnd?.getTime();
    const endMs = finalDelivery?.appointment?.windowEnd?.getTime();
    if (startMs === undefined || endMs === undefined) continue; // unplaced in time: nothing to be late against
    candidates.push({
      assignmentId: null, loadId: l.id, ref: l.boardLoadNo ?? l.externalId ?? l.orderRef ?? l.id.slice(0, 8),
      driverId: null, driverName: null, carrierName: l.carrier?.name ?? null, status: l.status as ActiveStatus,
      plannedStartMs: startMs, plannedEndMs: endMs, deadlineMs: endMs, driverPos: null,
      finalDrop: finalDelivery?.lat != null && finalDelivery.lng != null ? { lat: finalDelivery.lat, lng: finalDelivery.lng } : null,
    });
  }

  const risks = computeLateRisk(Date.now(), candidates).map((r) => ({
    ...r,
    deadline: new Date(r.deadlineMs).toISOString(),
    // R20: null, not a fabricated string — a brokered row (no GPS of ours) has
    // no projected arrival to report. `?? null` keeps the field present with
    // an honest value rather than deleting it (a consumer reading `undefined`
    // and one reading `null` behave differently).
    projectedArrival: r.projectedArrivalMs == null ? null : new Date(r.projectedArrivalMs).toISOString(),
  }));

  res.json({ risks });
}));
