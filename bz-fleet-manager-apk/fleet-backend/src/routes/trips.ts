import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { canStart } from "../domain/tripState.js";
import { canArriveStop, canCompleteStop, canCompleteTrip } from "../domain/stopState.js";
import { upload } from "../lib/upload.js";
import { asyncRoute } from "../lib/asyncRoute.js";

export const tripsRouter = Router();
tripsRouter.use(requireAuth);

tripsRouter.post("/:id/start", asyncRoute(async (req, res) => {
  // ownership by construction: match id AND driverId together
  const trip = await prisma.trip.findFirst({ where: { id: req.params.id as string, driverId: req.auth!.driverId } });
  if (!trip) return res.status(404).json({ error: "Trip not found" });
  const guard = canStart(trip);
  if (!guard.ok) return res.status(409).json({ error: guard.reason });
  const updated = await prisma.trip.update({
    where: { id: trip.id }, data: { status: "in_progress", startedAt: new Date() } });
  res.json(updated);
}));

tripsRouter.get("/:id/checklist", asyncRoute(async (req, res) => {
  const trip = await prisma.trip.findFirst({ where: { id: req.params.id as string, driverId: req.auth!.driverId } });
  if (!trip) return res.status(404).json({ error: "Trip not found" });
  const items = await prisma.checklistItem.findMany({ where: { tripId: trip.id } });
  res.json(items);
}));

const checklistCompleteSchema = z.object({ loadId: z.string().optional(), populate: z.boolean().optional() });

tripsRouter.post("/:id/checklist/complete", validateBody(checklistCompleteSchema), asyncRoute(async (req, res) => {
  // combining validateBody's generic RequestHandler with this route's typed
  // params widens req.params.id to string|string[] under @types/express 5's
  // repeated-param typing; a single ":id" segment is always a plain string.
  const tripId = req.params.id as string;
  const trip = await prisma.trip.findFirst({ where: { id: tripId, driverId: req.auth!.driverId } });
  if (!trip) return res.status(404).json({ error: "Trip not found" });
  await prisma.checklistItem.updateMany({ where: { tripId: trip.id }, data: { completed: true } });
  const updated = await prisma.trip.update({ where: { id: trip.id }, data: { preTripCheckCompleted: true } });
  res.json(updated);
}));

tripsRouter.post("/:id/stops/:stopId/arrive", asyncRoute(async (req, res) => {
  const trip = await prisma.trip.findFirst({ where: { id: req.params.id as string, driverId: req.auth!.driverId } });
  if (!trip) return res.status(404).json({ error: "Trip not found" });
  const stop = await prisma.stop.findFirst({ where: { id: req.params.stopId as string, tripId: trip.id } });
  if (!stop) return res.status(404).json({ error: "Stop not found" });
  const earlierStops = await prisma.stop.findMany({ where: { tripId: trip.id, sequence: { lt: stop.sequence } } });
  const guard = canArriveStop(trip, stop, earlierStops);
  if (!guard.ok) return res.status(409).json({ error: guard.reason });
  const updated = await prisma.stop.update({
    where: { id: stop.id }, data: { status: "arrived", arrivedAt: new Date() } });
  res.json(updated);
}));

tripsRouter.post("/:id/stops/:stopId/complete", asyncRoute(async (req, res) => {
  const trip = await prisma.trip.findFirst({ where: { id: req.params.id as string, driverId: req.auth!.driverId } });
  if (!trip) return res.status(404).json({ error: "Trip not found" });
  const stop = await prisma.stop.findFirst({ where: { id: req.params.stopId as string, tripId: trip.id } });
  if (!stop) return res.status(404).json({ error: "Stop not found" });
  const requiredCount = await prisma.signsProofRequirement.count({ where: { stopId: stop.id, required: true } });
  const providedCount = await prisma.signsProof.count({ where: { stopId: stop.id } });
  const guard = canCompleteStop(stop, requiredCount, providedCount);
  if (!guard.ok) return res.status(409).json({ error: guard.reason });
  const updated = await prisma.stop.update({
    where: { id: stop.id }, data: { status: "completed", completedAt: new Date() } });
  res.json(updated);
}));

