import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { validateBody } from "../middleware/validate.js";

// Trip/signs-proof approval queues + fleet-wide reads for the dispatcher
// portal. Mounted (without its own prefix) under dispatcherRouter, which
// already applies requireAuth + requireDispatcher — see dispatcher.ts.
export const dispatcherApprovalsRouter = Router();

const rejectSchema = z.object({ reason: z.string().optional() });

dispatcherApprovalsRouter.get("/approvals/trips", async (_req, res) => {
  const trips = await prisma.trip.findMany({ where: { status: "awaiting_approval" } });
  res.json(trips);
});

dispatcherApprovalsRouter.post("/trips/:id/approve", async (req, res) => {
  const tripId = req.params.id as string;
  const trip = await prisma.trip.findUnique({ where: { id: tripId } });
  if (!trip) return res.status(404).json({ error: "Trip not found" });
  const updated = await prisma.trip.update({
    where: { id: tripId },
    data: { status: "approved", approvedAt: new Date(), approvedBy: req.auth!.dispatcherId },
  });
  res.json(updated);
});

dispatcherApprovalsRouter.post("/trips/:id/reject", validateBody(rejectSchema), async (req, res) => {
  const tripId = req.params.id as string;
  const trip = await prisma.trip.findUnique({ where: { id: tripId } });
  if (!trip) return res.status(404).json({ error: "Trip not found" });
  const updated = await prisma.trip.update({ where: { id: tripId }, data: { status: "rejected" } });
  res.json(updated);
});

dispatcherApprovalsRouter.get("/approvals/signs-proof", async (_req, res) => {
  const proofs = await prisma.signsProof.findMany({ where: { status: "pending" } });
  res.json(proofs);
});

dispatcherApprovalsRouter.post("/signs-proof/:id/approve", async (req, res) => {
  const id = req.params.id as string;
  const proof = await prisma.signsProof.findUnique({ where: { id } });
  if (!proof) return res.status(404).json({ error: "Signs-proof not found" });
  const updated = await prisma.signsProof.update({ where: { id }, data: { status: "approved" } });
  res.json(updated);
});

dispatcherApprovalsRouter.post("/signs-proof/:id/reject", validateBody(rejectSchema), async (req, res) => {
  const id = req.params.id as string;
  const proof = await prisma.signsProof.findUnique({ where: { id } });
  if (!proof) return res.status(404).json({ error: "Signs-proof not found" });
  const updated = await prisma.signsProof.update({ where: { id }, data: { status: "rejected" } });
  res.json(updated);
});

dispatcherApprovalsRouter.get("/locations", async (_req, res) => {
  const rows = await prisma.driverLocation.findMany({ orderBy: { createdAt: "desc" } });
  const latestByDriver = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latestByDriver.has(row.driverId)) latestByDriver.set(row.driverId, row);
  res.json([...latestByDriver.values()]);
});

dispatcherApprovalsRouter.get("/overview", async (_req, res) => {
  const grouped = await prisma.trip.groupBy({ by: ["status"], _count: { _all: true } });
  const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
  res.json(counts);
});
