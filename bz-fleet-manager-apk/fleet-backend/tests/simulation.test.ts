import request from "supertest";
import { EventEmitter } from "node:events";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import * as realtimeModule from "../src/realtime.js";
import { tick } from "../src/lib/simulation/engine.js";
import { availabilityFor } from "../src/lib/driverAvailability.js";
import { eastOffsetDeg, positionAlong } from "../src/lib/simulation/movement.js";
import { haversineMi } from "../src/domain/dispatch/distance.js";
import { disarmVanish, vanishNext } from "./vanish.js";

// child_process is mocked for the whole file: /sim/reset spawns
// `node seed-world.mjs` for real otherwise, which is both slow (~7s) and
// rewrites the shared demo org out from under every other test. `kill` is a
// spy (never a real signal) so the timeout-path test below can assert it was
// called without needing a process that actually exits.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => Object.assign(new EventEmitter(), { kill: vi.fn() })),
}));
import { spawn } from "node:child_process";
import { runnerState, startRunner } from "../src/lib/simulation/runner.js";
import { WORLD_ORG_NAME } from "../seed-world.mjs";

beforeEach(resetDb);
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DEMO_MODE;
});

// Chicago -> Indianapolis, ~165 great-circle miles.
const CHI = { lat: 41.8781, lng: -87.6298 };
const INDY = { lat: 39.7684, lng: -86.1581 };
const CHI_ADDRESS = "100 Dock St, Chicago, IL 60607";
const INDY_ADDRESS = "400 Dock St, Indianapolis, IN 46204";

/** The point a straight lat/lng lerp (NOT the engine's own great-circle
 *  slerp) would land on `fraction` of the way from CHI to INDY. Independent
 *  of movement.ts on purpose — over a ~165mi leg the two methods differ by a
 *  few hundred feet at most, comfortably inside the 3mi tolerance the task
 *  brief itself specifies, so this is a real check of the engine's output,
 *  not a restatement of its own formula. */
function expectedAlong(fraction: number): { lat: number; lng: number } {
  return { lat: CHI.lat + fraction * (INDY.lat - CHI.lat), lng: CHI.lng + fraction * (INDY.lng - CHI.lng) };
}

interface FixtureOpts {
  assignmentStatus?: "assigned" | "in_progress";
  geocodeDelivery?: boolean;
}

async function seedFixture(opts: FixtureOpts = {}) {
  const status = opts.assignmentStatus ?? "in_progress";
  const geocodeDelivery = opts.geocodeDelivery ?? true;

  const org = await prisma.org.create({ data: { name: "Sim Org" } });
  const driver = await prisma.driver.create({
    data: {
      email: "sim-driver@x.com", passwordHash: "x", name: "Sim Driver", orgId: org.id,
      lastLat: CHI.lat, lastLng: CHI.lng, lastLocationAt: new Date(),
    },
  });
  const load = await prisma.load.create({
    data: {
      orgId: org.id, requiredEquip: "Reefer", revenueCents: 50000, status,
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: CHI_ADDRESS, lat: CHI.lat, lng: CHI.lng },
          {
            sequence: 2, type: "delivery", address: INDY_ADDRESS,
            lat: geocodeDelivery ? INDY.lat : null, lng: geocodeDelivery ? INDY.lng : null,
          },
        ],
      },
    },
  });
  const now = Date.now();
  const [startOffsetMin, endOffsetMin] = status === "assigned" ? [-5, 120] : [-30, 90];
  const plannedStart = new Date(now + startOffsetMin * 60_000);
  const plannedEnd = new Date(now + endOffsetMin * 60_000);
  const assignment = await prisma.assignment.create({
    data: {
      orgId: org.id, loadId: load.id, driverId: driver.id, plannedStart, plannedEnd, status,
      startedAt: status === "in_progress" ? plannedStart : null,
    },
  });
  return { org, driver, load, assignment };
}

/** A second driver/load/assignment under an already-seeded org, also
 *  in_progress and also due to complete this tick — shared by the two
 *  "one of two completing assignments fails, the other doesn't" tests below
 *  (a dispatcher-held lock; a genuine concurrent-write failure). */
async function seedSecondCompletingAssignment(orgId: string) {
  const driverB = await prisma.driver.create({
    data: {
      email: "sim-driver-b@x.com", passwordHash: "x", name: "Sim Driver B", orgId,
      lastLat: CHI.lat, lastLng: CHI.lng, lastLocationAt: new Date(),
    },
  });
  const loadB = await prisma.load.create({
    data: {
      orgId, requiredEquip: "Reefer", revenueCents: 40000, status: "in_progress",
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: CHI_ADDRESS, lat: CHI.lat, lng: CHI.lng },
          { sequence: 2, type: "delivery", address: INDY_ADDRESS, lat: INDY.lat, lng: INDY.lng },
        ],
      },
    },
  });
  const now = Date.now();
  const assignmentB = await prisma.assignment.create({
    data: {
      orgId, loadId: loadB.id, driverId: driverB.id,
      plannedStart: new Date(now - 30 * 60_000), plannedEnd: new Date(now + 90 * 60_000),
      status: "in_progress", startedAt: new Date(now - 30 * 60_000),
    },
  });
  return { driverB, loadB, assignmentB };
}

