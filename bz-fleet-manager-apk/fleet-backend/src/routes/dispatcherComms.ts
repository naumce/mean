import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { validateBody } from "../middleware/validate.js";

// Dispatcher-side messaging + notify. Mounted (without its own prefix) under
// dispatcherRouter, which already applies requireAuth + requireDispatcher —
// see dispatcherApprovals.ts. Reuses the Conversation/Message/Notification
// models the driver side already reads (messages.ts / notifications.ts); no
// schema change. Dispatcher role is fleet-wide, so these aren't
// driver-scoped, but the target driver/conversation must still exist (404).
export const dispatcherCommsRouter = Router();

// Mirrors messages.ts's findOrCreateConversation, kept local rather than
// shared: that one is driver-scoped (filters by the calling driver's id from
// the token), this one takes an arbitrary driverId from the URL.
async function findOrCreateConversation(driverId: string, tripId: string | null) {
  const existing = await prisma.conversation.findFirst({ where: { driverId, tripId } });
  if (existing) return existing;
  return prisma.conversation.create({ data: { driverId, tripId } });
}

dispatcherCommsRouter.get("/conversations", async (_req, res) => {
  const conversations = await prisma.conversation.findMany({ orderBy: { createdAt: "desc" } });
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
});

dispatcherCommsRouter.get("/conversations/:id/messages", async (req, res) => {
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id as string } });
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });
  const messages = await prisma.message.findMany({
    where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" } });
  res.json(messages);
});

const sendMessageSchema = z.object({ text: z.string().min(1) });

dispatcherCommsRouter.post("/conversations/:id/messages", validateBody(sendMessageSchema), async (req, res) => {
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id as string } });
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });
  const { text } = req.body as z.infer<typeof sendMessageSchema>;
  const created = await prisma.message.create({
    data: { conversationId: conversation.id, senderType: "dispatcher", text } });
  res.json(created);
});

const getOrCreateConversationSchema = z.object({ tripId: z.string().optional() });

dispatcherCommsRouter.post(
  "/drivers/:id/conversations",
  validateBody(getOrCreateConversationSchema),
  async (req, res) => {
    const driverId = req.params.id as string;
    const driver = await prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver) return res.status(404).json({ error: "Driver not found" });
    const { tripId } = req.body as z.infer<typeof getOrCreateConversationSchema>;
    const conversation = await findOrCreateConversation(driverId, tripId ?? null);
    res.json(conversation);
  },
);

const notifySchema = z.object({
  type: z.string().min(1), title: z.string().optional(), body: z.string().optional(),
});

dispatcherCommsRouter.post("/drivers/:id/notify", validateBody(notifySchema), async (req, res) => {
  const driverId = req.params.id as string;
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver) return res.status(404).json({ error: "Driver not found" });
  const { type, title, body } = req.body as z.infer<typeof notifySchema>;
  const created = await prisma.notification.create({ data: { driverId, type, title, body } });
  res.json(created);
});
