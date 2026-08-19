import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";

// Mounted at "/api/navigation" in app.ts.
export const navigationRouter = Router();
navigationRouter.use(requireAuth);

const routeSchema = z.object({
  origin: z.string(),
  destination: z.string(),
  waypoints: z.array(z.string()).optional(),
});

// Stub only: echoes the requested route back with distance:null. No routing
// engine is wired up yet, and nothing here is persisted.
navigationRouter.post("/route", validateBody(routeSchema), async (req, res) => {
  const { origin, destination, waypoints } = req.body as z.infer<typeof routeSchema>;
  res.json({ origin, destination, waypoints: waypoints ?? [], distance: null });
});

const incidentSchema = z.object({
  type: z.string().min(1),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  description: z.string().optional(),
});

navigationRouter.post("/incident", validateBody(incidentSchema), async (req, res) => {
  const { type, latitude, longitude, description } = req.body as z.infer<typeof incidentSchema>;
  const created = await prisma.incident.create({
    data: { driverId: req.auth!.driverId, type, latitude, longitude, description } });
  res.json(created);
});