async function dispatcherAuthFor(orgId: string) {
  const d = await prisma.dispatcher.create({ data: { email: "sim-disp@x.com", passwordHash: "x", name: "Sim Dispatcher", orgId } });
  return `Bearer ${signDispatcherAccess(d.id)}`;
}

describe("tick()", () => {
  it("moves an in_progress driver along the great circle and writes exactly one ping", async () => {
    const { org, driver } = await seedFixture();

    const result = await tick(org.id, 60);

    expect(result.pings).toBe(1);
    expect(result.started).toBe(0);
    expect(result.completed).toBe(0);

    const pings = await prisma.driverLocation.findMany({ where: { driverId: driver.id } });
    expect(pings).toHaveLength(1);
    const expected = expectedAlong(0.75);
    expect(haversineMi({ lat: pings[0].latitude, lng: pings[0].longitude }, expected)).toBeLessThan(3);

    const updatedDriver = await prisma.driver.findUniqueOrThrow({ where: { id: driver.id } });
    expect(haversineMi({ lat: updatedDriver.lastLat!, lng: updatedDriver.lastLng! }, expected)).toBeLessThan(3);

    const state = await prisma.simulationState.findUniqueOrThrow({ where: { orgId: org.id } });
    expect(state.simMinutesAdvanced).toBe(60);
  });

  it("stopped: re-pings the driver's own last position, not the interpolated one", async () => {
    const { org, driver } = await seedFixture();
    await prisma.simDriverState.create({ data: { driverId: driver.id, mode: "stopped" } });

    await tick(org.id, 60);

    const pings = await prisma.driverLocation.findMany({ where: { driverId: driver.id } });
    expect(pings).toHaveLength(1);
    expect(pings[0].latitude).toBe(CHI.lat);
    expect(pings[0].longitude).toBe(CHI.lng);
    const updatedDriver = await prisma.driver.findUniqueOrThrow({ where: { id: driver.id } });
    expect(updatedDriver.lastLat).toBe(CHI.lat);
    expect(updatedDriver.lastLng).toBe(CHI.lng);
  });

  it("dark: writes nothing at all", async () => {
    const { org, driver } = await seedFixture();
    await prisma.simDriverState.create({ data: { driverId: driver.id, mode: "dark" } });
    const before = await prisma.driver.findUniqueOrThrow({ where: { id: driver.id } });

    const result = await tick(org.id, 60);

    expect(result.pings).toBe(0);
    expect(await prisma.driverLocation.count({ where: { driverId: driver.id } })).toBe(0);
    const after = await prisma.driver.findUniqueOrThrow({ where: { id: driver.id } });
    expect(after.lastLocationAt?.getTime()).toBe(before.lastLocationAt?.getTime());
    expect(after.lastLat).toBe(before.lastLat);
  });

  it("idle: writes nothing at all", async () => {
    const { org, driver } = await seedFixture();
    await prisma.simDriverState.create({ data: { driverId: driver.id, mode: "idle" } });
    const before = await prisma.driver.findUniqueOrThrow({ where: { id: driver.id } });

    const result = await tick(org.id, 60);

    expect(result.pings).toBe(0);
    expect(await prisma.driverLocation.count({ where: { driverId: driver.id } })).toBe(0);
    const after = await prisma.driver.findUniqueOrThrow({ where: { id: driver.id } });
    expect(after.lastLocationAt?.getTime()).toBe(before.lastLocationAt?.getTime());
  });

  it("offroute: applies offsetLat/offsetLng on top of the interpolated position", async () => {
    const { org, driver } = await seedFixture();
    await prisma.simDriverState.create({ data: { driverId: driver.id, mode: "offroute", offsetLat: 0.05, offsetLng: -0.05 } });

    await tick(org.id, 60);

    const pings = await prisma.driverLocation.findMany({ where: { driverId: driver.id } });
    expect(pings).toHaveLength(1);
    const base = expectedAlong(0.75);
    const expected = { lat: base.lat + 0.05, lng: base.lng - 0.05 };
    expect(haversineMi({ lat: pings[0].latitude, lng: pings[0].longitude }, expected)).toBeLessThan(3);
  });

  it("an expired modeUntil behaves as auto for this tick and is reset on the row", async () => {
    const { org, driver } = await seedFixture();
    await prisma.simDriverState.create({
      data: { driverId: driver.id, mode: "stopped", modeUntil: new Date(Date.now() - 60_000) },
    });

    await tick(org.id, 60);

    const pings = await prisma.driverLocation.findMany({ where: { driverId: driver.id } });
    expect(pings).toHaveLength(1);
    const expected = expectedAlong(0.75);
    expect(haversineMi({ lat: pings[0].latitude, lng: pings[0].longitude }, expected)).toBeLessThan(3);

    const simState = await prisma.simDriverState.findUniqueOrThrow({ where: { driverId: driver.id } });
    expect(simState.mode).toBe("auto");
    expect(simState.modeUntil).toBeNull();
  });

  it("positions never move for a load with fewer than 2 geocoded stops", async () => {
    const { org, driver, assignment } = await seedFixture({ geocodeDelivery: false });
    const before = await prisma.driver.findUniqueOrThrow({ where: { id: driver.id } });

    const result = await tick(org.id, 60);

    expect(result.pings).toBe(0);
    expect(await prisma.driverLocation.count({ where: { driverId: driver.id } })).toBe(0);
    const after = await prisma.driver.findUniqueOrThrow({ where: { id: driver.id } });
    expect(after.lastLat).toBe(before.lastLat);
    expect(after.lastLng).toBe(before.lastLng);
    expect((await prisma.assignment.findUniqueOrThrow({ where: { id: assignment.id } })).status).toBe("in_progress");
  });

  it("an assigned assignment whose plannedStart has passed moves to in_progress with startedAt", async () => {
    const { org, load, assignment } = await seedFixture({ assignmentStatus: "assigned" });

    const result = await tick(org.id, 1);

    expect(result.started).toBe(1);
    const updated = await prisma.assignment.findUniqueOrThrow({ where: { id: assignment.id } });
    expect(updated.status).toBe("in_progress");
    expect(updated.startedAt).toBeTruthy();
    expect((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).status).toBe("in_progress");
  });

  it("tick(180) completes the assignment, delivers the load, and derives a fresh DriverAvailability row", async () => {
    const { org, driver, load, assignment } = await seedFixture();

    const result = await tick(org.id, 180);

    expect(result.completed).toBe(1);
    expect(result.pings).toBe(1);

    const finished = await prisma.assignment.findUniqueOrThrow({ where: { id: assignment.id } });
    expect(finished.status).toBe("completed");
    expect(finished.completedAt).toBeTruthy();
    expect((await prisma.load.findUniqueOrThrow({ where: { id: load.id } })).status).toBe("delivered");

    const pings = await prisma.driverLocation.findMany({ where: { driverId: driver.id } });
    expect(pings).toHaveLength(1);
    expect(pings[0].latitude).toBe(INDY.lat);
    expect(pings[0].longitude).toBe(INDY.lng);

    const avail = await prisma.driverAvailability.findUniqueOrThrow({ where: { driverId: driver.id } });
    expect(avail.source).toBe("simulation");
    // The row itself never pins a location/time snapshot — only
    // availabilityStatus (+source) are stored; availableAt/Lat/Lng/City/State
    // stay null so a later assignment's live projection is never shadowed by
    // a stale completion fact (see the two-load sequence test below).
    expect(avail.availableAt).toBeNull();
    expect(avail.availableLat).toBeNull();
    expect(avail.availableLng).toBeNull();
    expect(avail.availableCity).toBeNull();
    expect(avail.availableState).toBeNull();
    // The fixture never creates a DriverAvailability row before this tick, so
    // acceptingLoads defaults false; the assignment that just completed is no
    // longer "current" for projectAvailability, so deriveStatus's rule 3
    // (acceptingLoads ? AVAILABLE : UNAVAILABLE) is the one that runs, and it
    // lands on UNAVAILABLE — the same answer any driver who has never told
    // the board they're open for a load would get.
    expect(avail.availabilityStatus).toBe("UNAVAILABLE");
  });

  it("two-load sequence: after completing load 1, starting load 2 makes availabilityFor follow load 2's drop/plannedEnd, not load 1's stale completion", async () => {
    const { org, driver } = await seedFixture();

    // Tick 1: complete the fixture's own load (CHI -> INDY), exactly like the
    // test above — this is the tick that used to WRITE Indianapolis into the
    // stored row.
    await tick(org.id, 180);
    const afterFirstCompletion = await prisma.driverAvailability.findUniqueOrThrow({ where: { driverId: driver.id } });
    expect(afterFirstCompletion.availableCity).toBeNull();

    // A second load, INDY -> a third city (Columbus), assigned to the same
    // driver with a plannedStart already in the past relative to `now` so the
    // next tick starts it immediately.
    const COLUMBUS = { lat: 39.9612, lng: -82.9988 };
    const COLUMBUS_ADDRESS = "500 Dock Rd, Columbus, OH 43215";
    const load2 = await prisma.load.create({
      data: {
        orgId: org.id, requiredEquip: "Reefer", revenueCents: 40000, status: "assigned",
        stops: {
          create: [
            { sequence: 1, type: "pickup", address: INDY_ADDRESS, lat: INDY.lat, lng: INDY.lng },
            { sequence: 2, type: "delivery", address: COLUMBUS_ADDRESS, lat: COLUMBUS.lat, lng: COLUMBUS.lng },
          ],
        },
      },
    });
    // Tick 1 already advanced the sim clock 180 minutes ahead of real time;
    // this tick adds 1 more (181 total). plannedStart sits comfortably before
    // that so load 2 is due; plannedEnd sits comfortably AFTER it so load 2
    // starts but does not also complete within this same tick.
    const t0 = Date.now();
    const plannedStart = new Date(t0 - 5 * 60_000);
    const plannedEnd = new Date(t0 + 400 * 60_000);
    const assignment2 = await prisma.assignment.create({
      data: { orgId: org.id, loadId: load2.id, driverId: driver.id, plannedStart, plannedEnd, status: "assigned" },
    });

    // Tick 2: starts load 2 (plannedStart already passed) without completing it.
    const startResult = await tick(org.id, 1);
    expect(startResult.started).toBe(1);
    expect((await prisma.assignment.findUniqueOrThrow({ where: { id: assignment2.id } })).status).toBe("in_progress");

    const [view] = await availabilityFor(org.id, [driver.id]);
    // Load 2's delivery city/plannedEnd — never load 1's Indianapolis/its own
    // completedAt — because the stored row carries no frozen location for the
    // live projection to be shadowed by.
    expect(view.available.city).toBe("Columbus");
    expect(view.available.state).toBe("OH");
    expect(view.availableAt).toBe(plannedEnd.getTime());
    expect(view.currentAssignment?.loadId).toBe(load2.id);
  });

  it("a manual DriverAvailability row survives a completion untouched", async () => {
    const { org, driver } = await seedFixture();
    await prisma.driverAvailability.create({
      data: { driverId: driver.id, source: "manual", availabilityStatus: "OFF_DUTY", acceptingLoads: false, availableCity: "Nowhere", availableState: "ZZ" },
    });

    await tick(org.id, 180);

    const avail = await prisma.driverAvailability.findUniqueOrThrow({ where: { driverId: driver.id } });
    expect(avail.source).toBe("manual");
    expect(avail.availabilityStatus).toBe("OFF_DUTY");
    expect(avail.availableCity).toBe("Nowhere");
    expect(avail.availableState).toBe("ZZ");
  });

  it("a LoadLock on one completing load is skipped, not fatal to the tick — the other load still completes and the clock still advances", async () => {
    const { org, assignment } = await seedFixture();
    const { loadB, assignmentB } = await seedSecondCompletingAssignment(org.id);
    // A dispatcher (not the simulation, whose actor carries dispatcherId
    // null) mid-editing loadB on the board — exactly what assertWritable's
    // LoadLocked guards against.
    await prisma.loadLock.create({
      data: { loadId: loadB.id, orgId: org.id, dispatcherId: "some-other-dispatcher", dispatcherName: "Maria", expiresAt: new Date(Date.now() + 60_000) },
    });

    const result = await tick(org.id, 180);

    expect(result.completed).toBe(1);
    expect(result.skipped).toBe(1);

    expect((await prisma.assignment.findUniqueOrThrow({ where: { id: assignment.id } })).status).toBe("completed");
    // The locked one never transitioned — its OWN transaction (one per
    // transition) rolled back in full, and that rollback must not have
    // touched the other driver's progress.
    expect((await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentB.id } })).status).toBe("in_progress");

    // The tick's own clock advance is not part of what a skipped transition
    // rolls back.
    const state = await prisma.simulationState.findUniqueOrThrow({ where: { orgId: org.id } });
    expect(state.simMinutesAdvanced).toBe(180);
  });

  it("a genuine SQL failure (P2025 — the row vanished between the tick's read and its transition) on one completing assignment doesn't take the tick down — the other still completes, the clock advances, and its ping is written", async () => {
    const { org, assignment, driver } = await seedFixture();
    const { assignmentB, driverB } = await seedSecondCompletingAssignment(org.id);

    // Simulate a row deleted by a concurrent request between advanceInProgress's
    // read and its transition: the NEXT Assignment.update — whichever of the
    // two completing assignments the loop reaches first — fails with the same
    // P2025 Prisma raises for a real vanished row (tests/vanish.ts, already
    // used by tests/dispatcher-assignments.test.ts for this exact scenario).
    vanishNext("Assignment", "update");
    const result = await tick(org.id, 180);
    disarmVanish(); // no-op if it already fired, a safety net if it didn't

    expect(result.completed).toBe(1);
    expect(result.skipped).toBe(1);

    const [finalA, finalB] = await Promise.all([
      prisma.assignment.findUniqueOrThrow({ where: { id: assignment.id } }),
      prisma.assignment.findUniqueOrThrow({ where: { id: assignmentB.id } }),
    ]);
    // Exactly one of the two completed; which one depends on read order,
    // which Prisma does not guarantee — so this asserts the OUTCOME
    // (one completed, one didn't), not a specific winner.
    expect([finalA.status, finalB.status].sort()).toEqual(["completed", "in_progress"]);

    // The clock still advances despite the failed transition.
    const state = await prisma.simulationState.findUniqueOrThrow({ where: { orgId: org.id } });
    expect(state.simMinutesAdvanced).toBe(180);

    // The surviving driver's final ping was written — a failed transition
    // elsewhere must not cost it.
    const survivingDriverId = finalA.status === "completed" ? driver.id : driverB.id;
    const pings = await prisma.driverLocation.findMany({ where: { driverId: survivingDriverId } });
    expect(pings).toHaveLength(1);
  });

  it("emits driver_location through emitToDispatchers, copying the driver.ts payload shape", async () => {
    const { org, driver } = await seedFixture();
    const spy = vi.spyOn(realtimeModule, "emitToDispatchers");

    await tick(org.id, 60);

    const pingCalls = spy.mock.calls.filter((c) => c[1] === "driver_location");
    expect(pingCalls).toHaveLength(1);
    expect(pingCalls[0][0]).toBe(org.id);
    expect(pingCalls[0][2]).toMatchObject({
      driverId: driver.id, latitude: expect.any(Number), longitude: expect.any(Number), at: expect.any(String),
    });
  });

  it("emits load_changed for the assigned->in_progress transition", async () => {
    const { org, load } = await seedFixture({ assignmentStatus: "assigned" });
    const spy = vi.spyOn(realtimeModule, "emitToDispatchers");

    await tick(org.id, 1);

    const changeCalls = spy.mock.calls.filter((c) => c[1] === "load_changed");
    expect(changeCalls).toHaveLength(1);
    expect(changeCalls[0][2]).toMatchObject({ loadId: load.id, fields: ["status"] });
  });
});

