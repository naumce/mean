import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import * as realtime from "../src/realtime.js";

// Cockpit S2a Task 6: tendering a load offers it to the driver instead of
// assigning it outright, but a tendered assignment still holds the driver's
// capacity — ACTIVE_STATUSES (src/lib/activeStatuses.ts) already includes
// "tendered", so every busy/overlap/yard query treats it as occupied. This
// suite proves that end to end through the real POST /assignments route
// rather than asserting on ACTIVE_STATUSES directly.

beforeEach(resetDb);
afterEach(() => {
  vi.restoreAllMocks();
});

let dispatcherSeq = 0;
async function dispatcherAuth() {
  dispatcherSeq += 1;
  const disp = await prisma.dispatcher.create({
    data: { email: `d${dispatcherSeq}@x.com`, passwordHash: "x", name: "D" },
  });
  return `Bearer ${signDispatcherAccess(disp.id)}`;
}

const KC = { lat: 39.0997, lng: -94.5786 };
const OMAHA = { lat: 41.2565, lng: -95.9345 };
const FAR = new Date("2027-01-01T00:00:00.000Z");

// Commit fixture copied from tests/dispatcher-assignments.test.ts's seed() —
// same shape, not reinvented. `tag` keeps emails unique when a test seeds
// more than one org/driver in the same run (no resetDb between them).
let seedSeq = 0;
async function seed(opts: { trailerType?: string } = {}) {
  seedSeq += 1;
  const org = await prisma.org.create({ data: { name: "Acme Fleet" } });
  const driver = await prisma.driver.create({
    data: {
      email: `drv${seedSeq}@x.com`, passwordHash: "x", name: "Jake", orgId: org.id,
      hazmatEndorsed: true, lastLat: KC.lat, lastLng: KC.lng,
      hos: { create: { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 } },
    },
  });
  const tractor = await prisma.tractor.create({ data: { orgId: org.id, unit: "1207", status: "active" } });
  const trailer = await prisma.trailer.create({
    data: { orgId: org.id, unit: "RF-1", type: opts.trailerType ?? "Reefer", status: "active" },
  });
  const load = await prisma.load.create({
    data: {
      orgId: org.id, requiredEquip: "Reefer", revenueCents: 30000, fscCents: 4000, status: "open",
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: "KC dock", lat: KC.lat, lng: KC.lng,
            appointment: { create: { windowEnd: FAR, type: "pickup" } } },
          { sequence: 2, type: "delivery", address: "Omaha dock", lat: OMAHA.lat, lng: OMAHA.lng,
            appointment: { create: { windowEnd: FAR, type: "delivery" } } },
        ],
      },
    },
  });
  return { org, driver, tractor, trailer, load };
}

/** A second open load for the same org, sharing the same stops (so the
 *  driver plan lines up), for the overlap test. */
async function secondLoad(orgId: string) {
  return prisma.load.create({
    data: {
      orgId, requiredEquip: "Reefer", revenueCents: 25000, fscCents: 3000, status: "open",
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: "KC dock 2", lat: KC.lat, lng: KC.lng,
            appointment: { create: { windowEnd: FAR, type: "pickup" } } },
          { sequence: 2, type: "delivery", address: "Omaha dock 2", lat: OMAHA.lat, lng: OMAHA.lng,
            appointment: { create: { windowEnd: FAR, type: "delivery" } } },
        ],
      },
    },
  });
}

it("tenders a load: 201, assignment+load status tendered, tenderedAt stamped near now", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed();
  const before = Date.now();

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id, tender: true });

  expect(res.status).toBe(201);
  expect(res.body.assignment.status).toBe("tendered");

  const persisted = await prisma.assignment.findUnique({ where: { loadId: load.id } });
  expect(persisted?.status).toBe("tendered");
  expect(persisted?.tenderedAt).not.toBeNull();
  const stampedAt = persisted!.tenderedAt!.getTime();
  expect(stampedAt).toBeGreaterThanOrEqual(before);
  expect(stampedAt).toBeLessThanOrEqual(Date.now() + 5000);

  const updatedLoad = await prisma.load.findUnique({ where: { id: load.id } });
  expect(updatedLoad?.status).toBe("tendered");
});

