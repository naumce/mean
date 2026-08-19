import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";

// Mounted at "/api/driver" in app.ts.
export const safetyRouter = Router();
safetyRouter.use(requireAuth);

const locationSchema = z.object({ latitude: z.number().optional(), longitude: z.number().optional() });

safetyRouter.post("/panic", validateBody(locationSchema), async (req, res) => {
  const { latitude, longitude } = req.body as z.infer<typeof locationSchema>;
  const created = await prisma.safetyAlert.create({
    data: { driverId: req.auth!.driverId, kind: "panic", latitude, longitude } });
  res.json(created);
});

const emergencySchema = locationSchema.extend({
  description: z.string().optional(),
  reason: z.string().optional(),
});

safetyRouter.post("/emergency", validateBody(emergencySchema), async (req, res) => {
  const { latitude, longitude, description, reason } = req.body as z.infer<typeof emergencySchema>;
  const created = await prisma.safetyAlert.create({
    data: { driverId: req.auth!.driverId, kind: "emergency", latitude, longitude, description, reason } });
  res.json(created);
});

const fuelSchema = z.object({
  amount: z.number().optional(),
  cost: z.number().optional(),
  odometer: z.number().int().optional(),
  vehicleId: z.string().optional(),
});

safetyRouter.post("/fuel", validateBody(fuelSchema), async (req, res) => {
  const { amount, cost, odometer, vehicleId } = req.body as z.infer<typeof fuelSchema>;
  const created = await prisma.fuelLog.create({
    data: { driverId: req.auth!.driverId, amount, cost, odometer, vehicleId } });
  res.json(created);
});
