import request from "supertest";
import { prisma } from "../src/db.js";
import { app } from "./helpers.js";
import { haversineMi, driveMinutes } from "../src/domain/dispatch/distance.js";
import { availabilityFor } from "../src/lib/driverAvailability.js";
import { driverMetrics } from "../src/lib/driverMetrics.js";
import { laneKey, laneRunsByDriver } from "../src/lib/lanes.js";
import { scanDetention } from "../src/lib/detentionScan.js";
import {
  seedWorld, SCENARIOS, CAST, ORG_NAME, ORG_TIMEZONE, DISPATCHER_EMAIL, DISPATCHER_PASSWORD,
} from "../seed-world.mjs";

// AI Dispatch Foundation, Task 7 — the deterministic demo world. This suite
// seeds ONCE (beforeAll, scale 0.15, a fixed `now`) and every `it()` below
// reads that one world; nothing here calls resetDb(), on purpose — this
// file's entire job is asserting what seedWorld() itself put in the
// database, and a reset between assertions would erase it. seedWorld's own
// idempotent purge (seed-world/purge.mjs) is what keeps this file safe to
// run alongside every other suite in the same per-process schema (it only
// ever touches rows under its own "Great Lakes Freight Co" org).
//
// The seed at this scale still writes several thousand rows, so both the
// initial seed and the idempotency re-seed get a generous timeout.
const SEED_TIMEOUT_MS = 180_000;
const SCALE = 0.15;
const NOW_MS = Date.parse("2026-09-24T15:00:00.000Z"); // exactly on the hour already — roundDownToHour is a no-op here

// Mirrors seed-world/targets.mjs's own baseline constants (duplicated here,
// not imported, so this test's import surface stays the single seed-world.mjs
// entry point + its one seed-world.d.ts, per the task's own ruling on typing)
// — counts below are exact BY CONSTRUCTION (every count is a plain
// Math.round(baseline * scale), never a probabilistic sample), so exact
// equality is a strictly stronger check than the brief's "±10%" floor, not a
// weaker one.
const HISTORICAL_BASELINE = 3000;
const CURRENT_OPEN_BASELINE = 80;
const CURRENT_ASSIGNED_BASELINE = 80;
const CURRENT_IN_PROGRESS_BASELINE = 40;
const CURRENT_TENDERED_BASELINE = 10;
const SCENARIO_OPEN_LOADS = 8; // A B C D E F G H
const SCENARIO_IN_PROGRESS_LOADS = 6; // Ana's inbound + I J K L N
const SCENARIO_DELIVERED_LOADS = 1; // M (completed/historical, fixed regardless of scale)
const BULK_DRIVER_BASELINE = 150;

function scaled(baseline: number): number {
  return Math.round(baseline * SCALE);
}

function withinTolerance(actual: number, expected: number, pct = 0.1): boolean {
  return Math.abs(actual - expected) <= Math.max(1, expected * pct);
}

async function orgOrThrow() {
  return prisma.org.findFirstOrThrow({ where: { name: ORG_NAME } });
}

async function loadWithDetails(orgId: string, externalId: string) {
  return prisma.load.findFirstOrThrow({
    where: { orgId, externalId },
    include: { stops: { orderBy: { sequence: "asc" }, include: { appointment: true } }, assignment: true },
  });
}

async function driverByExternalId(orgId: string, externalId: string) {
  return prisma.driver.findFirstOrThrow({ where: { orgId, externalId } });
}

function castFor(code: string) {
  const found = CAST.find((c) => c.scenarioCode === code);
  if (!found) throw new Error(`no cast member for scenario ${code}`);
  return found;
}

type LoadWithDetails = Awaited<ReturnType<typeof loadWithDetails>>;
type StopWithAppointment = LoadWithDetails["stops"][number];

function stop(load: LoadWithDetails, type: "pickup" | "delivery"): StopWithAppointment {
  const found = load.stops.find((s) => s.type === type);
  if (!found) throw new Error(`load ${load.externalId} has no ${type} stop`);
  return found;
}