it("tendering decrements the driver's HOS clocks by EXACTLY the same amount as a plain assign", async () => {
  const authA = await dispatcherAuth();
  const { load: loadA, driver: driverA, tractor: tractorA, trailer: trailerA } = await seed();

  // Baseline: a plain assign against its own isolated fixture, to learn the
  // exact planned delta this fixture produces.
  const plainRes = await request(app).post("/api/dispatcher/assignments").set("authorization", authA)
    .send({ loadId: loadA.id, driverId: driverA.id, tractorId: tractorA.id, trailerId: trailerA.id });
  expect(plainRes.status).toBe(201);
  const hosAfterPlain = await prisma.hosState.findUnique({ where: { driverId: driverA.id } });
  const plan = plainRes.body.plan as { driveMin: number; onDutyMin: number };
  const expectedDriveDelta = Math.round(plan.driveMin);
  const expectedOnDutyDelta = Math.round(plan.onDutyMin);

  // Exact, non-trivial deltas — pins the assertion below to a real number,
  // not "whatever came out of the plan".
  expect(expectedDriveDelta).toBeGreaterThan(0);
  expect(hosAfterPlain?.driveRemainingMin).toBe(660 - expectedDriveDelta);
  expect(hosAfterPlain?.windowRemainingMin).toBe(840 - expectedOnDutyDelta);
  expect(hosAfterPlain?.cycleRemainingMin).toBe(4200 - expectedOnDutyDelta);

  // A second, identical fixture — same driver-start/pickup/delivery geometry,
  // so the plan (and therefore the expected HOS delta) is identical — but
  // tendered instead of assigned.
  const authB = await dispatcherAuth();
  const { load: loadB, driver: driverB, tractor: tractorB, trailer: trailerB } = await seed();

  const tenderRes = await request(app).post("/api/dispatcher/assignments").set("authorization", authB)
    .send({ loadId: loadB.id, driverId: driverB.id, tractorId: tractorB.id, trailerId: trailerB.id, tender: true });
  expect(tenderRes.status).toBe(201);
  expect(tenderRes.body.assignment.status).toBe("tendered");

  const hosAfterTender = await prisma.hosState.findUnique({ where: { driverId: driverB.id } });
  // The load-bearing assertions: the SAME exact numbers a plain assign
  // produced, not merely "some clock moved". Capacity is genuinely held
  // while the tender is outstanding.
  expect(hosAfterTender?.driveRemainingMin).toBe(660 - expectedDriveDelta);
  expect(hosAfterTender?.windowRemainingMin).toBe(840 - expectedOnDutyDelta);
  expect(hosAfterTender?.cycleRemainingMin).toBe(4200 - expectedOnDutyDelta);
  expect(hosAfterTender?.driveRemainingMin).toBe(hosAfterPlain?.driveRemainingMin);
  expect(hosAfterTender?.windowRemainingMin).toBe(hosAfterPlain?.windowRemainingMin);
  expect(hosAfterTender?.cycleRemainingMin).toBe(hosAfterPlain?.cycleRemainingMin);
});

it("a second load tendered to the same driver over the same interval is refused with an overlap block (proves tendered holds capacity)", async () => {
  const auth = await dispatcherAuth();
  const { org, load, driver, tractor, trailer } = await seed();
  const load2 = await secondLoad(org.id);

  const first = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id, tender: true });
  expect(first.status).toBe(201);
  expect(first.body.assignment.status).toBe("tendered");

  // Same driver/tractor/trailer, default availableAt -> same planned window
  // as the first tender, so this can only be refused by the overlap check
  // treating the outstanding tender as busy (ACTIVE_STATUSES includes
  // "tendered").
  const second = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load2.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id, tender: true });

  expect(second.status).toBe(422);
  expect(second.body.feasible).toBe(false);
  const overlapBlock = second.body.conflicts.find(
    (c: { kind: string; severity: string }) => c.severity === "block",
  );
  expect(overlapBlock).toBeDefined();
  // Only the first tender exists — the refused second attempt wrote nothing.
  expect(await prisma.assignment.count()).toBe(1);
  expect((await prisma.load.findUnique({ where: { id: load2.id } }))?.status).toBe("open");
});

it("dryRun + tender previews without writing anything (no Assignment, Load stays open)", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed();

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id, tender: true, dryRun: true });

  expect(res.status).toBe(200);
  expect(res.body.feasible).toBe(true);

  expect(await prisma.assignment.findUnique({ where: { loadId: load.id } })).toBeNull();
  const updatedLoad = await prisma.load.findUnique({ where: { id: load.id } });
  expect(updatedLoad?.status).toBe("open");
  const hos = await prisma.hosState.findUnique({ where: { driverId: driver.id } });
  expect(hos?.driveRemainingMin).toBe(660);
});

// --- The offer's event NAME (S2a final review, I2) --------------------------
// `body.tender ? "trip_tender" : "trip_assignment"` was unpinned: flipping it
// to always send "trip_assignment" left 64 tests green. The driver's app
// dispatches on that string — "trip_tender" renders an offer with Accept and
// Reject, "trip_assignment" renders a confirmed trip. Send the wrong one and
// the driver rolls on a load they never accepted, while the server still
// believes it is holding an unanswered offer.
//
// Both directions are asserted, in one test, so neither a stuck "trip_tender"
// nor a stuck "trip_assignment" can survive.

it("a tender notifies the driver as an OFFER (trip_tender) while a plain assign notifies as a confirmed trip (trip_assignment)", async () => {
  const spy = vi.spyOn(realtime, "emitToDriver");

  const authA = await dispatcherAuth();
  const a = await seed();
  const tenderRes = await request(app).post("/api/dispatcher/assignments").set("authorization", authA)
    .send({ loadId: a.load.id, driverId: a.driver.id, tractorId: a.tractor.id, trailerId: a.trailer.id, tender: true });
  expect(tenderRes.status).toBe(201);

  const authB = await dispatcherAuth();
  const b = await seed();
  const assignRes = await request(app).post("/api/dispatcher/assignments").set("authorization", authB)
    .send({ loadId: b.load.id, driverId: b.driver.id, tractorId: b.tractor.id, trailerId: b.trailer.id });
  expect(assignRes.status).toBe(201);

  const eventFor = (driverId: string) =>
    spy.mock.calls.filter((c) => c[0] === driverId).map((c) => c[1]);

  expect(eventFor(a.driver.id)).toEqual(["trip_tender"]);
  expect(eventFor(b.driver.id)).toEqual(["trip_assignment"]);

  // The payload still names the row the driver must act on, or Accept has
  // nothing to POST to.
  const tenderCall = spy.mock.calls.find((c) => c[0] === a.driver.id)!;
  expect((tenderCall[2] as Record<string, unknown>).assignmentId).toBe(tenderRes.body.assignment.id);
  expect((tenderCall[2] as Record<string, unknown>).loadId).toBe(a.load.id);
});
