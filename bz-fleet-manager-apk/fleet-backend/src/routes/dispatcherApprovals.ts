import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { validateBody } from "../middleware/validate.js";
import { orgWhere } from "../middleware/orgScope.js";
import { tripScope, tripOutsideCallerOrg, signsProofScope } from "../lib/tripScope.js";
import { emitToDriver } from "../realtime.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Trip/signs-proof approval queues + fleet-wide reads for the dispatcher
// portal. Mounted (without its own prefix) at /api/dispatcher behind
// requireAuth + requireDispatcher + attachOrgScope — see app.ts. Every handler
// below is tenant-scoped: queues filter by tripScope/signsProofScope, and a
// row outside the caller's org reads as 404 (never 403 — a 403 confirms the
// row exists). Trip and SignsProof both reach their tenant through the trip's
// driver; see lib/tripScope.ts.
export const dispatcherApprovalsRouter = Router();

const rejectSchema = z.object({ reason: z.string().optional() });

/** Loads a trip's tenant, or null when the id is unknown/foreign. */
async function scopedTrip(req: Parameters<typeof tripOutsideCallerOrg>[0], tripId: string) {
  const trip = await prisma.trip.findUnique({
    where: { id: tripId }, select: { id: true, driver: { select: { orgId: true } } },
  });
  if (!trip || tripOutsideCallerOrg(req, trip.driver)) return null;
  return trip;
}

dispatcherApprovalsRouter.get("/approvals/trips", asyncRoute(async (req, res) => {
  const trips = await prisma.trip.findMany({ where: { ...tripScope(req), status: "awaiting_approval" } });
  res.json(trips);
}));

dispatcherApprovalsRouter.post("/trips/:id/approve", asyncRoute(async (req, res) => {
  const tripId = req.params.id as string;
  if (!(await scopedTrip(req, tripId))) return res.status(404).json({ error: "Trip not found" });
  const updated = await prisma.trip.update({
    where: { id: tripId },
    data: { status: "approved", approvedAt: new Date(), approvedBy: req.auth!.dispatcherId },
  });
  if (updated.driverId) emitToDriver(updated.driverId, "status_change", { tripId, status: updated.status });
  res.json(updated);
}));

dispatcherApprovalsRouter.post("/trips/:id/reject", validateBody(rejectSchema), asyncRoute(async (req, res) => {
  const tripId = req.params.id as string;
  if (!(await scopedTrip(req, tripId))) return res.status(404).json({ error: "Trip not found" });
  const updated = await prisma.trip.update({ where: { id: tripId }, data: { status: "rejected" } });
  res.json(updated);
}));

dispatcherApprovalsRouter.get("/approvals/signs-proof", asyncRoute(async (req, res) => {
  const proofs = await prisma.signsProof.findMany({ where: { ...signsProofScope(req), status: "pending" } });
  res.json(proofs);
}));

// A SignsProof doesn't carry a driverId directly — the recipient is resolved
// via stop -> trip -> driverId.
async function signsProofDriverId(stopId: string) {
  const stop = await prisma.stop.findUnique({ where: { id: stopId }, include: { trip: true } });
  return stop?.trip.driverId ?? null;
}

/** Loads a signs-proof's tenant, or null when the id is unknown/foreign. */
async function scopedSignsProof(req: Parameters<typeof tripOutsideCallerOrg>[0], id: string) {
  const proof = await prisma.signsProof.findUnique({
    where: { id },
    select: { id: true, stopId: true, stop: { select: { trip: { select: { driver: { select: { orgId: true } } } } } } },
  });
  if (!proof || tripOutsideCallerOrg(req, proof.stop.trip.driver)) return null;
  return proof;
}

dispatcherApprovalsRouter.post("/signs-proof/:id/approve", asyncRoute(async (req, res) => {
  const id = req.params.id as string;
  const proof = await scopedSignsProof(req, id);
  if (!proof) return res.status(404).json({ error: "Signs-proof not found" });
  const updated = await prisma.signsProof.update({ where: { id }, data: { status: "approved" } });
  const driverId = await signsProofDriverId(proof.stopId);
  if (driverId) emitToDriver(driverId, "signs_proof_approved", { signsProofId: id });
  res.json(updated);
}));

dispatcherApprovalsRouter.post("/signs-proof/:id/reject", validateBody(rejectSchema), asyncRoute(async (req, res) => {
  const id = req.params.id as string;
  const proof = await scopedSignsProof(req, id);
  if (!proof) return res.status(404).json({ error: "Signs-proof not found" });
  const updated = await prisma.signsProof.update({ where: { id }, data: { status: "rejected" } });
  const driverId = await signsProofDriverId(proof.stopId);
  if (driverId) emitToDriver(driverId, "signs_proof_rejected", { signsProofId: id });
  res.json(updated);
}));

dispatcherApprovalsRouter.get("/locations", asyncRoute(async (req, res) => {
  // Tenancy: only the requesting dispatcher's own org's drivers. This handler
  // hand-rolled the scope before attachOrgScope reached this router; it now
  // reads req.orgScope through orgWhere() like every other list, which is the
  // same filter minus a redundant Dispatcher lookup. A legacy null-org
  // dispatcher keeps the historical see-all behavior. driverName rides along
  // so the tracking table never has to render a bare id.
  const drivers = await prisma.driver.findMany({ where: orgWhere(req), select: { id: true, name: true } });
  const nameById = new Map(drivers.map((d) => [d.id, d.name]));
  const rows = await prisma.driverLocation.findMany({
    where: { driverId: { in: drivers.map((d) => d.id) } },
    orderBy: { createdAt: "desc" },
  });
  const latestByDriver = new Map<string, (typeof rows)[number] & { driverName?: string }>();
  for (const row of rows)
    if (!latestByDriver.has(row.driverId))
      latestByDriver.set(row.driverId, { ...row, driverName: nameById.get(row.driverId) });
  res.json([...latestByDriver.values()]);
}));

dispatcherApprovalsRouter.get("/overview", asyncRoute(async (req, res) => {
  const grouped = await prisma.trip.groupBy({
    by: ["status"], _count: { _all: true }, where: tripScope(req),
  });
  const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
  res.json(counts);
}));
