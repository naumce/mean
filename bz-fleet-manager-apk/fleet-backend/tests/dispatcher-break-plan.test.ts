import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import { evaluate } from "../src/domain/dispatch/evaluate.js";
import { UNKNOWN_HOS } from "../src/domain/dispatch/mapper.js";
import { COVERAGE_RADIUS_MI, REST_SEARCH_RADIUS_MI } from "../src/domain/dispatch/index.js";
import type { GeoPoint } from "../src/domain/dispatch/types.js";

// T3 Break and Rest Planning, Task 7 — wiring plan.breaks + rankRestOptions +
// restConflict into the assignment verdict (POST /assignments, dry-run and
// commit). PATCH /assignments/:id/plan gets the identical wiring (see
// task-7-brief.md), but its own suite (assignment-plan.test.ts) already
// exercises the replan path end to end; this file is the one place the
// breakPlan/breakPlanKnown CONTRACT itself is asserted.

beforeEach(resetDb);

async function dispatcherAuth(email = "d@x.com") {
  const disp = await prisma.dispatcher.create({ data: { email, passwordHash: "x", name: "D" } });
  return `Bearer ${signDispatcherAccess(disp.id)}`;
}

const KC = { lat: 39.0997, lng: -94.5786 };
// KC -> Columbia MO: ~145 road mi, ~173 driving min. Short enough that a
// rested driver (minutesSinceBreak: 0) needs no break at all — see
// tests/engine-breakpoints.test.ts, which this geometry is copied from.
const COLUMBIA = { lat: 38.9517, lng: -92.3341 };
// KC -> Memphis: ~444 road mi, ~533 driving min — crosses the 480-min
// threshold even from a driver with NOTHING banked, which is what makes it
// the only usable geometry for the "HOS never imported" case (Ruling 6):
// UNKNOWN_HOS assumes fresh (0 banked) clocks, and the short KC->Columbia
// haul would never trigger a break under that assumption.
const MEMPHIS = { lat: 35.1495, lng: -90.049 };
const FAR = new Date("2027-01-01T00:00:00.000Z");

const MI_PER_DEG_LAT = 69.09; // exact under the engine's spherical model (distance.ts)

/** The exact geographic position the engine will place a break at, computed
 *  with the SAME pure function the route calls (Global Constraint 2 — one
 *  definition, not a second one) so tests never guess coordinates. The break
 *  location depends only on geometry + minutesSinceBreak, never on wall-clock
 *  time, so this is safe to compute independently of the HTTP call. */
function predictedBreakAt(delivery: GeoPoint, hos = { ...UNKNOWN_HOS }): GeoPoint {
  const result = evaluate(
    {
      requiredEquip: "DryVan",
      stops: [
        { sequence: 1, type: "pickup", location: KC },
        { sequence: 2, type: "delivery", location: delivery },
      ],
    },
    { status: "active", hazmatEndorsed: false, availableAt: Date.now(), location: KC, hos },
    { status: "active" },
    { type: "DryVan", status: "active" },
  );
  const bp = result.plan.breaks[0];
  if (!bp?.at) throw new Error("test fixture error: expected geometry to produce a positioned break");
  return bp.at;
}

async function seed(
  opts: { minutesSinceBreak?: number; driverHos?: boolean; delivery?: GeoPoint } = {},
) {
  const org = await prisma.org.create({ data: { name: "Acme Fleet" } });
  const delivery = opts.delivery ?? COLUMBIA;
  const driver = await prisma.driver.create({
    data: {
      email: "drv@x.com", passwordHash: "x", name: "Jake", orgId: org.id,
      hazmatEndorsed: false, lastLat: KC.lat, lastLng: KC.lng,
      ...(opts.driverHos === false
        ? {}
        : {
            hos: {
              create: {
                driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200,
                minutesSinceBreak: opts.minutesSinceBreak ?? 0,
              },
            },
          }),
    },
  });
  const tractor = await prisma.tractor.create({ data: { orgId: org.id, unit: "1207", status: "active" } });
  const trailer = await prisma.trailer.create({ data: { orgId: org.id, unit: "RF-1", type: "DryVan", status: "active" } });
  const load = await prisma.load.create({
    data: {
      orgId: org.id, requiredEquip: "DryVan", revenueCents: 30000, fscCents: 4000, status: "open",
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: "KC dock", lat: KC.lat, lng: KC.lng,
            appointment: { create: { windowEnd: FAR, type: "pickup" } } },
          { sequence: 2, type: "delivery", address: "Delivery dock", lat: delivery.lat, lng: delivery.lng,
            appointment: { create: { windowEnd: FAR, type: "delivery" } } },
        ],
      },
    },
  });
  return { org, driver, tractor, trailer, load };
}

