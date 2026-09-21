import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { validateBody } from "../middleware/validate.js";
import { outsideCallerOrg } from "../middleware/orgScope.js";
import { tripScope, tripOutsideCallerOrg } from "../lib/tripScope.js";
import { emitToDriver } from "../realtime.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Trip creation, listing, and assignment for the dispatcher portal. Mounted
// (without its own prefix) at /api/dispatcher behind requireAuth +
// requireDispatcher + attachOrgScope — see app.ts. Every handler below is
// tenant-scoped: lists filter by tripScope(req), and a trip or driver outside
// the caller's org reads as 404 (never 403 — a 403 confirms the row exists).
// Trip reaches its tenant through its driver; see lib/tripScope.ts for why an
// unassigned trip is shared rather than private.
export const dispatcherTripsRouter = Router();

const createTripSchema = z.object({
  identifier: z.string().min(1),
  stops: z.array(z.object({ sequence: z.number().int(), address: z.string().min(1) })).min(1),
  checklistItems: z.array(z.object({ label: z.string().min(1), required: z.boolean().optional() })).optional(),
  scheduledStart: z.string().datetime().optional(),
  scheduledEnd: z.string().datetime().optional(),
});

dispatcherTripsRouter.post("/trips", validateBody(createTripSchema), asyncRoute(async (req, res) => {
  const { identifier, stops, checklistItems, scheduledStart, scheduledEnd } = req.body as z.infer<typeof createTripSchema>;
  // No orgId to stamp: Trip has no tenant column (lib/tripScope.ts). A new
  // trip is created unassigned and takes on its tenant at /assign time, the
  // same way an unassigned Vehicle does in dispatcherDrivers.ts.
  const trip = await prisma.trip.create({
    data: {
      identifier,
      status: "pending",
      scheduledStart: scheduledStart ? new Date(scheduledStart) : undefined,
      scheduledEnd: scheduledEnd ? new Date(scheduledEnd) : undefined,
      stops: { create: stops.map((s) => ({ sequence: s.sequence, address: s.address })) },
      checklistItems: checklistItems
        ? { create: checklistItems.map((c) => ({ label: c.label, required: c.required ?? true })) }
        : undefined,
    },
    include: { stops: true, checklistItems: true },
  });
  res.status(201).json(trip);
}));

dispatcherTripsRouter.get("/trips", asyncRoute(async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const driverId = typeof req.query.driverId === "string" ? req.query.driverId : undefined;
  const trips = await prisma.trip.findMany({
    // tripScope first: a ?driverId= naming another org's driver still has to
    // clear the tenant filter, so it returns nothing rather than their board.
    where: { ...tripScope(req), ...(status ? { status } : {}), ...(driverId ? { driverId } : {}) },
    orderBy: { createdAt: "desc" },
    include: { stops: true },
  });
  res.json(trips);
}));

dispatcherTripsRouter.get("/trips/:id", asyncRoute(async (req, res) => {
  const trip = await prisma.trip.findUnique({
    where: { id: req.params.id as string },
    include: {
      stops: { include: { signsProofs: true, uploads: true, requirements: true } },
      checklistItems: true,
      // Fetched only to resolve the tenant; stripped from the response below
      // so the payload shape stays exactly what the portal already reads.
      driver: { select: { orgId: true } },
    },
  });
  if (!trip || tripOutsideCallerOrg(req, trip.driver)) return res.status(404).json({ error: "Trip not found" });
  const { driver: _owner, ...safe } = trip;
  res.json(safe);
}));

const assignTripSchema = z.object({ driverId: z.string().min(1) });

dispatcherTripsRouter.post("/trips/:id/assign", validateBody(assignTripSchema), asyncRoute(async (req, res) => {
  const tripId = req.params.id as string;
  const { driverId } = req.body as z.infer<typeof assignTripSchema>;
  // Both sides of the pairing must be the caller's: a foreign org's trip must
  // not be re-homed, and a foreign driver must not be handed work.
  const trip = await prisma.trip.findUnique({
    where: { id: tripId }, select: { id: true, driver: { select: { orgId: true } } },
  });
  if (!trip || tripOutsideCallerOrg(req, trip.driver)) return res.status(404).json({ error: "Trip not found" });
  const driver = await prisma.driver.findUnique({ where: { id: driverId }, select: { orgId: true } });
  if (!driver || outsideCallerOrg(req, driver.orgId)) return res.status(404).json({ error: "Driver not found" });
  const updated = await prisma.trip.update({ where: { id: tripId }, data: { driverId, status: "assigned" } });
  await prisma.routePreAssignment.create({ data: { driverId, tripId, status: "pending" } });
  emitToDriver(driverId, "trip_assignment", { tripId });
  emitToDriver(driverId, "route_pre_assignment", { tripId });
  res.json(updated);
}));