// combining multer's generic RequestHandler with these routes' typed params
// widens req.params.* to string|string[] under @types/express 5's
// repeated-param typing; single ":id"/":stopId" segments are always strings.
tripsRouter.post("/:id/stops/:stopId/photos", upload.single("file"), asyncRoute(async (req, res) => {
  const tripId = req.params.id as string;
  const stopId = req.params.stopId as string;
  const trip = await prisma.trip.findFirst({ where: { id: tripId, driverId: req.auth!.driverId } });
  if (!trip) return res.status(404).json({ error: "Trip not found" });
  const stop = await prisma.stop.findFirst({ where: { id: stopId, tripId: trip.id } });
  if (!stop) return res.status(404).json({ error: "Stop not found" });
  if (!req.file) return res.status(400).json({ error: "file is required" });
  const url = `/uploads/${req.file.filename}`;
  await prisma.upload.create({ data: { stopId: stop.id, kind: "photo", url, mimeType: req.file.mimetype } });
  res.json({ url });
}));

tripsRouter.post("/:id/stops/:stopId/documents", upload.single("file"), asyncRoute(async (req, res) => {
  const tripId = req.params.id as string;
  const stopId = req.params.stopId as string;
  const trip = await prisma.trip.findFirst({ where: { id: tripId, driverId: req.auth!.driverId } });
  if (!trip) return res.status(404).json({ error: "Trip not found" });
  const stop = await prisma.stop.findFirst({ where: { id: stopId, tripId: trip.id } });
  if (!stop) return res.status(404).json({ error: "Stop not found" });
  if (!req.file) return res.status(400).json({ error: "file is required" });
  const url = `/uploads/${req.file.filename}`;
  await prisma.upload.create({ data: { stopId: stop.id, kind: "document", url, mimeType: req.file.mimetype } });
  res.json({ url });
}));

tripsRouter.get("/:id/can-proceed", asyncRoute(async (req, res) => {
  const trip = await prisma.trip.findFirst({ where: { id: req.params.id as string, driverId: req.auth!.driverId } });
  if (!trip) return res.status(404).json({ error: "Trip not found" });
  const seq = Number(req.query.currentStopSequence);
  if (!Number.isFinite(seq)) return res.status(400).json({ error: "currentStopSequence is required" });
  const stop = await prisma.stop.findFirst({ where: { tripId: trip.id, sequence: seq } });
  if (!stop) return res.json({ canProceed: true, reason: null });
  const validationType = typeof req.query.validationType === "string" ? req.query.validationType : undefined;
  const requirementWhere = validationType
    ? { stopId: stop.id, required: true, validationType }
    : { stopId: stop.id, required: true };
  const requiredCount = await prisma.signsProofRequirement.count({ where: requirementWhere });
  const providedCount = await prisma.signsProof.count({ where: { stopId: stop.id } });
  if (providedCount < requiredCount) return res.json({ canProceed: false, reason: "required signs-proof is missing" });
  res.json({ canProceed: true, reason: null });
}));

tripsRouter.post("/:id/complete", asyncRoute(async (req, res) => {
  const trip = await prisma.trip.findFirst({ where: { id: req.params.id as string, driverId: req.auth!.driverId } });
  if (!trip) return res.status(404).json({ error: "Trip not found" });
  const stops = await prisma.stop.findMany({ where: { tripId: trip.id } });
  const guard = canCompleteTrip(trip, stops);
  if (!guard.ok) return res.status(409).json({ error: guard.reason });
  const updated = await prisma.trip.update({
    where: { id: trip.id }, data: { status: "completed", completedAt: new Date() } });
  res.json(updated);
}));