it("a dry-run whose plan needs no break returns breakPlan: []", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed({ minutesSinceBreak: 0 });

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id, dryRun: true });

  expect(res.status).toBe(200);
  expect(res.body.feasible).toBe(true);
  expect(res.body.plan.needsBreak).toBe(false);
  expect(res.body.breakPlanKnown).toBe(true);
  expect(res.body.breakPlan).toEqual([]);
});

it("a plan needing one break returns one entry with ranked options", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed({ minutesSinceBreak: 420 });
  const breakAt = predictedBreakAt(COLUMBIA, {
    driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 420,
  });
  const stop = await prisma.restStop.create({
    data: { orgId: load.orgId, name: "Right There", kind: "truck_stop", lat: breakAt.lat, lng: breakAt.lng },
  });

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id, dryRun: true });

  expect(res.status).toBe(200);
  expect(res.body.feasible).toBe(true);
  expect(res.body.breakPlanKnown).toBe(true);
  expect(res.body.breakPlan).toHaveLength(1);
  const entry = res.body.breakPlan[0];
  expect(entry.hasCoverage).toBe(true);
  expect(entry.precision).toBe("estimated"); // no ROUTER_URL in the test env
  expect(entry.options).toHaveLength(1);
  expect(entry.options[0].id).toBe(stop.id);
});

it("an org with no rest stops leaves feasible unchanged", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed({ minutesSinceBreak: 420 });
  // Deliberately no RestStop rows for this org anywhere.

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id, dryRun: true });

  expect(res.status).toBe(200);
  // Absent must never render as measured (Global Constraint 1): with no data
  // at all about this corridor, restConflict() is silent, so feasibility is
  // exactly what it was before this task existed.
  expect(res.body.feasible).toBe(true);
  expect(res.body.conflicts.some((c: { kind: string }) => c.kind === "no_rest")).toBe(false);
  expect(res.body.breakPlan).toHaveLength(1);
  const entry = res.body.breakPlan[0];
  expect(entry.hasCoverage).toBe(false);
  expect(entry.options).toEqual([]);
});

it("an org with coverage but a dry break point returns feasible: false with a no_rest conflict", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed({ minutesSinceBreak: 420 });
  const breakAt = predictedBreakAt(COLUMBIA, {
    driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 420,
  });
  // ~55 mi off the break point: inside COVERAGE_RADIUS_MI (150 mi, so the org
  // clearly HAS data about this corridor) but outside REST_SEARCH_RADIUS_MI
  // (35 mi, so it is not an option the driver can actually use for THIS break).
  const farLat = breakAt.lat + (REST_SEARCH_RADIUS_MI + 20) / MI_PER_DEG_LAT;
  expect(REST_SEARCH_RADIUS_MI + 20).toBeLessThan(COVERAGE_RADIUS_MI);
  await prisma.restStop.create({
    data: { orgId: load.orgId, name: "Too Far To Use", kind: "truck_stop", lat: farLat, lng: breakAt.lng },
  });

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id, dryRun: true });

  expect(res.status).toBe(200);
  expect(res.body.feasible).toBe(false);
  const conflict = res.body.conflicts.find((c: { kind: string }) => c.kind === "no_rest");
  expect(conflict).toBeDefined();
  expect(conflict.severity).toBe("block");
  expect(res.body.breakPlan).toHaveLength(1);
  expect(res.body.breakPlan[0].hasCoverage).toBe(true);
  expect(res.body.breakPlan[0].options).toEqual([]);
});

