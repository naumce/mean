import request from "supertest";
import { prisma } from "../src/db.js";
import { app, resetDb, createDriver } from "./helpers.js";
import { signAccess } from "../src/lib/tokens.js";
beforeEach(resetDb);

async function tripFor(driverId: string, ident: string, status = "in_progress") {
  return prisma.trip.create({ data: { identifier: ident, status, driverId } });
}

it("returns the caller's current trip", async () => {
  const d = await createDriver();
  await tripFor(d.id, "TR-1");
  const res = await request(app).get("/api/driver/trip/current").set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.tripIdentifier).toBe("TR-1");
});

it("never returns another driver's trip", async () => {
  const me = await createDriver({ email: "me@f.com" });
  const other = await createDriver({ email: "other@f.com" });
  await tripFor(other.id, "TR-OTHER");
  const res = await request(app).get("/api/driver/trips/active").set("authorization", `Bearer ${signAccess(me.id)}`);
  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(0);
});

it("never returns another driver's trip as the caller's current trip", async () => {
  const me = await createDriver({ email: "me2@f.com" });
  const other = await createDriver({ email: "other2@f.com" });
  await tripFor(other.id, "TR-OTHER-CURRENT");
  const res = await request(app).get("/api/driver/trip/current").set("authorization", `Bearer ${signAccess(me.id)}`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ success: false });
});