describe("/sim routes", () => {
  it("is ABSENT — 404 — for every /sim route when DEMO_MODE is unset", async () => {
    delete process.env.DEMO_MODE;
    const { org, driver } = await seedFixture();
    const auth = await dispatcherAuthFor(org.id);

    const calls: Array<() => Promise<request.Response>> = [
      () => request(app).get("/api/dispatcher/sim/state").set("authorization", auth),
      () => request(app).post("/api/dispatcher/sim/tick").set("authorization", auth).send({ minutes: 5 }),
      () => request(app).post("/api/dispatcher/sim/start").set("authorization", auth).send({ speed: 10 }),
      () => request(app).post("/api/dispatcher/sim/stop").set("authorization", auth).send({}),
      () => request(app).post(`/api/dispatcher/sim/drivers/${driver.id}/mode`).set("authorization", auth).send({ mode: "stopped" }),
      () => request(app).post("/api/dispatcher/sim/reset").set("authorization", auth).send({}),
    ];
    for (const call of calls) expect((await call()).status).toBe(404);
  });

  it("state/tick/start/stop/mode all respond once DEMO_MODE is true", async () => {
    process.env.DEMO_MODE = "true";
    const { org, driver } = await seedFixture();
    const auth = await dispatcherAuthFor(org.id);

    const state = await request(app).get("/api/dispatcher/sim/state").set("authorization", auth);
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ running: false, simMinutesAdvanced: 0, drivers: [] });

    const tickRes = await request(app).post("/api/dispatcher/sim/tick").set("authorization", auth).send({ minutes: 5 });
    expect(tickRes.status).toBe(200);
    expect(tickRes.body).toMatchObject({ simNowMs: expect.any(Number) });

    const start = await request(app).post("/api/dispatcher/sim/start").set("authorization", auth).send({ speed: 10 });
    expect(start.status).toBe(200);
    expect((await request(app).get("/api/dispatcher/sim/state").set("authorization", auth)).body).toMatchObject({ running: true, speed: 10 });

    const stop = await request(app).post("/api/dispatcher/sim/stop").set("authorization", auth).send({});
    expect(stop.status).toBe(200);
    expect((await request(app).get("/api/dispatcher/sim/state").set("authorization", auth)).body).toMatchObject({ running: false });

    const mode = await request(app).post(`/api/dispatcher/sim/drivers/${driver.id}/mode`).set("authorization", auth).send({ mode: "stopped", minutes: 30 });
    expect(mode.status).toBe(200);
    expect(mode.body).toMatchObject({ driverId: driver.id, mode: "stopped" });
    const stateAfterMode = await request(app).get("/api/dispatcher/sim/state").set("authorization", auth);
    expect(stateAfterMode.body.drivers).toHaveLength(1);
  });

  it("validates request bodies with 400s", async () => {
    process.env.DEMO_MODE = "true";
    const { org, driver } = await seedFixture();
    const auth = await dispatcherAuthFor(org.id);

    expect((await request(app).post("/api/dispatcher/sim/tick").set("authorization", auth).send({ minutes: 0 })).status).toBe(400);
    expect((await request(app).post("/api/dispatcher/sim/tick").set("authorization", auth).send({ minutes: 1441 })).status).toBe(400);
    expect((await request(app).post("/api/dispatcher/sim/tick").set("authorization", auth).send({})).status).toBe(400);
    // A fractional value would otherwise reach engine.ts's simMinutesAdvanced
    // + minutes write into an Int column and fail Prisma validation after the
    // tick's transitions/pings already committed.
    expect((await request(app).post("/api/dispatcher/sim/tick").set("authorization", auth).send({ minutes: 2.5 })).status).toBe(400);
    expect((await request(app).post("/api/dispatcher/sim/start").set("authorization", auth).send({ speed: 0 })).status).toBe(400);
    expect((await request(app).post("/api/dispatcher/sim/start").set("authorization", auth).send({ speed: 121 })).status).toBe(400);
    // A fractional speed is passed straight through to tick() as `minutes` by
    // runner.ts — the same Int-column failure as above, just reached a tick
    // later once the runner starts ticking.
    expect((await request(app).post("/api/dispatcher/sim/start").set("authorization", auth).send({ speed: 1.5 })).status).toBe(400);
    expect((await request(app).post(`/api/dispatcher/sim/drivers/${driver.id}/mode`).set("authorization", auth).send({ mode: "bogus" })).status).toBe(400);
  });

  it("404s the mode route for a driver outside the caller's org", async () => {
    process.env.DEMO_MODE = "true";
    const { driver } = await seedFixture();
    const rival = await prisma.org.create({ data: { name: "Rival" } });
    const auth = await dispatcherAuthFor(rival.id);

    const res = await request(app).post(`/api/dispatcher/sim/drivers/${driver.id}/mode`).set("authorization", auth).send({ mode: "stopped" });
    expect(res.status).toBe(404);
  });

  it("refuses a second reset while one is already in flight, and clears on exit", async () => {
    process.env.DEMO_MODE = "true";
    vi.mocked(spawn).mockClear();
    const { org } = await seedFixture();
    const auth = await dispatcherAuthFor(org.id);

    const first = await request(app).post("/api/dispatcher/sim/reset").set("authorization", auth).send({});
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ started: true });
    expect(spawn).toHaveBeenCalledWith("node", ["seed-world.mjs"], expect.objectContaining({ cwd: expect.any(String) }));

    const second = await request(app).post("/api/dispatcher/sim/reset").set("authorization", auth).send({});
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: "RESET_RUNNING" });

    // The mocked child never exits on its own — simulate it finishing, which
    // must clear the module-level lock so a later reset can proceed.
    const firstChild = vi.mocked(spawn).mock.results[0]!.value as EventEmitter;
    firstChild.emit("exit", 0);

    const third = await request(app).post("/api/dispatcher/sim/reset").set("authorization", auth).send({});
    expect(third.status).toBe(202);
    const secondChild = vi.mocked(spawn).mock.results[1]!.value as EventEmitter;
    secondChild.emit("exit", 0);
  });

  it("a non-zero exit releases the reset lock but leaves SimulationState untouched", async () => {
    process.env.DEMO_MODE = "true";
    vi.mocked(spawn).mockClear();
    const { org } = await seedFixture();
    const auth = await dispatcherAuthFor(org.id);
    await prisma.simulationState.create({ data: { orgId: org.id, running: true, speed: 7, simMinutesAdvanced: 42 } });

    const res = await request(app).post("/api/dispatcher/sim/reset").set("authorization", auth).send({});
    expect(res.status).toBe(202);

    // A failed reseed (missing script, bad DATABASE_URL, ...) must not be
    // treated as if the org's data were actually rebuilt.
    const child = vi.mocked(spawn).mock.results[0]!.value as EventEmitter;
    child.emit("exit", 1);

    const state = await prisma.simulationState.findUniqueOrThrow({ where: { orgId: org.id } });
    expect(state).toMatchObject({ running: true, speed: 7, simMinutesAdvanced: 42 });

    // The lock still releases despite the failure — a retry must not 409.
    const retry = await request(app).post("/api/dispatcher/sim/reset").set("authorization", auth).send({});
    expect(retry.status).toBe(202);
    const retryChild = vi.mocked(spawn).mock.results[1]!.value as EventEmitter;
    retryChild.emit("exit", 0);
  });

  it("an error event releases the lock without crashing and without touching SimulationState", async () => {
    process.env.DEMO_MODE = "true";
    vi.mocked(spawn).mockClear();
    const { org } = await seedFixture();
    const auth = await dispatcherAuthFor(org.id);
    await prisma.simulationState.create({ data: { orgId: org.id, running: true, speed: 3, simMinutesAdvanced: 9 } });

    const res = await request(app).post("/api/dispatcher/sim/reset").set("authorization", auth).send({});
    expect(res.status).toBe(202);

    // A real ENOENT-style failure: spawn() returned, but the OS could not
    // exec the child at all — no exit code will ever follow. An EventEmitter
    // with no 'error' listener throws (and would crash this whole process,
    // every tenant included) the instant this fires; reaching the assertions
    // below at all is itself part of what this test verifies.
    const child = vi.mocked(spawn).mock.results[0]!.value as EventEmitter;
    child.emit("error", new Error("spawn node ENOENT"));

    const state = await prisma.simulationState.findUniqueOrThrow({ where: { orgId: org.id } });
    expect(state).toMatchObject({ running: true, speed: 3, simMinutesAdvanced: 9 });

    const retry = await request(app).post("/api/dispatcher/sim/reset").set("authorization", auth).send({});
    expect(retry.status).toBe(202);
    const retryChild = vi.mocked(spawn).mock.results[1]!.value as EventEmitter;
    retryChild.emit("exit", 0);
  });

  it("keys the runner stop and the post-exit SimulationState reset to the demo org by name, not the caller's org", async () => {
    process.env.DEMO_MODE = "true";
    vi.mocked(spawn).mockClear();
    const demoOrg = await prisma.org.create({ data: { name: WORLD_ORG_NAME } });
    await prisma.simulationState.create({ data: { orgId: demoOrg.id, running: true, speed: 9, simMinutesAdvanced: 77 } });
    startRunner(demoOrg.id, 9);

    const { org: callerOrg } = await seedFixture();
    const auth = await dispatcherAuthFor(callerOrg.id);

    const res = await request(app).post("/api/dispatcher/sim/reset").set("authorization", auth).send({});
    expect(res.status).toBe(202);
    // stopRunner runs synchronously before spawn — the demo org's runner is
    // stopped immediately even though a DIFFERENT org's dispatcher pressed
    // Reset.
    expect(runnerState(demoOrg.id).running).toBe(false);

    const child = vi.mocked(spawn).mock.results[0]!.value as EventEmitter;
    child.emit("exit", 0);
    // The post-exit SimulationState upsert is fire-and-forget from the
    // handler's own perspective (no request left to answer) — give its real
    // DB round trip a moment to land before reading it back.
    await new Promise((r) => setTimeout(r, 50));

    const demoState = await prisma.simulationState.findUniqueOrThrow({ where: { orgId: demoOrg.id } });
    expect(demoState).toMatchObject({ running: false, speed: 1, simMinutesAdvanced: 0, lastTickAt: null });
  });

  it("times out a hung reset after 5 minutes: kills the child, releases the lock, and logs", async () => {
    process.env.DEMO_MODE = "true";
    vi.mocked(spawn).mockClear();
    const { org } = await seedFixture();
    const auth = await dispatcherAuthFor(org.id);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    const first = await request(app).post("/api/dispatcher/sim/reset").set("authorization", auth).send({});
    expect(first.status).toBe(202);

    const callIndex = setTimeoutSpy.mock.calls.findIndex((c) => c[1] === 5 * 60_000);
    expect(callIndex).toBeGreaterThanOrEqual(0);
    const timeoutCallback = setTimeoutSpy.mock.calls[callIndex]![0] as () => void;
    const timeoutHandle = setTimeoutSpy.mock.results[callIndex]!.value as NodeJS.Timeout;

    const child = vi.mocked(spawn).mock.results[0]!.value as EventEmitter & { kill: ReturnType<typeof vi.fn> };

    timeoutCallback(); // simulate the 5-minute timer firing, with the child never exiting
    clearTimeout(timeoutHandle); // the REAL underlying timer must not also fire 5 real minutes from now

    expect(child.kill).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("timed out"));

    // The lock released without waiting for the (killed, but never-emitting-
    // in-this-test) child to actually exit.
    const retry = await request(app).post("/api/dispatcher/sim/reset").set("authorization", auth).send({});
    expect(retry.status).toBe(202);
    const retryChild = vi.mocked(spawn).mock.results[1]!.value as EventEmitter;
    retryChild.emit("exit", 0);
  });
});

