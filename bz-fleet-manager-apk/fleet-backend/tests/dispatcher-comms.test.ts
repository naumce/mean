import request from "supertest";
import { prisma } from "../src/db.js";
import { app, resetDb, createDriver, createDispatcher } from "./helpers.js";
import { signAccess, signDispatcherAccess } from "../src/lib/tokens.js";
beforeEach(resetDb);

async function dispatcherAuth() {
  const disp = await createDispatcher();
  return `Bearer ${signDispatcherAccess(disp.id)}`;
}

describe("role guard", () => {
  it("rejects a driver token on dispatcher comms routes with 403", async () => {
    const d = await createDriver();
    const res = await request(app).get("/api/dispatcher/conversations")
      .set("authorization", `Bearer ${signAccess(d.id)}`);
    expect(res.status).toBe(403);
  });

  it("rejects a missing token on dispatcher comms routes with 401", async () => {
    const res = await request(app).get("/api/dispatcher/conversations");
    expect(res.status).toBe(401);
  });
});

describe("get-or-create conversation", () => {
  it("returns the same conversation id on a second call", async () => {
    const auth = await dispatcherAuth();
    const d = await createDriver();
    const first = await request(app).post(`/api/dispatcher/drivers/${d.id}/conversations`).set("authorization", auth).send({});
    const second = await request(app).post(`/api/dispatcher/drivers/${d.id}/conversations`).set("authorization", auth).send({});
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it("returns 404 for an unknown driver", async () => {
    const auth = await dispatcherAuth();
    const res = await request(app).post("/api/dispatcher/drivers/does-not-exist/conversations").set("authorization", auth).send({});
    expect(res.status).toBe(404);
  });

  it("creates a separate conversation per tripId", async () => {
    const auth = await dispatcherAuth();
    const d = await createDriver();
    const trip = await prisma.trip.create({ data: { identifier: "TR-DC-1", status: "in_progress", driverId: d.id } });
    const withoutTrip = await request(app).post(`/api/dispatcher/drivers/${d.id}/conversations`).set("authorization", auth).send({});
    const withTrip = await request(app).post(`/api/dispatcher/drivers/${d.id}/conversations`).set("authorization", auth).send({ tripId: trip.id });
    expect(withoutTrip.body.id).not.toBe(withTrip.body.id);
  });
});

describe("dispatcher sends a message", () => {
  it("creates a dispatcher message that appears in the driver's thread", async () => {
    const auth = await dispatcherAuth();
    const d = await createDriver();
    const convRes = await request(app).post(`/api/dispatcher/drivers/${d.id}/conversations`).set("authorization", auth).send({});
    const conversationId = convRes.body.id as string;

    const sendRes = await request(app).post(`/api/dispatcher/conversations/${conversationId}/messages`)
      .set("authorization", auth).send({ text: "hi from dispatch" });
    expect(sendRes.status).toBe(200);
    expect(sendRes.body.senderType).toBe("dispatcher");
    expect(sendRes.body.text).toBe("hi from dispatch");

    const threadRes = await request(app).get(`/api/driver/messages?conversation=${conversationId}`)
      .set("authorization", `Bearer ${signAccess(d.id)}`);
    expect(threadRes.status).toBe(200);
    expect(threadRes.body).toHaveLength(1);
    expect(threadRes.body[0].senderType).toBe("dispatcher");
    expect(threadRes.body[0].text).toBe("hi from dispatch");
  });

  it("returns 404 sending to an unknown conversation", async () => {
    const auth = await dispatcherAuth();
    const res = await request(app).post("/api/dispatcher/conversations/does-not-exist/messages")
      .set("authorization", auth).send({ text: "hi" });
    expect(res.status).toBe(404);
  });

  it("returns the thread ordered oldest-first via the dispatcher thread endpoint", async () => {
    const auth = await dispatcherAuth();
    const d = await createDriver();
    const convRes = await request(app).post(`/api/dispatcher/drivers/${d.id}/conversations`).set("authorization", auth).send({});
    const conversationId = convRes.body.id as string;
    await request(app).post(`/api/dispatcher/conversations/${conversationId}/messages`).set("authorization", auth).send({ text: "first" });
    await request(app).post(`/api/dispatcher/conversations/${conversationId}/messages`).set("authorization", auth).send({ text: "second" });

    const threadRes = await request(app).get(`/api/dispatcher/conversations/${conversationId}/messages`).set("authorization", auth);
    expect(threadRes.status).toBe(200);
    expect(threadRes.body.map((m: { text: string }) => m.text)).toEqual(["first", "second"]);
  });

  it("returns 404 reading an unknown conversation's thread", async () => {
    const auth = await dispatcherAuth();
    const res = await request(app).get("/api/dispatcher/conversations/does-not-exist/messages").set("authorization", auth);
    expect(res.status).toBe(404);
  });
});

describe("conversations list", () => {
  it("shows unread counts from driver-sent unread messages only", async () => {
    const auth = await dispatcherAuth();
    const d = await createDriver({ email: "list1@fleet.com", name: "Lister One" });
    const conversation = await prisma.conversation.create({ data: { driverId: d.id } });
    await prisma.message.create({ data: { conversationId: conversation.id, senderType: "driver", text: "unread 1" } });
    await prisma.message.create({ data: { conversationId: conversation.id, senderType: "driver", text: "unread 2" } });
    // a dispatcher message on the same conversation must not count as unread
    await prisma.message.create({ data: { conversationId: conversation.id, senderType: "dispatcher", text: "reply" } });

    const res = await request(app).get("/api/dispatcher/conversations").set("authorization", auth);
    expect(res.status).toBe(200);
    const row = res.body.find((c: { id: string }) => c.id === conversation.id);
    expect(row).toBeTruthy();
    expect(row.driverId).toBe(d.id);
    expect(row.driverName).toBe("Lister One");
    expect(row.unread).toBe(2);
  });
});

describe("notify", () => {
  it("creates a Notification the driver sees via GET /driver/notifications", async () => {
    const auth = await dispatcherAuth();
    const d = await createDriver();
    const res = await request(app).post(`/api/dispatcher/drivers/${d.id}/notify`)
      .set("authorization", auth).send({ type: "custom", title: "Heads up", body: "check your route" });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe("custom");

    const listRes = await request(app).get("/api/driver/notifications").set("authorization", `Bearer ${signAccess(d.id)}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].title).toBe("Heads up");
    expect(listRes.body[0].body).toBe("check your route");
  });

  it("returns 404 notifying an unknown driver", async () => {
    const auth = await dispatcherAuth();
    const res = await request(app).post("/api/dispatcher/drivers/does-not-exist/notify")
      .set("authorization", auth).send({ type: "custom" });
    expect(res.status).toBe(404);
  });

  it("returns 400 for a missing type", async () => {
    const auth = await dispatcherAuth();
    const d = await createDriver();
    const res = await request(app).post(`/api/dispatcher/drivers/${d.id}/notify`).set("authorization", auth).send({});
    expect(res.status).toBe(400);
  });
});
