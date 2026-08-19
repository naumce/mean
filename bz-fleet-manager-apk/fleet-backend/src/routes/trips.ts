import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { canStart } from "../domain/tripState.js";

export const tripsRouter = Router();
tripsRouter.use(requireAuth);

tripsRouter.post("/:id/start", async (req, res) => {
  // ownership by construction: match id AND driverId together
  const trip = await prisma.trip.findFirst({ where: { id: req.params.id, driverId: req.auth!.driverId } });
  if (!trip) return res.status(404).json({ error: "Trip not found" });
  const guard = canStart(trip);
  if (!guard.ok) return res.status(409).json({ error: guard.reason });
  const updated = await prisma.trip.update({
    where: { id: trip.id }, data: { status: "in_progress", startedAt: new Date() } });
  res.json(updated);
});