describe("positionAlong", () => {
  // Chicago -> Indianapolis -> Columbus: two geocoded legs of different
  // lengths, so a fraction of the TOTAL route genuinely tests which leg the
  // cumulative-distance walk lands on, not just interpolation within one.
  const COLUMBUS = { lat: 39.9612, lng: -82.9988 };
  const CHI_STOP = { sequence: 1, lat: CHI.lat, lng: CHI.lng };
  const INDY_STOP = { sequence: 2, lat: INDY.lat, lng: INDY.lng };
  const COLUMBUS_STOP = { sequence: 3, lat: COLUMBUS.lat, lng: COLUMBUS.lng };
  const THREE_STOPS = [CHI_STOP, INDY_STOP, COLUMBUS_STOP];

  const legAB = haversineMi(CHI, INDY);
  const legBC = haversineMi(INDY, COLUMBUS);
  const total = legAB + legBC;

  /** Independent reference for the THREE-stop route: a straight lat/lng lerp
   *  (not the engine's own great-circle slerp) within whichever leg
   *  `fraction` of the route's TOTAL distance falls on. Leg selection uses
   *  the SAME real haversine leg lengths positionAlong itself computes —
   *  that partitioning is the very thing under test, not a shortcut around
   *  it — so this stays correct regardless of exactly how unequal the two
   *  legs turn out to be. */
  function expectedOnRoute(fraction: number): { lat: number; lng: number; leg: "AB" | "BC" } {
    const targetMiles = fraction * total;
    if (targetMiles <= legAB) {
      const f = legAB === 0 ? 0 : targetMiles / legAB;
      return { lat: CHI.lat + f * (INDY.lat - CHI.lat), lng: CHI.lng + f * (INDY.lng - CHI.lng), leg: "AB" };
    }
    const f = legBC === 0 ? 0 : (targetMiles - legAB) / legBC;
    return { lat: INDY.lat + f * (COLUMBUS.lat - INDY.lat), lng: INDY.lng + f * (COLUMBUS.lng - INDY.lng), leg: "BC" };
  }

  /** True when point `p` sits on the great-circle segment between `x` and
   *  `y`: the distances to both endpoints sum to the segment's own length.
   *  This is how the brief itself says to verify which leg a fraction landed
   *  on, rather than asserting exact coordinates against a slerp
   *  re-implementation. */
  function isOnLeg(p: { lat: number; lng: number }, x: { lat: number; lng: number }, y: { lat: number; lng: number }): boolean {
    return Math.abs(haversineMi(p, x) + haversineMi(p, y) - haversineMi(x, y)) < 0.5;
  }

  it("fraction 0 lands exactly on the first stop", () => {
    const p = positionAlong(THREE_STOPS, 0);
    expect(p).not.toBeNull();
    expect(haversineMi(p!, CHI)).toBeLessThan(0.01);
  });

  it("fraction 1 lands exactly on the last stop", () => {
    const p = positionAlong(THREE_STOPS, 1);
    expect(p).not.toBeNull();
    expect(haversineMi(p!, COLUMBUS)).toBeLessThan(0.01);
  });

  it("fraction 0.25 lands on the correct leg of two unequal-length legs", () => {
    const expected = expectedOnRoute(0.25);
    const p = positionAlong(THREE_STOPS, 0.25);
    expect(p).not.toBeNull();
    expect(isOnLeg(p!, CHI, INDY)).toBe(expected.leg === "AB");
    expect(isOnLeg(p!, INDY, COLUMBUS)).toBe(expected.leg === "BC");
    expect(haversineMi(p!, expected)).toBeLessThan(3);
  });

  it("fraction 0.5 lands on the correct leg of two unequal-length legs", () => {
    const expected = expectedOnRoute(0.5);
    const p = positionAlong(THREE_STOPS, 0.5);
    expect(p).not.toBeNull();
    expect(isOnLeg(p!, CHI, INDY)).toBe(expected.leg === "AB");
    expect(isOnLeg(p!, INDY, COLUMBUS)).toBe(expected.leg === "BC");
    expect(haversineMi(p!, expected)).toBeLessThan(3);
  });

  it("skips an un-geocoded intermediate stop rather than freezing there", () => {
    const ungeocodedMiddle = { sequence: 2, lat: null, lng: null };
    const p = positionAlong([CHI_STOP, ungeocodedMiddle, COLUMBUS_STOP], 0.5);
    expect(p).not.toBeNull();
    // With the middle stop skipped this is just a 2-stop CHI->COLUMBUS leg —
    // the independent linear-lerp cross-check (same tolerance reasoning as
    // expectedAlong above) proves it, rather than merely "moved somewhere".
    const expected = { lat: CHI.lat + 0.5 * (COLUMBUS.lat - CHI.lat), lng: CHI.lng + 0.5 * (COLUMBUS.lng - CHI.lng) };
    expect(haversineMi(p!, expected)).toBeLessThan(3);
  });

  it("a single geocoded stop has no measurable route: null", () => {
    const onlyOneGeocoded = [CHI_STOP, { sequence: 2, lat: null, lng: null }];
    expect(positionAlong(onlyOneGeocoded, 0.5)).toBeNull();
  });
});

describe("eastOffsetDeg", () => {
  it("converts offsetMi at a given latitude to a due-east lat/lng delta", () => {
    const { offsetLat, offsetLng } = eastOffsetDeg(41.9, 10);
    expect(offsetLat).toBe(0);
    // 10 mi / (69.17 mi-per-degree-longitude * cos(41.9°)) ~= 0.194°
    const expectedLng = 10 / (69.17 * Math.cos((41.9 * Math.PI) / 180));
    expect(offsetLng).toBeCloseTo(expectedLng, 2);
  });
});
