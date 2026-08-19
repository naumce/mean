import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { validateBody } from "../middleware/validate.js";

// Trip creation, listing, and assignment for the dispatcher portal. Mounted
// (without its own prefix) under dispatcherRouter, which already applies
// requireAuth + requireDispatcher — see dispatcher.ts.
export const dispatcherTripsRouter = Router();

const createTripSchema = z.object({
  identifier: z.string().min(1),
  stops: z.array(z.object({ sequence: z.number().int(), address: z.string().min(1) })).min(1),
  checklistItems: z.array(z.object({ label: z.string().min(1), required: z.boolean().optional() })).optional(),
});

dispatcherTripsRouter.post("/trips", validateBody(createTripSchema), async (req, res) => {
  const { identifier, stops, checklistItems } = req.body as z.infer<typeof createTripSchema>;
  const trip = await prisma.trip.create({
    data: {
      identifier,
      status: "pending",
      stops: { create: stops.map((s) => ({ sequence: s.sequence, address: s.address })) },
      checklistItems: checklistItems
        ? { create: checklistItems.map((c) => ({ label: c.label, required: c.required ?? true })) }
        : undefined,
    },
    include: { stops: true, checklistItems: true },
  });
  res.status(201).json(trip);
});

dispatcherTripsRouter.get("/trips", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const driverId = typeof req.query.driverId === "string" ? req.query.driverId : undefined;
  const trips = await prisma.trip.findMany({
    where: { ...(status ? { status } : {}), ...(driverId ? { driverId } : {}) },
    orderBy: { createdAt: "desc" },
  });
  res.json(trips);
});

dispatcherTripsRouter.get("/trips/:id", async (req, res) => {
  const trip = await prisma.trip.findUnique({
    where: { id: req.params.id as string },
    include: { stops: { include: { signsProofs: true, uploads: true, requirements: true } }, checklistItems: true },
  });
  if (!trip) return res.status(404).json({ error: "Trip not found" });
  res.json(trip);
});

const assignTripSchema = z.object({ driverId: z.string().min(1) });

dispatcherTripsRouter.post("/trips/:id/assign", validateBody(assignTripSchema), async (req, res) => {
  const tripId = req.params.id as string;
  const { driverId } = req.body as z.infer<typeof assignTripSchema>;
  const trip = await prisma.trip.findUnique({ where: { id: tripId } });
  if (!trip) return res.status(404).json({ error: "Trip not found" });
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver) return res.status(404).json({ error: "Driver not found" });
  const updated = await prisma.trip.update({ where: { id: tripId }, data: { driverId, status: "assigned" } });
  await prisma.routePreAssignment.create({ data: { driverId, tripId, status: "pending" } });
  res.json(updated);
});
