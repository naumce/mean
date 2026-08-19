import request from "supertest";
import { prisma } from "../src/db.js";
import { app, resetDb, createDriver } from "./helpers.js";
import { signAccess } from "../src/lib/tokens.js";
beforeEach(resetDb);

it("starts an assigned, checklist-complete trip", async () => {
  const d = await createDriver();
  const t = await prisma.trip.create({ data: { identifier: "TR-1", status: "assigned",
    preTripCheckCompleted: true, driverId: d.id } });
  const res = await request(app).post(`/api/trips/${t.id}/start`).set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("in_progress");
  expect(res.body.startedAt).toBeTruthy();
});

it("returns 409 when the checklist is incomplete", async () => {
  const d = await createDriver();
  const t = await prisma.trip.create({ data: { identifier: "TR-2", status: "assigned",
    preTripCheckCompleted: false, driverId: d.id } });
  const res = await request(app).post(`/api/trips/${t.id}/start`).set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(409);
});

it("returns 404 when starting another driver's trip", async () => {
  const me = await createDriver({ email: "me@f.com" });
  const other = await createDriver({ email: "o@f.com" });
  const t = await prisma.trip.create({ data: { identifier: "TR-3", status: "assigned",
    preTripCheckCompleted: true, driverId: other.id } });
  const res = await request(app).post(`/api/trips/${t.id}/start`).set("authorization", `Bearer ${signAccess(me.id)}`);
  expect(res.status).toBe(404);
});
