// "Where are you?" — a dispatcher asks, the driver's phone prompts, the driver
// presses approve, and only then does a position arrive.
//
// This is deliberately a handshake and not a silent poll. A dispatch service
// does not get to read a driver's location whenever it likes; the driver
// consents each time. That shapes the API: a request has four outcomes and
// nothing here may collapse them —
//
//   pending   asked, no answer yet          (NOT a location)
//   approved  they shared it                (the only one carrying a position)
//   denied    they said no                  (a real answer, not missing data)
//   expired   nobody answered in time       (not the same as a refusal)
//
// Mounted under dispatcherRouter — auth and role already enforced.

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { orgWhere } from "../middleware/orgScope.js";
import { asyncRoute } from "../lib/asyncRoute.js";

export const dispatcherLocationRequestsRouter = Router();

/** A request nobody answered in this long is stale. It is marked `expired`
 *  rather than left pending forever: a three-day-old "pending" on a dispatcher's
 *  screen reads as "they might still answer", which is not true. */
export const REQUEST_TTL_MIN = 30;

const createSchema = z.object({ driverId: z.string().min(1) });

/** Flip anything past its TTL to `expired` before reading. Cheap, and it keeps
 *  the expiry rule in ONE place rather than duplicated across every reader. */
async function sweepExpired(orgId: string): Promise<void> {
  await prisma.locationRequest.updateMany({
    where: { orgId, status: "pending", requestedAt: { lt: new Date(Date.now() - REQUEST_TTL_MIN * 60_000) } },
    data: { status: "expired", respondedAt: new Date() },
  });
}

dispatcherLocationRequestsRouter.post("/location-requests", asyncRoute(async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "driverId is required" });

    // 404 (never 403) for a driver outside this org — a 403 confirms the id.
    const driver = await prisma.driver.findFirst({
      where: { id: parsed.data.driverId, ...orgWhere(req) },
      select: { id: true, orgId: true },
    });
    if (!driver?.orgId) return res.status(404).json({ error: "Driver not found" });

    await sweepExpired(driver.orgId);

    // One live question at a time. Asking again while the driver's phone is
    // already prompting would show them a queue of identical requests, and
    // whichever they answered would leave the others hanging.
    const open = await prisma.locationRequest.findFirst({
      where: { driverId: driver.id, status: "pending" },
    });
    if (open) return res.status(200).json({ request: open, alreadyPending: true });

    const created = await prisma.locationRequest.create({
      data: {
        orgId: driver.orgId,
        driverId: driver.id,
        requestedBy: (req as { dispatcher?: { id?: string } }).dispatcher?.id ?? "unknown",
      },
    });
    res.status(201).json({ request: created, alreadyPending: false });
  } catch (err) {
    // Express 4 does not await handlers; without this the request hangs.
    next(err);
  }
}));

dispatcherLocationRequestsRouter.get("/location-requests", asyncRoute(async (req, res, next) => {
  try {
    const scope = orgWhere(req);
    const orgId = (scope as { orgId?: string }).orgId;
    if (orgId) await sweepExpired(orgId);

    const requests = await prisma.locationRequest.findMany({
      where: { ...scope },
      orderBy: { requestedAt: "desc" },
      take: 50,
      select: {
        id: true, driverId: true, status: true, requestedAt: true,
        respondedAt: true, locationId: true,
        driver: { select: { name: true } },
      },
    });

    // Attach the shared position ONLY for approved requests. A pending or
    // denied request has no location and must not appear to have one.
    const locIds = requests.map((r) => r.locationId).filter((x): x is string => !!x);
    const locs = locIds.length
      ? await prisma.driverLocation.findMany({
          where: { id: { in: locIds } },
          select: { id: true, latitude: true, longitude: true, createdAt: true },
        })
      : [];
    const byId = new Map(locs.map((l) => [l.id, l]));

    res.json(
      requests.map((r) => ({
        id: r.id,
        driverId: r.driverId,
        driverName: r.driver.name,
        status: r.status,
        requestedAt: r.requestedAt,
        respondedAt: r.respondedAt,
        location: r.status === "approved" && r.locationId ? (byId.get(r.locationId) ?? null) : null,
      })),
    );
  } catch (err) {
    next(err);
  }
}));
