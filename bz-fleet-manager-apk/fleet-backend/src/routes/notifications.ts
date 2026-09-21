import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Mounted at "/api" in app.ts — `/driver/notifications...` and
// `/notifications/:id/read` don't share a common prefix, so both live in
// this one router (same reasoning as signsProofRouter).
export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get("/driver/notifications", asyncRoute(async (req, res) => {
  const notifications = await prisma.notification.findMany({
    where: { driverId: req.auth!.driverId }, orderBy: { createdAt: "desc" } });
  res.json(notifications);
}));

notificationsRouter.post("/driver/notifications/read-all", asyncRoute(async (req, res) => {
  const result = await prisma.notification.updateMany({
    where: { driverId: req.auth!.driverId, readAt: null }, data: { readAt: new Date() } });
  res.json({ updated: result.count });
}));

notificationsRouter.put("/notifications/:id/read", asyncRoute(async (req, res) => {
  const id = req.params.id as string;
  const notification = await prisma.notification.findFirst({ where: { id, driverId: req.auth!.driverId } });
  if (!notification) return res.status(404).json({ error: "Notification not found" });
  const updated = await prisma.notification.update({ where: { id: notification.id }, data: { readAt: new Date() } });
  res.json(updated);
}));

// No NotificationPreference model exists yet; these are the client-facing
// defaults until preferences become persistable.
notificationsRouter.get("/driver/notification-preferences", asyncRoute(async (_req, res) => {
  res.json({
    tripUpdates: true,
    messages: true,
    routeAssignments: true,
    promotions: false,
    sound: true,
    vibration: true,
  });
}));
