import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { upload } from "../lib/upload.js";
import { asyncRoute } from "../lib/asyncRoute.js";

// Mounted at "/api" in app.ts — the client's paths don't share a common
// prefix (`/driver/messages...` vs `/trips/:id/messages...` vs
// `/messages/:id/read`), so all of them live in this one router rather than
// splitting the mount (same reasoning as signsProofRouter).
export const messagesRouter = Router();
messagesRouter.use(requireAuth);

// Any message this API creates is from the driver; unread only counts
// messages the driver didn't author (the dispatcher side arrives in BE-4).
const unreadWhere = { senderType: { not: "driver" }, readAt: null } as const;

async function findOrCreateConversation(driverId: string, tripId: string | null) {
  const existing = await prisma.conversation.findFirst({ where: { driverId, tripId } });
  if (existing) return existing;
  return prisma.conversation.create({ data: { driverId, tripId } });
}

messagesRouter.get("/driver/messages", asyncRoute(async (req, res) => {
  const conversationId = typeof req.query.conversation === "string" ? req.query.conversation : undefined;
  if (!conversationId) return res.status(400).json({ error: "conversation is required" });
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, driverId: req.auth!.driverId } });
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });
  const messages = await prisma.message.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" } });
  res.json(messages);
}));

const createMessageSchema = z.object({
  conversationId: z.string().optional(),
  tripId: z.string().optional(),
  text: z.string().min(1),
});

messagesRouter.post("/driver/messages", validateBody(createMessageSchema), asyncRoute(async (req, res) => {
  const { conversationId, tripId, text } = req.body as z.infer<typeof createMessageSchema>;
  let conversation;
  if (conversationId) {
    conversation = await prisma.conversation.findFirst({ where: { id: conversationId, driverId: req.auth!.driverId } });
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });
  } else {
    conversation = await findOrCreateConversation(req.auth!.driverId, tripId ?? null);
  }
  const created = await prisma.message.create({
    data: { conversationId: conversation.id, senderType: "driver", text },
  });
  res.json(created);
}));

const tripMessageSchema = z.object({ text: z.string().optional() });

// combining multer's generic RequestHandler with this route's typed params
// widens req.params.id to string|string[] under @types/express 5's
// repeated-param typing; a single ":id" segment is always a plain string.
messagesRouter.post(
  "/trips/:id/messages",
  upload.single("file"),
  validateBody(tripMessageSchema),
  asyncRoute(async (req, res) => {
    const tripId = req.params.id as string;
    const trip = await prisma.trip.findFirst({ where: { id: tripId, driverId: req.auth!.driverId } });
    if (!trip) return res.status(404).json({ error: "Trip not found" });
    if (!req.file) return res.status(400).json({ error: "file is required" });
    const { text } = req.body as z.infer<typeof tripMessageSchema>;
    const conversation = await findOrCreateConversation(req.auth!.driverId, trip.id);
    const attachmentUrl = `/uploads/${req.file.filename}`;
    const created = await prisma.message.create({
      data: { conversationId: conversation.id, senderType: "driver", text: text ?? null, attachmentUrl },
    });
    res.json(created);
  }),
);

messagesRouter.get("/driver/messages/unread-summary", asyncRoute(async (req, res) => {
  const conversations = await prisma.conversation.findMany({ where: { driverId: req.auth!.driverId } });
  const summaries = await Promise.all(conversations.map(async (c) => ({
    conversationId: c.id,
    unread: await prisma.message.count({ where: { conversationId: c.id, ...unreadWhere } }),
  })));
  const total = summaries.reduce((sum, s) => sum + s.unread, 0);
  res.json({ conversations: summaries, total });
}));

messagesRouter.get("/driver/unread-messages-count", asyncRoute(async (req, res) => {
  const count = await prisma.message.count({ where: { conversation: { driverId: req.auth!.driverId }, ...unreadWhere } });
  res.json({ count });
}));

messagesRouter.post("/driver/messages/read-all", asyncRoute(async (req, res) => {
  const result = await prisma.message.updateMany({
    where: { conversation: { driverId: req.auth!.driverId }, ...unreadWhere },
    data: { readAt: new Date() },
  });
  res.json({ updated: result.count });
}));

messagesRouter.put("/trips/:id/messages/read-all", asyncRoute(async (req, res) => {
  const tripId = req.params.id as string;
  const trip = await prisma.trip.findFirst({ where: { id: tripId, driverId: req.auth!.driverId } });
  if (!trip) return res.status(404).json({ error: "Trip not found" });
  const conversation = await prisma.conversation.findFirst({ where: { driverId: req.auth!.driverId, tripId: trip.id } });
  if (!conversation) return res.json({ updated: 0 });
  const result = await prisma.message.updateMany({
    where: { conversationId: conversation.id, ...unreadWhere },
    data: { readAt: new Date() },
  });
  res.json({ updated: result.count });
}));

messagesRouter.put("/messages/:id/read", asyncRoute(async (req, res) => {
  const id = req.params.id as string;
  // ownership by construction via the relation: the message must belong to a
  // conversation owned by the calling driver.
  const message = await prisma.message.findFirst({ where: { id, conversation: { driverId: req.auth!.driverId } } });
  if (!message) return res.status(404).json({ error: "Message not found" });
  const updated = await prisma.message.update({ where: { id: message.id }, data: { readAt: new Date() } });
  res.json(updated);
}));
