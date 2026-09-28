import { prisma } from "../../db.js";
import { CHICAGO_PICKUP, DEMO_HIST_PREFIX, DETROIT_DELIVERY } from "./fixtures.js";

// Demo Mode: ten historical Chicago -> Detroit runs John Carter
// completed over the last 60 days, so a driver-history read (context
// enrichment, the AI harness's own tools) finds a real on-time record behind
// him. Recreated from scratch on every reset — unlike the demo
// load and the driver, these carry no promise of a stable row id.

const HISTORY_COUNT = 10;
const LATE_INDEX = HISTORY_COUNT; // the most recent run was the late one
const LATE_MINUTES = 25;
const SPACING_DAYS = 6; // 10 runs spread across the last ~60 days
const TRANSIT_HOURS = 8; // a plausible Chicago -> Detroit runtime
const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

export async function rebuildHistoricalLoads(
  orgId: string,
  driverId: string,
  tractorId: string,
  trailerId: string,
  nowMs: number = Date.now(),
): Promise<void> {
  for (let i = 1; i <= HISTORY_COUNT; i++) {
    const externalId = `${DEMO_HIST_PREFIX}${String(i).padStart(2, "0")}`;
    const daysAgo = (HISTORY_COUNT - i + 1) * SPACING_DAYS; // oldest first, most recent last
    const plannedStart = new Date(nowMs - daysAgo * DAY_MS);
    const plannedEnd = new Date(plannedStart.getTime() + TRANSIT_HOURS * HOUR_MS);
    const windowEnd = new Date(plannedEnd.getTime() + HOUR_MS); // an hour of booked slack
    const late = i === LATE_INDEX;
    const completedAt = late ? new Date(windowEnd.getTime() + LATE_MINUTES * 60_000) : new Date(plannedEnd.getTime());

    const load = await prisma.load.create({
      data: {
        orgId,
        externalId,
        requiredEquip: "DryVan",
        status: "delivered",
        customerName: "Demo Customer",
        revenueCents: 185_000,
        stops: {
          create: [
            {
              sequence: 1, type: "pickup", address: CHICAGO_PICKUP.address,
              lat: CHICAGO_PICKUP.lat, lng: CHICAGO_PICKUP.lng, geocodeStatus: "ok",
              appointment: { create: { windowStart: new Date(plannedStart.getTime() - HOUR_MS), windowEnd: plannedStart, type: "pickup" } },
            },
            {
              sequence: 2, type: "delivery", address: DETROIT_DELIVERY.address,
              lat: DETROIT_DELIVERY.lat, lng: DETROIT_DELIVERY.lng, geocodeStatus: "ok",
              appointment: { create: { windowEnd, type: "delivery" } },
            },
          ],
        },
      },
    });

    await prisma.assignment.create({
      data: {
        orgId, loadId: load.id, driverId, tractorId, trailerId,
        plannedStart, plannedEnd, startedAt: plannedStart, completedAt, status: "completed",
      },
    });
  }
}
