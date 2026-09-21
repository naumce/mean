import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { validateBody } from "../middleware/validate.js";
import { orgWhere, outsideCallerOrg } from "../middleware/orgScope.js";
import { hashPassword } from "../lib/password.js";
import { guardLane } from "../lib/laneId.js";
import { emitToDispatchers } from "../realtime.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Driver & vehicle CRUD for the dispatcher portal. Mounted (without its own
// prefix) at /api/dispatcher behind requireAuth + requireDispatcher +
// attachOrgScope — see app.ts. Every handler below is tenant-scoped: lists
// filter by orgWhere(req), and a single resource outside the caller's org
// reads as 404 (never 403 — a 403 confirms the row exists).
export const dispatcherDriversRouter = Router();

const createDriverSchema = z.object({
  email: z.string().email(), name: z.string().min(1),
  phone: z.string().optional(), password: z.string().min(6),
});

dispatcherDriversRouter.get("/drivers", asyncRoute(async (req, res) => {
  const drivers = await prisma.driver.findMany({ where: orgWhere(req) });
  res.json(drivers.map(({ passwordHash, ...safe }) => safe));
}));

dispatcherDriversRouter.post("/drivers", validateBody(createDriverSchema), asyncRoute(async (req, res) => {
  const { email, name, phone, password } = req.body as z.infer<typeof createDriverSchema>;
  // Driver.email is globally @unique, so this duplicate check stays global:
  // scoping it to the caller's org would let the create through and turn a
  // cross-org collision into a P2002/500 instead of this 409.
  const existing = await prisma.driver.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "Email already in use" });
  const passwordHash = await hashPassword(password);
  // Stamp the creating dispatcher's tenant. Without it every portal-created
  // driver is orgless, and an orgless driver falls outside orgWhere() — it
  // would be invisible to the very dispatcher who just created it.
  const driver = await prisma.driver.create({
    data: { email, name, phone, passwordHash, orgId: req.orgScope ?? null },
  });
  const { passwordHash: _ph, ...safe } = driver;
  res.status(201).json(safe);
}));

dispatcherDriversRouter.get("/drivers/:id", asyncRoute(async (req, res) => {
  const driver = await prisma.driver.findUnique({ where: { id: req.params.id as string } });
  if (!driver || outsideCallerOrg(req, driver.orgId)) return res.status(404).json({ error: "Driver not found" });
  const { passwordHash, ...safe } = driver;
  res.json(safe);
}));

const updateDriverSchema = z.object({
  name: z.string().min(1).optional(), phone: z.string().optional(), status: z.string().optional(),
});

dispatcherDriversRouter.put("/drivers/:id", validateBody(updateDriverSchema), asyncRoute(async (req, res) => {
  const id = req.params.id as string;
  const existing = await prisma.driver.findUnique({ where: { id }, select: { orgId: true } });
  if (!existing || outsideCallerOrg(req, existing.orgId)) return res.status(404).json({ error: "Driver not found" });
  const updated = await prisma.driver.update({ where: { id }, data: req.body as z.infer<typeof updateDriverSchema> });
  const { passwordHash, ...safe } = updated;
  res.json(safe);
}));

dispatcherDriversRouter.get("/drivers/:id/locations", asyncRoute(async (req, res) => {
  const driverId = req.params.id as string;
  // DriverLocation carries no orgId — resolve the owning driver first so a
  // cross-tenant id reads as "no such driver" rather than an empty history.
  const driver = await prisma.driver.findUnique({ where: { id: driverId }, select: { orgId: true } });
  if (!driver || outsideCallerOrg(req, driver.orgId)) return res.status(404).json({ error: "Driver not found" });
  const locations = await prisma.driverLocation.findMany({ where: { driverId }, orderBy: { createdAt: "desc" } });
  res.json(locations);
}));