/** Cross-track distance (miles) of `point` from the great-circle path
 *  origin->destination — the rigorous "how far off the line" measure for
 *  scenario N, independent of exactly which fraction along the route the
 *  generator happened to use. */
function crossTrackMi(origin: { lat: number; lng: number }, destination: { lat: number; lng: number }, point: { lat: number; lng: number }): number {
  const R = 3958.7613;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const bearing = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
    const phi1 = toRad(a.lat), phi2 = toRad(b.lat), lambda1 = toRad(a.lng), lambda2 = toRad(b.lng);
    const y = Math.sin(lambda2 - lambda1) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(lambda2 - lambda1);
    return Math.atan2(y, x);
  };
  const delta13 = haversineMi(origin, point) / R;
  const theta13 = bearing(origin, point);
  const theta12 = bearing(origin, destination);
  return Math.asin(Math.sin(delta13) * Math.sin(theta13 - theta12)) * R;
}

function localClock(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const hh = parts.find((p) => p.type === "hour")!.value;
  const mm = parts.find((p) => p.type === "minute")!.value;
  return `${hh}:${mm}`;
}

function localWeekday(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
}

/** Ruling 6: "every in_progress load has ... its driver ON_LOAD" — checked
 *  through the REAL derivation (availabilityFor), not the stored row, since
 *  that is what Task 2's own callers (candidateContext, the loadboard) see. */
async function expectOnLoad(orgId: string, driverId: string): Promise<void> {
  const [view] = await availabilityFor(orgId, [driverId], NOW_MS);
  expect(view.status).toBe("ON_LOAD");
}

