import request from "supertest";
import { prisma } from "../src/db.js";
import { app, resetDb, createDriver } from "./helpers.js";
import { signAccess } from "../src/lib/tokens.js";
beforeEach(resetDb);

async function runningTripWithStops(driverId: string, ident: string, statuses: string[]) {
  const trip = await prisma.trip.create({ data: { identifier: ident, status: "in_progress", driverId } });
  for (let i = 0; i < statuses.length; i++) {
    await prisma.stop.create({ data: { tripId: trip.id, sequence: i + 1, address: `Stop ${i + 1}`, status: statuses[i] } });
  }
  return trip;
}

it("returns 409 while a stop is still open", async () => {
  const d = await createDriver();
  const trip = await runningTripWithStops(d.id, "TR-CMP-1", ["completed", "arrived"]);
  const res = await request(app).post(`/api/trips/${trip.id}/complete`)
    .set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(409);
});

it("returns 200 and completes the trip when all stops are completed", async () => {
  const d = await createDriver();
  const trip = await runningTripWithStops(d.id, "TR-CMP-2", ["completed", "completed"]);
  const res = await request(app).post(`/api/trips/${trip.id}/complete`)
    .set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("completed");
  expect(res.body.completedAt).toBeTruthy();
});

it("returns 409 for a trip with no stops", async () => {
  const d = await createDriver();
  const trip = await prisma.trip.create({ data: { identifier: "TR-CMP-3", status: "in_progress", driverId: d.id } });
  const res = await request(app).post(`/api/trips/${trip.id}/complete`)
    .set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(409);
});

it("returns 404 completing another driver's trip", async () => {
  const me = await createDriver({ email: "me@f.com" });
  const other = await createDriver({ email: "other@f.com" });
  const trip = await runningTripWithStops(other.id, "TR-CMP-OTHER", ["completed"]);
  const res = await request(app).post(`/api/trips/${trip.id}/complete`)
    .set("authorization", `Bearer ${signAccess(me.id)}`);
  expect(res.status).toBe(404);
});
