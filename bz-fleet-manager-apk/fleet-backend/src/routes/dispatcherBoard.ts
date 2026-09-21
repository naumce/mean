import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { orgWhere } from "../middleware/orgScope.js";
import { tripScope } from "../lib/tripScope.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Read model for the dispatch board: the fleet lanes (drivers) plus the trips
// visible in a time window. A trip is "visible" if its planned start falls in
// the window, or if it is unscheduled (so dispatchers can drag it onto the
// board). Mounted at /api/dispatcher behind requireAuth + requireDispatcher +
// attachOrgScope (app.ts) — both reads are tenant-scoped: lanes by
// orgWhere(req), trips by tripScope(req).
export const dispatcherBoardRouter = Router();

const windowSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

dispatcherBoardRouter.get("/board", asyncRoute(async (req, res) => {
  const parsed = windowSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "from and to (ISO datetimes) are required" });
  const from = new Date(parsed.data.from);
  const to = new Date(parsed.data.to);

  const [drivers, trips] = await Promise.all([
    prisma.driver.findMany({ where: orgWhere(req), orderBy: { name: "asc" }, select: { id: true, name: true, status: true } }),
    prisma.trip.findMany({
      // AND, not a spread: tripScope() is itself an OR over the tenant, and
      // spreading it alongside the window OR would silently drop one of them.
      where: {
        AND: [tripScope(req), { OR: [{ scheduledStart: { gte: from, lt: to } }, { scheduledStart: null }] }],
      },
      orderBy: [{ scheduledStart: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, identifier: true, status: true, driverId: true,
        scheduledStart: true, scheduledEnd: true,
        _count: { select: { stops: true } },
      },
    }),
  ]);

  res.json({
    lanes: drivers,
    trips: trips.map((t) => ({
      id: t.id, identifier: t.identifier, status: t.status, driverId: t.driverId,
      scheduledStart: t.scheduledStart, scheduledEnd: t.scheduledEnd,
      stopCount: t._count.stops,
    })),
  });
}));
