import request from "supertest";
import { prisma } from "../src/db.js";
import { app, resetDb, createDriver } from "./helpers.js";
import { signAccess } from "../src/lib/tokens.js";
beforeEach(resetDb);

async function runningTripWithStops(driverId: string, ident = "TR-ST-1") {
  const trip = await prisma.trip.create({ data: { identifier: ident, status: "in_progress", driverId } });
  const stop1 = await prisma.stop.create({ data: { tripId: trip.id, sequence: 1, address: "A" } });
  const stop2 = await prisma.stop.create({ data: { tripId: trip.id, sequence: 2, address: "B" } });
  return { trip, stop1, stop2 };
}

it("arrives at the first stop of a running trip", async () => {
  const d = await createDriver();
  const { trip, stop1 } = await runningTripWithStops(d.id);
  const res = await request(app).post(`/api/trips/${trip.id}/stops/${stop1.id}/arrive`)
    .set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("arrived");
  expect(res.body.arrivedAt).toBeTruthy();
});

it("blocks arriving at stop #2 before stop #1 is completed (sequential unlock)", async () => {
  const d = await createDriver();
  const { trip, stop2 } = await runningTripWithStops(d.id);
  const res = await request(app).post(`/api/trips/${trip.id}/stops/${stop2.id}/arrive`)
    .set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(409);
});

it("completes a stop with no required signs-proof after arrival", async () => {
  const d = await createDriver();
  const { trip, stop1 } = await runningTripWithStops(d.id);
  await request(app).post(`/api/trips/${trip.id}/stops/${stop1.id}/arrive`)
    .set("authorization", `Bearer ${signAccess(d.id)}`);
  const res = await request(app).post(`/api/trips/${trip.id}/stops/${stop1.id}/complete`)
    .set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("completed");
  expect(res.body.completedAt).toBeTruthy();
});

it("blocks completing a stop with an unmet required signs-proof", async () => {
  const d = await createDriver();
  const { trip, stop1 } = await runningTripWithStops(d.id);
  await prisma.signsProofRequirement.create({
    data: { stopId: stop1.id, proofType: "signature", required: true },
  });
  await request(app).post(`/api/trips/${trip.id}/stops/${stop1.id}/arrive`)
    .set("authorization", `Bearer ${signAccess(d.id)}`);
  const res = await request(app).post(`/api/trips/${trip.id}/stops/${stop1.id}/complete`)
    .set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(409);
});

it("allows completing a stop once its required signs-proof is present", async () => {
  const d = await createDriver();
  const { trip, stop1 } = await runningTripWithStops(d.id);
  await prisma.signsProofRequirement.create({
    data: { stopId: stop1.id, proofType: "signature", required: true },
  });
  await request(app).post(`/api/trips/${trip.id}/stops/${stop1.id}/arrive`)
    .set("authorization", `Bearer ${signAccess(d.id)}`);
  await prisma.signsProof.create({
    data: { stopId: stop1.id, proofType: "signature", fileUrl: "/uploads/sig.png" },
  });
  const res = await request(app).post(`/api/trips/${trip.id}/stops/${stop1.id}/complete`)
    .set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(200);
});

it("blocks completing a stop that has not been arrived", async () => {
  const d = await createDriver();
  const { trip, stop1 } = await runningTripWithStops(d.id);
  const res = await request(app).post(`/api/trips/${trip.id}/stops/${stop1.id}/complete`)
    .set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(409);
});

it("returns 404 arriving at a stop on another driver's trip", async () => {
  const me = await createDriver({ email: "me@f.com" });
  const other = await createDriver({ email: "other@f.com" });
  const { stop1, trip } = await runningTripWithStops(other.id, "TR-ST-OTHER");
  const res = await request(app).post(`/api/trips/${trip.id}/stops/${stop1.id}/arrive`)
    .set("authorization", `Bearer ${signAccess(me.id)}`);
  expect(res.status).toBe(404);
});

it("returns 404 for a stop that does not belong to the given trip", async () => {
  const d = await createDriver();
  const { trip: trip1 } = await runningTripWithStops(d.id, "TR-ST-A");
  const { stop1: foreignStop } = await runningTripWithStops(d.id, "TR-ST-B");
  const res = await request(app).post(`/api/trips/${trip1.id}/stops/${foreignStop.id}/arrive`)
    .set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(404);
});
