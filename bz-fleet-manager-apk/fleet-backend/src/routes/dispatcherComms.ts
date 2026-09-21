import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { validateBody } from "../middleware/validate.js";
import { orgWhere, outsideCallerOrg } from "../middleware/orgScope.js";
import { emitToDriver } from "../realtime.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Dispatcher-side messaging + notify. Mounted (without its own prefix) at
// /api/dispatcher behind requireAuth + requireDispatcher + attachOrgScope —
// see app.ts. Reuses the Conversation/Message/Notification models the driver
// side already reads (messages.ts / notifications.ts); no schema change.
//
// Tenancy: the dispatcher role is fleet-wide WITHIN one org, never across
// orgs. Conversation/Message carry no orgId and no Driver relation in the
// schema, so their tenant is resolved through Conversation.driverId ->
// Driver.orgId — the same two-step the /locations read uses. A conversation,
// thread or driver outside the caller's org reads as 404 (never 403 — a 403
// confirms the row exists). A legacy null-org dispatcher keeps the documented
// see-everything bypass via orgWhere()/outsideCallerOrg().
export const dispatcherCommsRouter = Router();

// Mirrors messages.ts's findOrCreateConversation, kept local rather than
// shared: that one is driver-scoped (filters by the calling driver's id from
// the token), this one takes an arbitrary driverId from the URL — which is
// exactly why every caller below must tenant-check that driver first.
async function findOrCreateConversation(driverId: string, tripId: string | null) {
  const existing = await prisma.conversation.findFirst({ where: { driverId, tripId } });
  if (existing) return existing;
  return prisma.conversation.create({ data: { driverId, tripId } });
}

/** Prisma where-fragment selecting the conversations this caller may see.
 *  Conversation has no Driver relation to traverse, so the tenant's driver ids
 *  are resolved first and matched on the scalar column. */
async function conversationScope(req: { orgScope?: string | null }): Promise<Prisma.ConversationWhereInput> {
  if (req.orgScope == null) return {};
  const drivers = await prisma.driver.findMany({ where: orgWhere(req), select: { id: true } });
  return { driverId: { in: drivers.map((d) => d.id) } };
}

/** Loads a conversation the caller is allowed to touch, else null (-> 404).
 *  A conversation whose driver row is missing counts as outside the tenant for
 *  a scoped caller, the same way an orgless driver does. */
async function scopedConversation(req: { orgScope?: string | null }, id: string) {
  const conversation = await prisma.conversation.findUnique({ where: { id } });
  if (!conversation) return null;
  const driver = await prisma.driver.findUnique({
    where: { id: conversation.driverId }, select: { orgId: true },
  });
  if (outsideCallerOrg(req, driver?.orgId ?? null)) return null;
  return conversation;
}

dispatcherCommsRouter.get("/conversations", asyncRoute(async (req, res) => {
  const conversations = await prisma.conversation.findMany({
    where: await conversationScope(req), orderBy: { createdAt: "desc" },
  });
  const driverIds = [...new Set(conversations.map((c) => c.driverId))];
  const drivers = await prisma.driver.findMany({ where: { id: { in: driverIds } } });
  const driverNameById = new Map(drivers.map((d) => [d.id, d.name]));

  const rows = await Promise.all(conversations.map(async (c) => {
    const lastMessage = await prisma.message.findFirst({
      where: { conversationId: c.id }, orderBy: { createdAt: "desc" } });
    const unread = await prisma.message.count({
      where: { conversationId: c.id, senderType: "driver", readAt: null } });
    return {
      id: c.id, driverId: c.driverId, driverName: driverNameById.get(c.driverId) ?? null,
      tripId: c.tripId, lastMessage, unread,
    };
  }));
  res.json(rows);
}));

dispatcherCommsRouter.get("/conversations/:id/messages", asyncRoute(async (req, res) => {
  const conversation = await scopedConversation(req, req.params.id as string);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });
  const messages = await prisma.message.findMany({
    where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" } });
  res.json(messages);
}));

const sendMessageSchema = z.object({ text: z.string().min(1) });

dispatcherCommsRouter.post("/conversations/:id/messages", validateBody(sendMessageSchema), asyncRoute(async (req, res) => {
  const conversation = await scopedConversation(req, req.params.id as string);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });
  const { text } = req.body as z.infer<typeof sendMessageSchema>;
  const created = await prisma.message.create({
    data: { conversationId: conversation.id, senderType: "dispatcher", text } });
  emitToDriver(conversation.driverId, "general_notification", { conversationId: conversation.id });
  res.json(created);
}));

const getOrCreateConversationSchema = z.object({ tripId: z.string().optional() });

dispatcherCommsRouter.post(
  "/drivers/:id/conversations",
  validateBody(getOrCreateConversationSchema),
  asyncRoute(async (req, res) => {
    const driverId = req.params.id as string;
    const driver = await prisma.driver.findUnique({ where: { id: driverId }, select: { orgId: true } });
    if (!driver || outsideCallerOrg(req, driver.orgId)) return res.status(404).json({ error: "Driver not found" });
    const { tripId } = req.body as z.infer<typeof getOrCreateConversationSchema>;
    const conversation = await findOrCreateConversation(driverId, tripId ?? null);
    res.json(conversation);
  }),
);

const notifySchema = z.object({
  type: z.string().min(1), title: z.string().optional(), body: z.string().optional(),
});

dispatcherCommsRouter.post("/drivers/:id/notify", validateBody(notifySchema), asyncRoute(async (req, res) => {
  const driverId = req.params.id as string;
  const driver = await prisma.driver.findUnique({ where: { id: driverId }, select: { orgId: true } });
  if (!driver || outsideCallerOrg(req, driver.orgId)) return res.status(404).json({ error: "Driver not found" });
  const { type, title, body } = req.body as z.infer<typeof notifySchema>;
  const created = await prisma.notification.create({ data: { driverId, type, title, body } });
  // Closes the BE-5 gap: general_notification previously had no trigger.
  emitToDriver(driverId, "general_notification", { notificationId: created.id });
  res.json(created);
}));
