import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";

// Mounted at "/api" in app.ts — `/vehicles/:id/issues` and `/driver/vehicle`
// don't share a common prefix, so both live in this one router (same
// reasoning as signsProofRouter).
export const vehicleRouter = Router();
vehicleRouter.use(requireAuth);

const issueSchema = z.object({ description: z.string().min(1), severity: z.string().optional() });

vehicleRouter.post("/vehicles/:id/issues", validateBody(issueSchema), async (req, res) => {
  const vehicleId = req.params.id as string;
  const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
  if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });
  const { description, severity } = req.body as z.infer<typeof issueSchema>;
  const created = await prisma.vehicleIssue.create({
    data: { vehicleId: vehicle.id, driverId: req.auth!.driverId, description, severity } });
  res.json(created);
});

vehicleRouter.get("/driver/vehicle", async (req, res) => {
  const vehicle = await prisma.vehicle.findFirst({ where: { driverId: req.auth!.driverId } });
  if (!vehicle) return res.status(404).json({ error: "No assigned vehicle" });
  res.json(vehicle);
});
