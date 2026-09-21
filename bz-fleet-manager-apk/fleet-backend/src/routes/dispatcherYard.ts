import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { orgWhere } from "../middleware/orgScope.js";
import { ACTIVE_STATUSES } from "../lib/activeStatuses.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// The Yard (mockup §Yard): what is available RIGHT NOW — bobtail tractors,
// dropped trailers, and drivers with no live trip. "Available" is computed
// from real assignment state: a resource on an assigned/tendered/in_progress
// trip whose planned window hasn't ended is busy. Mounted with attachOrgScope.
export const dispatcherYardRouter = Router();

// T1 Carrier Layer, Task 8 (follow-up): the cockpit's carrier filter narrows
// dispatcherLoadboard.ts's tractors/trailers, but the chips a dispatcher
// actually drags come from HERE — YardChips.vue renders lb.yard, not
// lb.tractors/lb.trailers. Without this, filtering to Carrier A still let a
// Carrier B trailer get hooked onto a Carrier A driver via drag-and-drop.
// Same fail-closed equality shape as dispatcherLoadboard.ts's carrierFilter:
// no existence check, no fallback — an unknown or cross-org id simply
// matches zero rows, combined with `scope` exactly like every other
// org-scoped condition here.
const querySchema = z.object({ carrierId: z.string().min(1).optional() });

dispatcherYardRouter.get("/yard", asyncRoute(async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "invalid carrierId" });
  const scope = orgWhere(req);
  const now = new Date();
  const carrierFilter = parsed.data.carrierId ? { carrierId: parsed.data.carrierId } : {};

  const busy = await prisma.assignment.findMany({
    where: { ...scope, status: { in: [...ACTIVE_STATUSES] }, plannedEnd: { gt: now } },
    select: { driverId: true, tractorId: true, trailerId: true },
  });
  const busyDrivers = new Set(busy.map((b) => b.driverId));
  const busyTractors = new Set(busy.map((b) => b.tractorId).filter(Boolean));
  const busyTrailers = new Set(busy.map((b) => b.trailerId).filter(Boolean));

  const [tractors, trailers, drivers] = await Promise.all([
    prisma.tractor.findMany({
      where: { ...scope, status: "active", ...carrierFilter },
      orderBy: { unit: "asc" },
      select: { id: true, unit: true, make: true, status: true },
    }),
    prisma.trailer.findMany({
      where: { ...scope, status: { in: ["active", "idle"] }, ...carrierFilter },
      orderBy: { unit: "asc" },
      select: { id: true, unit: true, type: true, length: true, status: true },
    }),
    // Drivers are deliberately NOT carrier-filtered here — out of scope for
    // this fix, which targets the equipment-mixing hazard (a Carrier B
    // *trailer* hooked onto a Carrier A driver via drag-and-drop). An open
    // driver chip carries its own carrier identity already; it isn't
    // equipment that can be mismatched onto another carrier's driver the
    // way a tractor/trailer chip can.
    prisma.driver.findMany({
      where: { ...scope },
      orderBy: { name: "asc" },
      select: { id: true, name: true, status: true, hos: { select: { driveRemainingMin: true } } },
    }),
  ]);

  res.json({
    tractors: tractors.filter((t) => !busyTractors.has(t.id)),
    trailers: trailers.filter((t) => !busyTrailers.has(t.id)),
    drivers: drivers
      .filter((d) => !busyDrivers.has(d.id))
      .map((d) => ({
        id: d.id,
        name: d.name,
        status: d.status,
        hosKnown: d.hos != null,
        driveRemainingMin: d.hos?.driveRemainingMin ?? null,
      })),
  });
}));
