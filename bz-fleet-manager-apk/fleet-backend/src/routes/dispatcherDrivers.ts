import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { validateBody } from "../middleware/validate.js";
import { hashPassword } from "../lib/password.js";

// Driver & vehicle CRUD for the dispatcher portal. Mounted (without its own
// prefix) under dispatcherRouter, which already applies requireAuth +
// requireDispatcher — see dispatcher.ts.
export const dispatcherDriversRouter = Router();

const createDriverSchema = z.object({
  email: z.string().email(), name: z.string().min(1),
  phone: z.string().optional(), password: z.string().min(6),
});

dispatcherDriversRouter.get("/drivers", async (_req, res) => {
  const drivers = await prisma.driver.findMany();
  res.json(drivers.map(({ passwordHash, ...safe }) => safe));
});

dispatcherDriversRouter.post("/drivers", validateBody(createDriverSchema), async (req, res) => {
  const { email, name, phone, password } = req.body as z.infer<typeof createDriverSchema>;
  const existing = await prisma.driver.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "Email already in use" });
  const passwordHash = await hashPassword(password);
  const driver = await prisma.driver.create({ data: { email, name, phone, passwordHash } });
  const { passwordHash: _ph, ...safe } = driver;
  res.status(201).json(safe);
});

dispatcherDriversRouter.get("/drivers/:id", async (req, res) => {
  const driver = await prisma.driver.findUnique({ where: { id: req.params.id as string } });
  if (!driver) return res.status(404).json({ error: "Driver not found" });
  const { passwordHash, ...safe } = driver;
  res.json(safe);
});

const updateDriverSchema = z.object({
  name: z.string().min(1).optional(), phone: z.string().optional(), status: z.string().optional(),
});

dispatcherDriversRouter.put("/drivers/:id", validateBody(updateDriverSchema), async (req, res) => {
  const id = req.params.id as string;
  const existing = await prisma.driver.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Driver not found" });
  const updated = await prisma.driver.update({ where: { id }, data: req.body as z.infer<typeof updateDriverSchema> });
  const { passwordHash, ...safe } = updated;
  res.json(safe);
});

dispatcherDriversRouter.get("/drivers/:id/locations", async (req, res) => {
  const driverId = req.params.id as string;
  const locations = await prisma.driverLocation.findMany({ where: { driverId }, orderBy: { createdAt: "desc" } });
  res.json(locations);
});

const createVehicleSchema = z.object({ plate: z.string().min(1), model: z.string().optional() });

dispatcherDriversRouter.get("/vehicles", async (_req, res) => {
  res.json(await prisma.vehicle.findMany());
});

dispatcherDriversRouter.post("/vehicles", validateBody(createVehicleSchema), async (req, res) => {
  const { plate, model } = req.body as z.infer<typeof createVehicleSchema>;
  const existing = await prisma.vehicle.findUnique({ where: { plate } });
  if (existing) return res.status(409).json({ error: "Plate already in use" });
  const vehicle = await prisma.vehicle.create({ data: { plate, model } });
  res.status(201).json(vehicle);
});

const updateVehicleSchema = z.object({ plate: z.string().min(1).optional(), model: z.string().optional() });

dispatcherDriversRouter.put("/vehicles/:id", validateBody(updateVehicleSchema), async (req, res) => {
  const id = req.params.id as string;
  const existing = await prisma.vehicle.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Vehicle not found" });
  const updated = await prisma.vehicle.update({ where: { id }, data: req.body as z.infer<typeof updateVehicleSchema> });
  res.json(updated);
});

const assignVehicleSchema = z.object({ driverId: z.string().min(1) });

dispatcherDriversRouter.post("/vehicles/:id/assign", validateBody(assignVehicleSchema), async (req, res) => {
  const id = req.params.id as string;
  const { driverId } = req.body as z.infer<typeof assignVehicleSchema>;
  const vehicle = await prisma.vehicle.findUnique({ where: { id } });
  if (!vehicle) return res.status(404).json({ error: "Vehicle not found" });
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver) return res.status(404).json({ error: "Driver not found" });
  try {
    const updated = await prisma.vehicle.update({ where: { id }, data: { driverId } });
    res.json(updated);
  } catch {
    // Vehicle.driverId is @unique — the target driver already has a vehicle.
    res.status(409).json({ error: "Driver already assigned to another vehicle" });
  }
});
