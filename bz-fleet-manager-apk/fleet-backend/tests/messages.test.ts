import request from "supertest";
import { prisma } from "../src/db.js";
import { app, resetDb, createDriver } from "./helpers.js";
import { signAccess } from "../src/lib/tokens.js";
beforeEach(resetDb);

it("creates a message and it appears in the thread", async () => {
  const d = await createDriver();
  const createRes = await request(app).post("/api/driver/messages")
    .set("authorization", `Bearer ${signAccess(d.id)}`)
    .send({ text: "hello dispatch" });
  expect(createRes.status).toBe(200);
  expect(createRes.body.text).toBe("hello dispatch");
  expect(createRes.body.senderType).toBe("driver");
  const conversationId = createRes.body.conversationId;

  const threadRes = await request(app).get(`/api/driver/messages?conversation=${conversationId}`)
    .set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(threadRes.status).toBe(200);
  expect(threadRes.body).toHaveLength(1);
  expect(threadRes.body[0].text).toBe("hello dispatch");
});

it("reuses the same conversation for the same tripId", async () => {
  const d = await createDriver();
  const trip = await prisma.trip.create({ data: { identifier: "TR-MSG-1", status: "in_progress", driverId: d.id } });
  const first = await request(app).post("/api/driver/messages")
    .set("authorization", `Bearer ${signAccess(d.id)}`)
    .send({ text: "first", tripId: trip.id });
  const second = await request(app).post("/api/driver/messages")
    .set("authorization", `Bearer ${signAccess(d.id)}`)
    .send({ text: "second", tripId: trip.id });
  expect(first.body.conversationId).toBe(second.body.conversationId);
});

it("uploads an attachment message on the trip's conversation", async () => {
  const d = await createDriver();
  const trip = await prisma.trip.create({ data: { identifier: "TR-MSG-2", status: "in_progress", driverId: d.id } });
  const res = await request(app).post(`/api/trips/${trip.id}/messages`)
    .set("authorization", `Bearer ${signAccess(d.id)}`)
    .field("text", "see attached")
    .attach("file", Buffer.from("x"), "photo.jpg");
  expect(res.status).toBe(200);
  expect(res.body.attachmentUrl).toMatch(/^\/uploads\//);
  expect(res.body.text).toBe("see attached");

  const conversation = await prisma.conversation.findFirst({ where: { driverId: d.id, tripId: trip.id } });
  expect(conversation).toBeTruthy();
  const messages = await prisma.message.findMany({ where: { conversationId: conversation!.id } });
  expect(messages).toHaveLength(1);
});

it("returns 404 attaching a message to another driver's trip", async () => {
  const me = await createDriver({ email: "me@f.com" });
  const other = await createDriver({ email: "other@f.com" });
  const trip = await prisma.trip.create({ data: { identifier: "TR-MSG-OTHER", status: "in_progress", driverId: other.id } });
  const res = await request(app).post(`/api/trips/${trip.id}/messages`)
    .set("authorization", `Bearer ${signAccess(me.id)}`)
    .attach("file", Buffer.from("x"), "photo.jpg");
  expect(res.status).toBe(404);
});

async function conversationWithUnread(driverId: string, tripId: string | null = null, unreadCount = 1) {
  const conversation = await prisma.conversation.create({ data: { driverId, tripId } });
  for (let i = 0; i < unreadCount; i++) {
    await prisma.message.create({ data: { conversationId: conversation.id, senderType: "dispatcher", text: `msg ${i}` } });
  }
  return conversation;
}

it("unread-messages-count reflects unread dispatcher messages", async () => {
  const d = await createDriver();
  await conversationWithUnread(d.id, null, 2);
  const res = await request(app).get("/api/driver/unread-messages-count")
    .set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(200);
  expect(res.body.count).toBe(2);
});

it("unread-summary lists per-conversation unread counts and a total", async () => {
  const d = await createDriver();
  const c1 = await conversationWithUnread(d.id, null, 2);
  const c2 = await conversationWithUnread(d.id, null, 1);
  const res = await request(app).get("/api/driver/messages/unread-summary")
    .set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(200);
  expect(res.body.total).toBe(3);
  const byId = Object.fromEntries(res.body.conversations.map((c: { conversationId: string; unread: number }) => [c.conversationId, c.unread]));
  expect(byId[c1.id]).toBe(2);
  expect(byId[c2.id]).toBe(1);
});

it("read-all zeroes the unread count", async () => {
  const d = await createDriver();
  await conversationWithUnread(d.id, null, 3);
  const before = await request(app).get("/api/driver/unread-messages-count").set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(before.body.count).toBe(3);
  const readAll = await request(app).post("/api/driver/messages/read-all").set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(readAll.status).toBe(200);
  const after = await request(app).get("/api/driver/unread-messages-count").set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(after.body.count).toBe(0);
});

it("marks a trip's conversation read via PUT trips/:id/messages/read-all", async () => {
  const d = await createDriver();
  const trip = await prisma.trip.create({ data: { identifier: "TR-MSG-3", status: "in_progress", driverId: d.id } });
  await conversationWithUnread(d.id, trip.id, 2);
  const res = await request(app).put(`/api/trips/${trip.id}/messages/read-all`)
    .set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(200);
  const after = await request(app).get("/api/driver/unread-messages-count").set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(after.body.count).toBe(0);
});

it("marks a single message read via PUT /api/messages/:id/read", async () => {
  const d = await createDriver();
  const conversation = await conversationWithUnread(d.id, null, 2);
  const [msg1] = await prisma.message.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" } });
  const res = await request(app).put(`/api/messages/${msg1.id}/read`).set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(200);
  expect(res.body.readAt).toBeTruthy();
  const after = await request(app).get("/api/driver/unread-messages-count").set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(after.body.count).toBe(1);
});

it("returns 404 marking another driver's message read", async () => {
  const me = await createDriver({ email: "me@f.com" });
  const other = await createDriver({ email: "other@f.com" });
  const conversation = await conversationWithUnread(other.id, null, 1);
  const [msg] = await prisma.message.findMany({ where: { conversationId: conversation.id } });
  const res = await request(app).put(`/api/messages/${msg.id}/read`).set("authorization", `Bearer ${signAccess(me.id)}`);
  expect(res.status).toBe(404);
});

it("returns 404 reading another driver's conversation thread", async () => {
  const me = await createDriver({ email: "me@f.com" });
  const other = await createDriver({ email: "other@f.com" });
  const conversation = await conversationWithUnread(other.id, null, 1);
  const res = await request(app).get(`/api/driver/messages?conversation=${conversation.id}`)
    .set("authorization", `Bearer ${signAccess(me.id)}`);
  expect(res.status).toBe(404);
});
