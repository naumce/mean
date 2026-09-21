import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";

// T2 Task 6: Trailer.lastLat/lastLng have existed since before this project
// and nothing has ever written them. This file covers the one write path that
// now does — assignment completion — and the read path that exposes it
// (dispatcher-loadboard.test.ts covers the wire shape on GET /loadboard).
beforeEach(resetDb);

async function dispatcherAuth(email = "d@x.com") {
  const disp = await prisma.dispatcher.create({ data: { email, passwordHash: "x", name: "D" } });
  return `Bearer ${signDispatcherAccess(disp.id)}`;
}

const KC = { lat: 39.0997, lng: -94.5786 };
const OMAHA = { lat: 41.2565, lng: -95.9345 };
const FAR = new Date("2027-01-01T00:00:00.000Z");

/** A committable load: pickup (KC) + delivery (Omaha), both geocoded unless
 *  `deliveryGeocoded: false`. The engine (mapper.ts toLoadInput) THROWS on an
 *  ungeocoded stop, so a load built with `deliveryGeocoded: false` can never
 *  be committed through POST /assignments — its Assignment fixture must be
 *  created directly, the same way dispatcher-loadboard.test.ts builds
 *  fixtures for routes that don't re-run the commit engine. */
async function seedLoad(opts: { deliveryGeocoded?: boolean } = {}) {
  const geocoded = opts.deliveryGeocoded ?? true;
  const org = await prisma.org.create({ data: { name: "Acme Fleet" } });
  const driver = await prisma.driver.create({
    data: {
      email: "drv@x.com", passwordHash: "x", name: "Jake", orgId: org.id,
      lastLat: KC.lat, lastLng: KC.lng,
      hos: { create: { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 } },
    },
  });
  const tractor = await prisma.tractor.create({ data: { orgId: org.id, unit: "1207", status: "active" } });
  const trailer = await prisma.trailer.create({
    data: { orgId: org.id, unit: "RF-3310", type: "Reefer", status: "active" },
  });
  const load = await prisma.load.create({
    data: {
      orgId: org.id, requiredEquip: "Reefer", revenueCents: 30000, fscCents: 4000, status: "open",
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: "KC dock", lat: KC.lat, lng: KC.lng,
            appointment: { create: { windowEnd: FAR, type: "pickup" } } },
          {
            sequence: 2, type: "delivery", address: "Omaha dock",
            ...(geocoded ? { lat: OMAHA.lat, lng: OMAHA.lng } : {}),
            appointment: { create: { windowEnd: FAR, type: "delivery" } },
          },
        ],
      },
    },
  });
  return { org, driver, tractor, trailer, load };
}

it("completing a leg positions its trailer at the delivery stop and sets lastSeenAt", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seedLoad();

  const commit = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });
  expect(commit.status).toBe(201);
  const id = commit.body.assignment.id as string;

  const before = Date.now();
  const done = await request(app).post(`/api/dispatcher/assignments/${id}/status`)
    .set("authorization", auth).send({ status: "completed" });
  const after = Date.now();
  expect(done.status).toBe(200);

  const updated = await prisma.trailer.findUnique({ where: { id: trailer.id } });
  expect(updated?.lastLat).toBe(OMAHA.lat);
  expect(updated?.lastLng).toBe(OMAHA.lng);
  expect(updated?.lastSeenAt).not.toBeNull();
  const seenAtMs = updated!.lastSeenAt!.getTime();
  expect(seenAtMs).toBeGreaterThanOrEqual(before);
  expect(seenAtMs).toBeLessThanOrEqual(after);
});

it("a trailer never hauled keeps null in lastLat, lastLng, and lastSeenAt", async () => {
  const org = await prisma.org.create({ data: { name: "Acme Fleet" } });
  const trailer = await prisma.trailer.create({ data: { orgId: org.id, unit: "RF-9999", type: "Reefer" } });

  const row = await prisma.trailer.findUnique({ where: { id: trailer.id } });
  expect(row?.lastLat).toBeNull();
  expect(row?.lastLng).toBeNull();
  expect(row?.lastSeenAt).toBeNull();
});

// DISCRIMINATION CHECK — named so a later reader can see exactly which bug
// this guards against: an ungeocoded final stop must never leave the trailer
// pinned at 0,0 (or anywhere else invented), and lastSeenAt must never be set
// without a real position accompanying it.
it("DISCRIMINATION CHECK: completing a leg whose final stop has no coordinates leaves the trailer's lastLat/lastLng/lastSeenAt untouched (null), never 0,0 and never lastSeenAt alone", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seedLoad({ deliveryGeocoded: false });

  // Built directly (bypassing POST /assignments): the commit engine refuses
  // to price a load with an ungeocoded stop at all, so the only way this
  // state reaches the completion route is a fixture assembled the way
  // dispatcher-loadboard.test.ts already assembles Assignment rows for
  // routes that don't re-run the engine.
  const assignment = await prisma.assignment.create({
    data: {
      orgId: load.orgId, loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id,
      plannedStart: new Date("2026-08-21T08:00:00.000Z"), plannedEnd: new Date("2026-08-21T14:00:00.000Z"),
      status: "assigned",
    },
  });

  const done = await request(app).post(`/api/dispatcher/assignments/${assignment.id}/status`)
    .set("authorization", auth).send({ status: "completed" });
  // The completion itself must still succeed — an ungeocoded stop refuses the
  // POSITION write, never the lifecycle transition.
  expect(done.status).toBe(200);
  expect(done.body.assignment.completedAt).toBeTruthy();

  const updated = await prisma.trailer.findUnique({ where: { id: trailer.id } });
  expect(updated?.lastLat).toBeNull();
  expect(updated?.lastLng).toBeNull();
  expect(updated?.lastSeenAt).toBeNull();
});