describe("seed-world (AI Dispatch Foundation, Task 7)", () => {
  beforeAll(async () => {
    await seedWorld(prisma, { scale: SCALE, now: NOW_MS });
  }, SEED_TIMEOUT_MS);

  it("org, dispatcher, plan, and Standard agent policy exist", async () => {
    const org = await orgOrThrow();
    expect(org.timezone).toBe(ORG_TIMEZONE);

    const dispatcher = await prisma.dispatcher.findUniqueOrThrow({ where: { email: DISPATCHER_EMAIL } });
    expect(dispatcher.orgId).toBe(org.id);

    const plan = await prisma.plan.findUniqueOrThrow({ where: { orgId: org.id } });
    expect(plan.tier).toBe("tower");

    const policy = await prisma.agentPolicy.findFirstOrThrow({ where: { orgId: org.id, name: "Standard" } });
    expect(policy.shadow).toBe(true);
    expect(policy.dispatcherEmail).toBe(DISPATCHER_EMAIL);
  });

  it("w@fleet.com can log in", async () => {
    const res = await request(app).post("/api/auth/dispatcher/login").send({ email: DISPATCHER_EMAIL, password: DISPATCHER_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.dispatcher.email).toBe(DISPATCHER_EMAIL);
    expect(typeof res.body.token).toBe("string");
  });

  it("20 customers, 3 high-priority, including Meridian Foods", async () => {
    const org = await orgOrThrow();
    const customers = await prisma.customer.findMany({ where: { orgId: org.id } });
    expect(customers).toHaveLength(20);
    const highPriority = customers.filter((c) => c.priority === "high");
    expect(highPriority).toHaveLength(3);
    const meridian = customers.find((c) => c.name === "Meridian Foods");
    expect(meridian?.priority).toBe("high");
  });

  it("driver count is the full scenario cast plus the scaled bulk population, every driver has HOS/availability/preference", async () => {
    const org = await orgOrThrow();
    const drivers = await prisma.driver.findMany({ where: { orgId: org.id } });
    expect(drivers.length).toBeGreaterThanOrEqual(CAST.length);
    expect(drivers.length).toBe(CAST.length + scaled(BULK_DRIVER_BASELINE));

    const driverIds = drivers.map((d) => d.id);
    const [hosCount, availCount, prefCount] = await Promise.all([
      prisma.hosState.count({ where: { driverId: { in: driverIds } } }),
      prisma.driverAvailability.count({ where: { driverId: { in: driverIds } } }),
      prisma.driverPreference.count({ where: { driverId: { in: driverIds } } }),
    ]);
    expect(hosCount).toBe(drivers.length);
    expect(availCount).toBe(drivers.length);
    expect(prefCount).toBe(drivers.length);
  });

  it("historical and current load counts match scale x the brief's numbers", async () => {
    const org = await orgOrThrow();
    const [delivered, open, assigned, inProgress, tendered] = await Promise.all([
      prisma.load.count({ where: { orgId: org.id, status: "delivered" } }),
      prisma.load.count({ where: { orgId: org.id, status: "open" } }),
      prisma.load.count({ where: { orgId: org.id, status: "assigned" } }),
      prisma.load.count({ where: { orgId: org.id, status: "in_progress" } }),
      prisma.load.count({ where: { orgId: org.id, status: "tendered" } }),
    ]);

    expect(delivered).toBe(scaled(HISTORICAL_BASELINE) + SCENARIO_DELIVERED_LOADS);
    expect(assigned).toBe(scaled(CURRENT_ASSIGNED_BASELINE));
    expect(tendered).toBe(scaled(CURRENT_TENDERED_BASELINE));
    expect(open).toBe(scaled(CURRENT_OPEN_BASELINE) + SCENARIO_OPEN_LOADS);
    expect(inProgress).toBe(scaled(CURRENT_IN_PROGRESS_BASELINE) + SCENARIO_IN_PROGRESS_LOADS);

    // Sanity check against the brief's own raw headline range (200-250 at
    // full scale) — a softer, human-readable confirmation on top of the
    // exact formula checks above.
    const currentTotal = open + assigned + inProgress + tendered;
    expect(withinTolerance(currentTotal, 225 * SCALE + SCENARIO_OPEN_LOADS + SCENARIO_IN_PROGRESS_LOADS, 0.25)).toBe(true);
  });

  it("every world load carries a customerId", async () => {
    const org = await orgOrThrow();
    const total = await prisma.load.count({ where: { orgId: org.id } });
    const withCustomer = await prisma.load.count({ where: { orgId: org.id, customerId: { not: null } } });
    expect(withCustomer).toBe(total);
    expect(total).toBeGreaterThan(0);
  });

  it("every scenario load carries extras.scenario with its code/title/hint (ruling 4)", async () => {
    const org = await orgOrThrow();
    for (const s of SCENARIOS) {
      const load = await prisma.load.findFirstOrThrow({ where: { orgId: org.id, externalId: s.externalId } });
      const extras = load.extras as { scenario?: { code?: string; title?: string; hint?: string } } | null;
      expect(extras?.scenario?.code).toBe(s.code);
      expect(extras?.scenario?.title).toBe(s.title);
      expect(typeof extras?.scenario?.hint).toBe("string");
    }
  });

  it("scenarios.mjs's table lists all 14 codes A-N with the verbatim externalId scheme", () => {
    expect(SCENARIOS.map((s) => s.code)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"]);
    for (const s of SCENARIOS) expect(s.externalId).toMatch(/^W-[A-Z]-[A-Z]+$/);
    const a = SCENARIOS.find((s) => s.code === "A")!;
    expect(a.externalId).toBe("W-A-RELIABLE");
    expect(a.title).toBe("Reliable driver near an uncovered load");
  });

  it("A: Milan Petrovski is AVAILABLE ~40 mi from the W-A-RELIABLE pickup, 96% on-time over 50 loads", async () => {
    const org = await orgOrThrow();
    const cast = castFor("A");
    const load = await loadWithDetails(org.id, "W-A-RELIABLE");
    expect(load.status).toBe("open");
    const pickup = stop(load, "pickup");

    const driver = await driverByExternalId(org.id, cast.externalId);
    const mi = haversineMi({ lat: driver.lastLat!, lng: driver.lastLng! }, { lat: pickup.lat!, lng: pickup.lng! });
    expect(mi).toBeGreaterThan(35);
    expect(mi).toBeLessThan(45);

    const [view] = await availabilityFor(org.id, [driver.id], NOW_MS);
    expect(view.status).toBe("AVAILABLE");

    const metrics = await driverMetrics(org.id, driver.id, NOW_MS);
    expect(metrics.completedLoads).toBe(50);
    expect(metrics.onTimeLoads).toBe(48);
    expect(metrics.onTimeRate).toBeCloseTo(0.96, 5);
  });

  it("B: Dwayne Okafor is 15 mi away with 3 no-response escalations and ~61% response rate", async () => {
    const org = await orgOrThrow();
    const cast = castFor("B");
    const load = await loadWithDetails(org.id, "W-B-CLOSER");
    expect(load.status).toBe("open");
    const pickup = stop(load, "pickup");

    const driver = await driverByExternalId(org.id, cast.externalId);
    const mi = haversineMi({ lat: driver.lastLat!, lng: driver.lastLng! }, { lat: pickup.lat!, lng: pickup.lng! });
    expect(mi).toBeGreaterThan(11);
    expect(mi).toBeLessThan(19);

    const metrics = await driverMetrics(org.id, driver.id, NOW_MS);
    expect(metrics.noResponseIncidents).toBe(3);
    expect(metrics.responseRate).not.toBeNull();
    expect(metrics.responseRate!).toBeCloseTo(11 / 18, 5);
    expect(metrics.responseRate!).toBeGreaterThan(0.55);
    expect(metrics.responseRate!).toBeLessThan(0.67);
  });

  it("C: Ana Kovacs is in_progress, plannedEnd 10:20 Detroit time, projected available in Detroit", async () => {
    const org = await orgOrThrow();
    const cast = castFor("C");
    const load = await loadWithDetails(org.id, "W-C-SOON");
    expect(load.status).toBe("open");
    const pickupAppt = stop(load, "pickup").appointment!;
    expect(localClock(pickupAppt.windowEnd, ORG_TIMEZONE)).toBe("12:00");

    const driver = await driverByExternalId(org.id, cast.externalId);
    const assignment = await prisma.assignment.findFirstOrThrow({ where: { orgId: org.id, driverId: driver.id, status: "in_progress" } });
    expect(localClock(assignment.plannedEnd, ORG_TIMEZONE)).toBe("10:20");
    expect(assignment.startedAt).not.toBeNull();
    expect(assignment.startedAt!.getTime()).toBeLessThanOrEqual(NOW_MS);
    expect(assignment.plannedEnd.getTime()).toBeGreaterThan(NOW_MS);

    const [view] = await availabilityFor(org.id, [driver.id], NOW_MS);
    expect(view.status).toBe("ON_LOAD");
    expect(view.available.city).toBe("Detroit");
  });

  it("D: Ray Delgado has exactly 90 minutes of drive time remaining", async () => {
    const org = await orgOrThrow();
    const cast = castFor("D");
    await loadWithDetails(org.id, "W-D-HOS"); // exists, open
    const driver = await driverByExternalId(org.id, cast.externalId);
    const hos = await prisma.hosState.findUniqueOrThrow({ where: { driverId: driver.id } });
    expect(hos.driveRemainingMin).toBe(90);
  });

  it("E: the load needs a Reefer; the closest driver (Tomasz Nowak) only runs Flatbed", async () => {
    const org = await orgOrThrow();
    const cast = castFor("E");
    const load = await loadWithDetails(org.id, "W-E-EQUIP");
    expect(load.requiredEquip).toBe("Reefer");
    const driver = await driverByExternalId(org.id, cast.externalId);
    expect(driver.equipmentTypes).toEqual(["Flatbed"]);
  });

  it("F: Marcus Webb has run the Chicago > Nashville lane 14 times", async () => {
    const org = await orgOrThrow();
    const cast = castFor("F");
    const load = await loadWithDetails(org.id, "W-F-LANE");
    const pickup = stop(load, "pickup");
    const delivery = stop(load, "delivery");
    const key = laneKey({ lat: pickup.lat!, lng: pickup.lng! }, { lat: delivery.lat!, lng: delivery.lng! });

    const driver = await driverByExternalId(org.id, cast.externalId);
    const runs = await laneRunsByDriver(org.id, key);
    expect(runs.get(driver.id)).toBe(14);
  });

  it("G: Lena Fischer is Grand-Rapids-based with a weekend home-time target; the load delivers there on Friday", async () => {
    const org = await orgOrThrow();
    const cast = castFor("G");
    const load = await loadWithDetails(org.id, "W-G-HOME");
    const delivery = stop(load, "delivery");
    expect(delivery.address).toContain("Grand Rapids");
    expect(localWeekday(delivery.appointment!.windowStart ?? delivery.appointment!.windowEnd, ORG_TIMEZONE)).toBe("Fri");

    const driver = await driverByExternalId(org.id, cast.externalId);
    expect(driver.homeBaseCity).toBe("Grand Rapids");
    const pref = await prisma.driverPreference.findUniqueOrThrow({ where: { driverId: driver.id } });
    expect(pref.homeTimeTarget).toBe("weekend");
  });

  it("H: Meridian Foods is high-priority and requires delay notification", async () => {
    const org = await orgOrThrow();
    const load = await loadWithDetails(org.id, "W-H-PRIORITY");
    expect(load.customerName).toBe("Meridian Foods");
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: load.customerId! } });
    expect(customer.name).toBe("Meridian Foods");
    expect(customer.priority).toBe("high");
    expect(customer.requiresDelayNotification).toBe(true);
  });

  it("I: the driver's latest ping is at least 60 min behind the plan's expected position", async () => {
    const org = await orgOrThrow();
    const load = await loadWithDetails(org.id, "W-I-LATE");
    expect(load.status).toBe("in_progress");
    const pickup = stop(load, "pickup");
    const delivery = stop(load, "delivery");
    const assignment = load.assignment!;

    const elapsedFraction = Math.min(1, Math.max(0, (NOW_MS - assignment.plannedStart.getTime()) / (assignment.plannedEnd.getTime() - assignment.plannedStart.getTime())));
    const expectedPoint = {
      lat: pickup.lat! + (delivery.lat! - pickup.lat!) * elapsedFraction,
      lng: pickup.lng! + (delivery.lng! - pickup.lng!) * elapsedFraction,
    };

    const lastPing = await prisma.driverLocation.findFirstOrThrow({ where: { driverId: assignment.driverId }, orderBy: { createdAt: "desc" } });
    const gapMi = haversineMi(expectedPoint, { lat: lastPing.latitude, lng: lastPing.longitude });
    // The brief says 90 min behind plan — a band, not a floor, so a drift in
    // either direction fails.
    expect(driveMinutes(gapMi)).toBeGreaterThanOrEqual(75);
    expect(driveMinutes(gapMi)).toBeLessThanOrEqual(105);
    await expectOnLoad(org.id, assignment.driverId);
  });

  it("J: agentEnabled, agentPill 'asked', and an open unplanned_stop anomaly", async () => {
    const org = await orgOrThrow();
    const load = await loadWithDetails(org.id, "W-J-ANOMALY");
    expect(load.status).toBe("in_progress");
    expect(load.agentEnabled).toBe(true);
    expect(load.agentPill).toBe("asked");

    const trip = await prisma.agentTrip.findFirstOrThrow({ where: { loadId: load.id } });
    const anomalies = await prisma.agentEvent.findMany({ where: { tripId: trip.id, kind: "anomaly" } });
    expect(anomalies).toHaveLength(1);
    const evidence = anomalies[0].evidence as { kind?: string; key?: string };
    expect(evidence.kind).toBe("unplanned_stop");
    await expectOnLoad(org.id, load.assignment!.driverId);
  });

  it("K: the last 4 pings are identical, spanning 25 minutes at a non-stop point; SimDriverState 'stopped'", async () => {
    const org = await orgOrThrow();
    const load = await loadWithDetails(org.id, "W-K-STOP");
    const driverId = load.assignment!.driverId;
    const pings = await prisma.driverLocation.findMany({ where: { driverId }, orderBy: { createdAt: "desc" }, take: 4 });
    expect(pings).toHaveLength(4);
    for (const p of pings) {
      expect(p.latitude).toBe(pings[0].latitude);
      expect(p.longitude).toBe(pings[0].longitude);
    }
    const spanMin = (pings[0].createdAt.getTime() - pings[3].createdAt.getTime()) / 60_000;
    expect(spanMin).toBeCloseTo(25, 1);

    const sim = await prisma.simDriverState.findUniqueOrThrow({ where: { driverId } });
    expect(sim.mode).toBe("stopped");
    await expectOnLoad(org.id, driverId);
  });

  it("L: the last ping is 70 minutes old; SimDriverState 'dark'", async () => {
    const org = await orgOrThrow();
    const load = await loadWithDetails(org.id, "W-L-DARK");
    const driverId = load.assignment!.driverId;
    const lastPing = await prisma.driverLocation.findFirstOrThrow({ where: { driverId }, orderBy: { createdAt: "desc" } });
    const ageMin = Math.round((NOW_MS - lastPing.createdAt.getTime()) / 60_000);
    expect(ageMin).toBe(70);

    const sim = await prisma.simDriverState.findUniqueOrThrow({ where: { driverId } });
    expect(sim.mode).toBe("dark");
    await expectOnLoad(org.id, driverId);
  });

  it("M: scanDetention reports a claim over 200 billable minutes at the delivery stop", async () => {
    const org = await orgOrThrow();
    const load = await loadWithDetails(org.id, "W-M-DETENTION");
    expect(load.status).toBe("delivered");

    const results = await scanDetention(org.id, NOW_MS - 400 * 24 * 60 * 60 * 1000);
    const row = results.find((r) => r.loadRef === "W-M-DETENTION");
    expect(row).toBeDefined();
    expect(row!.claim).not.toBeNull();
    expect(row!.claim!.billableMin).toBeGreaterThan(200);
  });

  it("N: the last 3 pings sit ~6 mi off the great-circle line; SimDriverState 'offroute'", async () => {
    const org = await orgOrThrow();
    const load = await loadWithDetails(org.id, "W-N-OFFROUTE");
    const pickup = stop(load, "pickup");
    const delivery = stop(load, "delivery");
    const driverId = load.assignment!.driverId;
    const pings = await prisma.driverLocation.findMany({ where: { driverId }, orderBy: { createdAt: "desc" }, take: 3 });
    expect(pings).toHaveLength(3);
    for (const p of pings) {
      const offset = Math.abs(crossTrackMi({ lat: pickup.lat!, lng: pickup.lng! }, { lat: delivery.lat!, lng: delivery.lng! }, { lat: p.latitude, lng: p.longitude }));
      // The brief says 6 mi off the line — a band, not a floor.
      expect(offset).toBeGreaterThanOrEqual(5);
      expect(offset).toBeLessThanOrEqual(7);
    }

    const sim = await prisma.simDriverState.findUniqueOrThrow({ where: { driverId } });
    expect(sim.mode).toBe("offroute");
    await expectOnLoad(org.id, driverId);
  });

  it("a second seedWorld run yields identical counts and identical scenario driver ids", async () => {
    const org = await orgOrThrow();
    const countsBefore = await Promise.all([
      prisma.driver.count({ where: { orgId: org.id } }),
      prisma.customer.count({ where: { orgId: org.id } }),
      prisma.load.count({ where: { orgId: org.id } }),
      prisma.loadStop.count({ where: { load: { orgId: org.id } } }),
      prisma.assignment.count({ where: { orgId: org.id } }),
    ]);
    const castIdsBefore = await Promise.all(CAST.map((c) => driverByExternalId(org.id, c.externalId).then((d) => d.id)));

    await seedWorld(prisma, { scale: SCALE, now: NOW_MS });

    const countsAfter = await Promise.all([
      prisma.driver.count({ where: { orgId: org.id } }),
      prisma.customer.count({ where: { orgId: org.id } }),
      prisma.load.count({ where: { orgId: org.id } }),
      prisma.loadStop.count({ where: { load: { orgId: org.id } } }),
      prisma.assignment.count({ where: { orgId: org.id } }),
    ]);
    const castIdsAfter = await Promise.all(CAST.map((c) => driverByExternalId(org.id, c.externalId).then((d) => d.id)));

    expect(countsAfter).toEqual(countsBefore);
    expect(castIdsAfter).toEqual(castIdsBefore);
  }, SEED_TIMEOUT_MS);
});
