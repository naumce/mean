import request from "supertest";
import { prisma } from "../src/db.js";
import { app, resetDb, createDriver } from "./helpers.js";
import { signAccess } from "../src/lib/tokens.js";
beforeEach(resetDb);

async function tripWithItems(driverId: string, ident = "TR-CL-1") {
  const trip = await prisma.trip.create({ data: { identifier: ident, status: "assigned", driverId } });
  await prisma.checklistItem.createMany({
    data: [
      { tripId: trip.id, label: "Check tires" },
      { tripId: trip.id, label: "Check lights" },
    ],
  });
  return trip;
}

it("returns the checklist items for the driver's trip", async () => {
  const d = await createDriver();
  const trip = await tripWithItems(d.id);
  const res = await request(app).get(`/api/trips/${trip.id}/checklist`)
    .set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(2);
  expect(res.body.map((i: { label: string }) => i.label)).toEqual(["Check tires", "Check lights"]);
});

it("completing the checklist flips preTripCheckCompleted and marks items complete", async () => {
  const d = await createDriver();
  const trip = await tripWithItems(d.id);
  const res = await request(app).post(`/api/trips/${trip.id}/checklist/complete`)
    .set("authorization", `Bearer ${signAccess(d.id)}`).send({});
  expect(res.status).toBe(200);
  expect(res.body.preTripCheckCompleted).toBe(true);

  const items = await prisma.checklistItem.findMany({ where: { tripId: trip.id } });
  expect(items.every((i) => i.completed)).toBe(true);
});

it("accepts an optional loadId/populate body", async () => {
  const d = await createDriver();
  const trip = await tripWithItems(d.id, "TR-CL-2");
  const res = await request(app).post(`/api/trips/${trip.id}/checklist/complete`)
    .set("authorization", `Bearer ${signAccess(d.id)}`).send({ loadId: "LOAD-1", populate: true });
  expect(res.status).toBe(200);
});

it("returns 404 for another driver's trip checklist", async () => {
  const me = await createDriver({ email: "me@f.com" });
  const other = await createDriver({ email: "other@f.com" });
  const trip = await tripWithItems(other.id, "TR-CL-OTHER");
  const res = await request(app).get(`/api/trips/${trip.id}/checklist`)
    .set("authorization", `Bearer ${signAccess(me.id)}`);
  expect(res.status).toBe(404);
});