// --- Pairing (the yard hook, write side) -----------------------------------
// Cockpit S2a Task 10. S1 added Driver.defaultTractorId/defaultTrailerId and
// the loadboard reads them (dispatcherLoadboard.ts) as the driver's default
// equipment when no live leg overrides them; nothing wrote them until this
// route. `undefined` (key omitted) and `null` (key present) are deliberately
// different: an omitted key leaves that side of the pairing untouched, so
// dragging a trailer chip onto a lane cannot silently unhook the tractor
// already parked there.
//
// Does NOT replan the lane's existing assignments — the client sequences
// PATCH /assignments/:id/plan itself for legs that need to move (S2b); doing
// that implicitly here would move legs the dispatcher never asked to move.

// Pairing a driver's default equipment mutates their lane exactly like an
// assignment commit does, so it carries the identical guard with the identical
// 409 shape — lib/laneId.ts's guardLane(), shared with dispatcherAssignments.ts
// rather than copied (this file and that one held byte-identical private
// definitions until S2a's final fix wave).

const pairingSchema = z
  .object({
    tractorId: z.string().min(1).nullable().optional(),
    trailerId: z.string().min(1).nullable().optional(),
  })
  // At least one key must be PRESENT in the body (checked with `in`, not a
  // truthiness/undefined check on the parsed values) — that is what keeps
  // `{}` a 400 while `{ tractorId: null }` (an explicit unhook) still passes.
  .refine((data) => "tractorId" in data || "trailerId" in data, {
    message: "at least one of tractorId or trailerId is required",
  });

dispatcherDriversRouter.patch(
  "/drivers/:id/pairing",
  validateBody(pairingSchema),
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;
    const body = req.body as z.infer<typeof pairingSchema>;

    const driver = await prisma.driver.findUnique({ where: { id } });
    if (!driver || outsideCallerOrg(req, driver.orgId)) return res.status(404).json({ error: "Driver not found" });

    // The driver's tenancy is resolved BEFORE the lane guard runs, same
    // ordering POST /assignments uses and for the same reason: the lock
    // table is global by laneId, so guarding a lane before its tenancy is
    // established would let a foreign id be used to probe who holds it.
    if (!guardLane(req, res, id)) return;

    const data: Prisma.DriverUpdateInput = {};

    if ("tractorId" in body) {
      if (body.tractorId == null) {
        data.defaultTractorId = null;
      } else {
        const tractorId = body.tractorId;
        const tractor = await prisma.tractor.findUnique({ where: { id: tractorId } });
        if (!tractor || outsideCallerOrg(req, tractor.orgId)) {
          return res.status(404).json({ error: "Tractor not found" });
        }
        // One unit cannot be two drivers' default. No DB constraint backs
        // this (defaultTractorId carries no @unique — units are validated at
        // write time, not FK-enforced), so it is enforced here explicitly.
        const other = await prisma.driver.findFirst({
          where: { defaultTractorId: tractorId, NOT: { id } },
          select: { name: true },
        });
        if (other) return res.status(409).json({ error: `Tractor already paired to ${other.name}` });
        data.defaultTractorId = tractorId;
      }
    }

    if ("trailerId" in body) {
      if (body.trailerId == null) {
        data.defaultTrailerId = null;
      } else {
        const trailerId = body.trailerId;
        const trailer = await prisma.trailer.findUnique({ where: { id: trailerId } });
        if (!trailer || outsideCallerOrg(req, trailer.orgId)) {
          return res.status(404).json({ error: "Trailer not found" });
        }
        const other = await prisma.driver.findFirst({
          where: { defaultTrailerId: trailerId, NOT: { id } },
          select: { name: true },
        });
        if (other) return res.status(409).json({ error: `Trailer already paired to ${other.name}` });
        data.defaultTrailerId = trailerId;
      }
    }

    const updated = await prisma.driver.update({ where: { id }, data });

    // Fan the pairing change out to every dispatcher of this org so open
    // boards refresh live — same event the assignment routes emit on a
    // mutation, mirrored here with loadId: null since no load is involved.
    emitToDispatchers(driver.orgId, "board_update", { loadId: null, driverId: id, paired: true });

    const { passwordHash, ...safe } = updated;
    res.json({ driver: safe });
  }),
);

