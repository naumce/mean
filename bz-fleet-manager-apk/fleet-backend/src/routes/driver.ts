import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";

export const driverRouter = Router();
driverRouter.use(requireAuth);

driverRouter.get("/profile", async (req, res) => {
  const d = await prisma.driver.findUnique({ where: { id: req.auth!.driverId } });
  if (!d) return res.status(404).json({ error: "Not found" });
  const { passwordHash, ...safe } = d;
  res.json(safe);
});

driverRouter.put("/status", validateBody(z.object({ status: z.string().min(1) })), async (req, res) => {
  const d = await prisma.driver.update({
    where: { id: req.auth!.driverId }, data: { status: req.body.status } });
  res.json({ status: d.status });
});

driverRouter.get("/trip/current", async (req, res) => {
  const t = await prisma.trip.findFirst({
    where: { driverId: req.auth!.driverId, status: { in: ["assigned", "in_progress", "arrived"] } },
    orderBy: { createdAt: "desc" } });
  if (!t) return res.json({ success: false });
  res.json({ success: true, tripId: t.id, tripIdentifier: t.identifier,
             preTripCheckCompleted: t.preTripCheckCompleted });
});

driverRouter.get("/trips/active", async (req, res) => {
  const trips = await prisma.trip.findMany({
    where: { driverId: req.auth!.driverId, status: { in: ["assigned", "in_progress", "arrived"] } } });
  res.json(trips);
});

driverRouter.post("/location", validateBody(z.object({
  latitude: z.number(), longitude: z.number(),
  speed: z.number().optional(), heading: z.number().optional(), accuracy: z.number().optional(),
})), async (req, res) => {
  const { latitude, longitude } = req.body as { latitude: number; longitude: number };
  const loc = await prisma.driverLocation.create({
    data: { driverId: req.auth!.driverId, latitude, longitude } });
  res.status(201).json(loc);
});