it("force: true overrides a no_rest block and commits", async () => {
  const auth = await dispatcherAuth();
  const { load, driver, tractor, trailer } = await seed({ minutesSinceBreak: 420 });
  const breakAt = predictedBreakAt(COLUMBIA, {
    driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 420,
  });
  const farLat = breakAt.lat + (REST_SEARCH_RADIUS_MI + 20) / MI_PER_DEG_LAT;
  await prisma.restStop.create({
    data: { orgId: load.orgId, name: "Too Far To Use", kind: "truck_stop", lat: farLat, lng: breakAt.lng },
  });

  // Without force: refused.
  const blocked = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id });
  expect(blocked.status).toBe(422);
  expect(blocked.body.conflicts.some((c: { kind: string }) => c.kind === "no_rest")).toBe(true);
  expect(await prisma.assignment.findUnique({ where: { loadId: load.id } })).toBeNull();

  // no_rest is advisory-about-the-world (we lack import data), not physics
  // like an overlap — force lets the dispatcher proceed anyway.
  const forced = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id, force: true });
  expect(forced.status).toBe(201);
  expect(forced.body.forced).toBe(true);
  expect(forced.body.conflicts.some((c: { kind: string }) => c.kind === "no_rest")).toBe(true);
  const persisted = await prisma.assignment.findUnique({ where: { loadId: load.id } });
  expect(persisted).not.toBeNull();
  const persistedConflict = await prisma.dispatchConflict.findFirst({ where: { loadId: load.id, kind: "no_rest" } });
  expect(persistedConflict).not.toBeNull();
});

it("Ruling 6: a driver with no HOS import gets breakPlanKnown: false, no no_rest conflict, and feasible unchanged", async () => {
  const auth = await dispatcherAuth();
  // Long haul so even the ASSUMED-fresh clocks (UNKNOWN_HOS, minutesSinceBreak
  // 0) cross the 480-min threshold — otherwise this test could pass by
  // accident (no break at all) rather than by the Ruling 6 gate actually
  // suppressing coverage lookups on a break that WOULD otherwise exist.
  const { load, driver, tractor, trailer } = await seed({ driverHos: false, delivery: MEMPHIS });
  expect(await prisma.hosState.findUnique({ where: { driverId: driver.id } })).toBeNull();

  const breakAt = predictedBreakAt(MEMPHIS); // uses UNKNOWN_HOS by default
  // Coverage genuinely exists near the (unimported-driver's) break point —
  // if Ruling 6's gate were missing, this would be exactly the setup that
  // raises a no_rest block, so its absence here is a real assertion, not a
  // vacuous one.
  const farLat = breakAt.lat + (REST_SEARCH_RADIUS_MI + 20) / MI_PER_DEG_LAT;
  await prisma.restStop.create({
    data: { orgId: load.orgId, name: "Too Far To Use", kind: "truck_stop", lat: farLat, lng: breakAt.lng },
  });

  const res = await request(app).post("/api/dispatcher/assignments").set("authorization", auth)
    .send({ loadId: load.id, driverId: driver.id, tractorId: tractor.id, trailerId: trailer.id, dryRun: true });

  expect(res.status).toBe(200);
  // The plan DOES cross the break threshold under the full-hours assumption —
  // proving the empty breakPlan below is the Ruling 6 gate, not a load that
  // never needed a break in the first place.
  expect(res.body.plan.needsBreak).toBe(true);
  expect(res.body.breakPlanKnown).toBe(false);
  expect(res.body.breakPlan).toEqual([]);
  expect(res.body.conflicts.some((c: { kind: string }) => c.kind === "no_rest")).toBe(false);
  // feasible unchanged: still just the pre-existing "HOS not imported" warn,
  // which never blocks.
  expect(res.body.feasible).toBe(true);
  expect(res.body.conflicts.some((c: { kind: string; severity: string }) => c.kind === "hos" && c.severity === "warn")).toBe(true);
});