// --- Vehicles -------------------------------------------------------------
// Vehicle has no orgId column of its own (prisma/schema.prisma): its tenant is
// the org of the driver it is assigned to. An UNASSIGNED vehicle (driverId
// null) therefore belongs to no tenant and stays in the shared pool every
// dispatcher can see and claim — the only reading the current schema supports,
// and the same "a null org is nobody's" convention used everywhere else here.
// An assigned vehicle is strictly private to its driver's org.

/** True when a vehicle's owning driver puts it outside the caller's tenant. */
function vehicleOutsideCallerOrg(req: Request, driver: { orgId: string | null } | null): boolean {
  return driver != null && outsideCallerOrg(req, driver.orgId);
}

/** Prisma where-fragment selecting the vehicles this caller may see. */
function vehicleScope(req: Request): Prisma.VehicleWhereInput {
  if (req.orgScope == null) return {};
  return { OR: [{ driverId: null }, { driver: { orgId: req.orgScope } }] };
}

const createVehicleSchema = z.object({ plate: z.string().min(1), model: z.string().optional() });

dispatcherDriversRouter.get("/vehicles", asyncRoute(async (req, res) => {
  res.json(await prisma.vehicle.findMany({ where: vehicleScope(req) }));
}));

dispatcherDriversRouter.post("/vehicles", validateBody(createVehicleSchema), asyncRoute(async (req, res) => {
  const { plate, model } = req.body as z.infer<typeof createVehicleSchema>;
  // Vehicle.plate is globally @unique — same reasoning as the driver email above.
  const existing = await prisma.vehicle.findUnique({ where: { plate } });
  if (existing) return res.status(409).json({ error: "Plate already in use" });
  // No orgId to stamp: the model has no tenant column. A new vehicle enters
  // the unassigned pool and takes on its tenant at /assign time.
  const vehicle = await prisma.vehicle.create({ data: { plate, model } });
  res.status(201).json(vehicle);
}));

const updateVehicleSchema = z.object({ plate: z.string().min(1).optional(), model: z.string().optional() });

dispatcherDriversRouter.put("/vehicles/:id", validateBody(updateVehicleSchema), asyncRoute(async (req, res) => {
  const id = req.params.id as string;
  const existing = await prisma.vehicle.findUnique({
    where: { id }, select: { id: true, driver: { select: { orgId: true } } },
  });
  if (!existing || vehicleOutsideCallerOrg(req, existing.driver))
    return res.status(404).json({ error: "Vehicle not found" });
  const updated = await prisma.vehicle.update({ where: { id }, data: req.body as z.infer<typeof updateVehicleSchema> });
  res.json(updated);
}));

const assignVehicleSchema = z.object({ driverId: z.string().min(1) });

dispatcherDriversRouter.post("/vehicles/:id/assign", validateBody(assignVehicleSchema), asyncRoute(async (req, res) => {
  const id = req.params.id as string;
  const { driverId } = req.body as z.infer<typeof assignVehicleSchema>;
  // Both sides of the pairing must be the caller's: a foreign vehicle must not
  // be re-homed, and a foreign driver must not be handed equipment.
  const vehicle = await prisma.vehicle.findUnique({
    where: { id }, select: { id: true, driver: { select: { orgId: true } } },
  });
  if (!vehicle || vehicleOutsideCallerOrg(req, vehicle.driver))
    return res.status(404).json({ error: "Vehicle not found" });
  const driver = await prisma.driver.findUnique({ where: { id: driverId }, select: { orgId: true } });
  if (!driver || outsideCallerOrg(req, driver.orgId)) return res.status(404).json({ error: "Driver not found" });
  try {
    const updated = await prisma.vehicle.update({ where: { id }, data: { driverId } });
    res.json(updated);
  } catch {
    // Vehicle.driverId is @unique — the target driver already has a vehicle.
    res.status(409).json({ error: "Driver already assigned to another vehicle" });
  }
}));
