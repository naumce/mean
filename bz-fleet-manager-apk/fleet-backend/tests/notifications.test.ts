import request from "supertest";
import { prisma } from "../src/db.js";
import { app, resetDb, createDriver } from "./helpers.js";
import { signAccess } from "../src/lib/tokens.js";
beforeEach(resetDb);

it("lists the driver's notifications", async () => {
  const d = await createDriver();
  await prisma.notification.create({ data: { driverId: d.id, type: "trip_assignment", title: "New trip" } });
  const res = await request(app).get("/api/driver/notifications").set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(1);
  expect(res.body[0].type).toBe("trip_assignment");
});

it("never lists another driver's notifications", async () => {
  const me = await createDriver({ email: "me@f.com" });
  const other = await createDriver({ email: "other@f.com" });
  await prisma.notification.create({ data: { driverId: other.id, type: "trip_assignment" } });
  const res = await request(app).get("/api/driver/notifications").set("authorization", `Bearer ${signAccess(me.id)}`);
  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(0);
});

it("read-all marks every notification read", async () => {
  const d = await createDriver();
  await prisma.notification.create({ data: { driverId: d.id, type: "a" } });
  await prisma.notification.create({ data: { driverId: d.id, type: "b" } });
  const res = await request(app).post("/api/driver/notifications/read-all").set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(200);
  const remaining = await prisma.notification.count({ where: { driverId: d.id, readAt: null } });
  expect(remaining).toBe(0);
});

it("marks a single notification read", async () => {
  const d = await createDriver();
  const n = await prisma.notification.create({ data: { driverId: d.id, type: "a" } });
  const res = await request(app).put(`/api/notifications/${n.id}/read`).set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(200);
  expect(res.body.readAt).toBeTruthy();
});

it("returns 404 marking another driver's notification read", async () => {
  const me = await createDriver({ email: "me@f.com" });
  const other = await createDriver({ email: "other@f.com" });
  const n = await prisma.notification.create({ data: { driverId: other.id, type: "a" } });
  const res = await request(app).put(`/api/notifications/${n.id}/read`).set("authorization", `Bearer ${signAccess(me.id)}`);
  expect(res.status).toBe(404);
});

it("returns default notification preferences", async () => {
  const d = await createDriver();
  const res = await request(app).get("/api/driver/notification-preferences").set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(200);
  expect(typeof res.body).toBe("object");
});
