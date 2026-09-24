import request from "supertest";
import type { DriverPreference } from "@prisma/client";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import { seedDispatchToolsFixture } from "./dispatch-tools-fixture.js";
import {
  buildCandidateContext,
  type CandidateContextInput,
  type CandidateContextSources,
  type DriverRowForContext,
} from "../src/lib/candidateContext.js";
import { FAMILIARITY_SATURATION_RUNS, laneFamiliarity, laneKey, laneRunsByDriver } from "../src/lib/lanes.js";
import type { DriverAvailabilityView } from "../src/lib/driverAvailability.js";
import type { DriverMetrics } from "../src/lib/driverMetrics.js";

// AI Dispatch Foundation, Task 6 — candidateContext.ts enriches every
// /suggest (and /drivers/:id/next) row with availability/HOS/lane/metrics/
// preferences/qualifications, WITHOUT touching feasibility or the score in
// any way. Test 1 below is the proof: it pins the exact score/feasible/
// deadheadMi/blockedReason/order this fixture produces BEFORE Task 6 touches
// any source file, and the same assertions must still pass byte-for-byte
// after — see task-6-report.md for the before/after run.

beforeEach(resetDb);

const CHICAGO = { lat: 41.8781, lng: -87.6298, address: "123 Dock Rd, Chicago, IL 60601" };
const NASHVILLE = { lat: 36.1627, lng: -86.7816, address: "456 Warehouse Ave, Nashville, TN 37201" };
const MEMPHIS = { lat: 35.1495, lng: -90.049, address: "789 Yard St, Memphis, TN 38103" };
const FAR = new Date("2027-01-01T00:00:00.000Z");
const FRESH_HOS = { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 };
const CHICAGO_NASHVILLE_LANE = "Chicago, IL > Nashville, TN";

/**
 * One org, 3 drivers, 1 load (Reefer, Chicago -> Nashville) — the fixture the
 * task-6 brief specifies verbatim:
 *  - Driver 1: AVAILABLE (manual override), full DriverPreference (matches
 *    the load's equipment, avoids the load's own lane, willing to relocate
 *    100mi), 2 completed runs on this exact lane. Positioned AT the pickup
 *    (deadhead 0) so its score differs from Driver 3 by EXACTLY the lane-
 *    familiarity weight (DEFAULT_WEIGHTS.lane = 0.05) — nothing else varies
 *    between them.
 *  - Driver 2: an ACTIVE in_progress assignment (a different load, delivering
 *    to Memphis) that overlaps "now" — infeasible (block: overlap), but
 *    still ranked and still carries context. Its raw last ping stays at
 *    Chicago while its PROJECTED position (availability.available) is the
 *    Memphis drop, so the two visibly differ.
 *  - Driver 3: no HosState row at all (hosKnown:false), no availability/
 *    preference rows, positioned identically to Driver 1 (same deadhead,
 *    same margin) so the only scoring difference vs. Driver 1 is the lane
 *    weight.
 */
async function seedFixture() {
  const org = await prisma.org.create({ data: { name: "Acme Context" } });
  const dispatcher = await prisma.dispatcher.create({
    data: { email: "disp@ctx.com", passwordHash: "x", name: "D", orgId: org.id },
  });
  const auth = `Bearer ${signDispatcherAccess(dispatcher.id)}`;

  await prisma.tractor.create({ data: { orgId: org.id, unit: "T1", status: "active" } });
  await prisma.trailer.create({ data: { orgId: org.id, unit: "R1", type: "Reefer", status: "active" } });

  const driver1 = await prisma.driver.create({
    data: {
      email: "d1@ctx.com", passwordHash: "x", name: "Driver One", orgId: org.id,
      lastLat: CHICAGO.lat, lastLng: CHICAGO.lng, hos: { create: FRESH_HOS },
    },
  });
  await prisma.driverAvailability.create({
    data: { driverId: driver1.id, source: "manual", acceptingLoads: true, availabilityStatus: "AVAILABLE" },
  });
  await prisma.driverPreference.create({
    data: {
      driverId: driver1.id,
      preferredEquipment: ["Reefer"],
      avoidRegions: ["NY"],
      avoidLanes: [CHICAGO_NASHVILLE_LANE],
      willingToRelocateMiles: 100,
    },
  });
  // 2 completed runs for driver1 on the SAME Chicago->Nashville lane as the
  // load being ranked below (separate Load rows — history, not the load
  // itself).
  for (let i = 0; i < 2; i++) {
    const histLoad = await prisma.load.create({
      data: {
        orgId: org.id, requiredEquip: "Reefer", revenueCents: 50000, status: "delivered",
        stops: {
          create: [
            { sequence: 1, type: "pickup", address: CHICAGO.address, lat: CHICAGO.lat, lng: CHICAGO.lng },
            { sequence: 2, type: "delivery", address: NASHVILLE.address, lat: NASHVILLE.lat, lng: NASHVILLE.lng },
          ],
        },
      },
    });
    const day = 10 + i;
    await prisma.assignment.create({
      data: {
        orgId: org.id, loadId: histLoad.id, driverId: driver1.id, status: "completed",
        plannedStart: new Date(`2026-01-${day}T08:00:00.000Z`),
        plannedEnd: new Date(`2026-01-${day}T20:00:00.000Z`),
        completedAt: new Date(`2026-01-${day}T20:00:00.000Z`),
      },
    });
  }

  const driver2 = await prisma.driver.create({
    data: {
      email: "d2@ctx.com", passwordHash: "x", name: "Driver Two", orgId: org.id,
      lastLat: CHICAGO.lat, lastLng: CHICAGO.lng, lastLocationAt: new Date(),
      hos: { create: FRESH_HOS },
    },
  });
  const currentLoad = await prisma.load.create({
    data: {
      orgId: org.id, requiredEquip: "DryVan", revenueCents: 40000, status: "in_progress",
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: CHICAGO.address, lat: CHICAGO.lat, lng: CHICAGO.lng },
          { sequence: 2, type: "delivery", address: MEMPHIS.address, lat: MEMPHIS.lat, lng: MEMPHIS.lng },
        ],
      },
    },
  });
  await prisma.assignment.create({
    data: {
      orgId: org.id, loadId: currentLoad.id, driverId: driver2.id, status: "in_progress",
      plannedStart: new Date(Date.now() - 2 * 3_600_000),
      plannedEnd: new Date(Date.now() + 10 * 3_600_000),
    },
  });

  const driver3 = await prisma.driver.create({
    data: {
      email: "d3@ctx.com", passwordHash: "x", name: "Driver Three", orgId: org.id,
      lastLat: CHICAGO.lat, lastLng: CHICAGO.lng,
    },
  });

  const load = await prisma.load.create({
    data: {
      orgId: org.id, externalId: "L-CTX", requiredEquip: "Reefer", revenueCents: 60000, status: "open",
      stops: {
        create: [
          {
            sequence: 1, type: "pickup", address: CHICAGO.address, lat: CHICAGO.lat, lng: CHICAGO.lng,
            appointment: { create: { windowEnd: FAR, type: "pickup" } },
          },
          {
            sequence: 2, type: "delivery", address: NASHVILLE.address, lat: NASHVILLE.lat, lng: NASHVILLE.lng,
            appointment: { create: { windowEnd: FAR, type: "delivery" } },
          },
        ],
      },
    },
  });

  return { org, auth, driver1, driver2, driver3, load, currentLoad };
}

describe("pinned /suggest scores (Task 6 must not change these)", () => {
  it("scores, feasibility, deadhead, blockedReason and order are exactly this, before and after Task 6", async () => {
    const { auth, load, driver1, driver2, driver3 } = await seedFixture();
    const res = await request(app).get(`/api/dispatcher/suggest?loadId=${load.id}`).set("authorization", auth);
    expect(res.status).toBe(200);

    const rows = res.body.candidates as Array<{
      driverId: string; feasible: boolean; score: number | null; deadheadMi: number; blockedReason?: string;
    }>;
    // Driver One beats Driver Three by EXACTLY the lane-familiarity weight
    // (same position, same margin, same clocks otherwise) — Driver Two is
    // infeasible (overlap) and sorts last regardless of its own deadhead.
    expect(rows.map((r) => r.driverId)).toEqual([driver1.id, driver3.id, driver2.id]);

    expect(rows[0]).toMatchObject({ driverId: driver1.id, feasible: true, score: 53, deadheadMi: 0 });
    expect(rows[0].blockedReason).toBeUndefined();

    expect(rows[1]).toMatchObject({ driverId: driver3.id, feasible: true, score: 49, deadheadMi: 0 });
    expect(rows[1].blockedReason).toBeUndefined();

    expect(rows[2]).toMatchObject({
      driverId: driver2.id, feasible: false, score: null, deadheadMi: 0,
      blockedReason: "Driver already committed in this window",
    });
  });
});

describe("context on every /suggest row", () => {
  it("driver 1 (AVAILABLE, full preferences, 2 lane runs): every context field is correct", async () => {
    const { auth, load, driver1 } = await seedFixture();
    const res = await request(app).get(`/api/dispatcher/suggest?loadId=${load.id}`).set("authorization", auth);
    const row = res.body.candidates.find((c: { driverId: string }) => c.driverId === driver1.id);
    const ctx = row.context;

    expect(ctx.availability.status).toBe("AVAILABLE");
    expect(ctx.hosRemaining).toEqual({ driveMin: 660, windowMin: 840, known: true });
    expect(ctx.lane).toEqual({ key: expect.any(String), label: "Chicago, IL > Nashville, TN" });
    expect(ctx.laneRuns).toBe(2);
    // deadheadMi is 0 for this driver (positioned at the pickup) — arrival is
    // exactly its availableAt plus zero drive time.
    expect(ctx.estimatedArrivalAtPickupMs).toBe(ctx.availability.availableAt);
    expect(ctx.homeTime.withinRelocate).toBe(true); // deadhead 0 <= willingToRelocateMiles 100
    expect(ctx.preferences).toMatchObject({
      preferredEquipment: ["Reefer"],
      matchesEquipmentPref: true,
      laneAvoided: true, // avoidLanes contains this exact "Chicago, IL > Nashville, TN" label
      regionAvoided: false, // avoidRegions is ["NY"]; this lane is IL/TN
    });
    expect(ctx.qualifications).toEqual({ equipmentTypes: [], endorsements: [], hazmatEndorsed: false });
  });

  it("driver 2 (active assignment): ON_LOAD, projected location differs from the raw ping, still carries context while infeasible", async () => {
    const { auth, load, driver2, currentLoad } = await seedFixture();
    const res = await request(app).get(`/api/dispatcher/suggest?loadId=${load.id}`).set("authorization", auth);
    const row = res.body.candidates.find((c: { driverId: string }) => c.driverId === driver2.id);
    const ctx = row.context;

    // Still ranked and still carries context despite being infeasible
    // (overlap) — a blocked driver is never hidden, and neither is their
    // context.
    expect(row.feasible).toBe(false);
    expect(ctx).toBeTruthy();

    expect(ctx.availability.status).toBe("ON_LOAD");
    expect(ctx.availability.available.city).toBe("Memphis"); // the projected (future) drop
    expect(ctx.availability.current).toMatchObject({ lat: CHICAGO.lat, lng: CHICAGO.lng }); // the raw current ping
    expect(ctx.availability.available.lat).not.toBe(ctx.availability.current.lat); // projected != current
    expect(ctx.availability.currentAssignment.loadId).toBe(currentLoad.id);
    // deadheadMi is 0 here too -> arrival is exactly availableAt (the load's planned end).
    expect(ctx.estimatedArrivalAtPickupMs).toBe(ctx.availability.availableAt);
    expect(ctx.hosRemaining.known).toBe(true);
  });

  it("driver 3 (no HosState row): hosKnown false, no preferences row, no lane history", async () => {
    const { auth, load, driver3 } = await seedFixture();
    const res = await request(app).get(`/api/dispatcher/suggest?loadId=${load.id}`).set("authorization", auth);
    const row = res.body.candidates.find((c: { driverId: string }) => c.driverId === driver3.id);
    const ctx = row.context;

    expect(row.hosKnown).toBe(false);
    expect(ctx.hosRemaining).toEqual({ driveMin: null, windowMin: null, known: false });
    expect(ctx.preferences).toBeNull();
    expect(ctx.laneRuns).toBe(0);
    expect(ctx.homeTime.withinRelocate).toBeNull(); // no preferences row at all
  });
});

describe("GET /loads/:id/candidates/:driverId", () => {
  it("200s with candidate.context for a real candidate", async () => {
    const { orgA, l1, d1 } = await seedDispatchToolsFixture();
    const disp = await prisma.dispatcher.create({ data: { email: "detail@ctx.com", passwordHash: "x", name: "D", orgId: orgA.id } });
    const auth = `Bearer ${signDispatcherAccess(disp.id)}`;

    const res = await request(app)
      .get(`/api/dispatcher/loads/${l1.id}/candidates/${d1.id}`)
      .set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ loadId: l1.id, driverId: d1.id, candidate: { driverId: d1.id } });
    expect(res.body.candidate.context).toBeTruthy();
  });

  it("404s for a load belonging to another org", async () => {
    const { orgA, lB1, d1 } = await seedDispatchToolsFixture();
    const disp = await prisma.dispatcher.create({ data: { email: "detail2@ctx.com", passwordHash: "x", name: "D", orgId: orgA.id } });
    const auth = `Bearer ${signDispatcherAccess(disp.id)}`;

    const res = await request(app)
      .get(`/api/dispatcher/loads/${lB1.id}/candidates/${d1.id}`)
      .set("authorization", auth);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });

  it("404s for a driver that is not in the org (not among the load's candidates)", async () => {
    const { orgA, l1, dB1 } = await seedDispatchToolsFixture();
    const disp = await prisma.dispatcher.create({ data: { email: "detail3@ctx.com", passwordHash: "x", name: "D", orgId: orgA.id } });
    const auth = `Bearer ${signDispatcherAccess(disp.id)}`;

    const res = await request(app)
      .get(`/api/dispatcher/loads/${l1.id}/candidates/${dB1.id}`)
      .set("authorization", auth);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });
});

// ---------------------------------------------------------------------------
// buildCandidateContext: pure unit cases (no DB) — every source hand-built
// so each edge case is isolated instead of riding on the HTTP fixture above.
// ---------------------------------------------------------------------------

describe("buildCandidateContext (pure unit cases)", () => {
  const NEW_YORK = { lat: 40.7128, lng: -74.006, address: "1 Broadway, New York, NY 10004" };

  const baseAvailability: DriverAvailabilityView = {
    driverId: "d1",
    acceptingLoads: true,
    locationSharingEnabled: false,
    locationSharingUpdatedAt: null,
    shareToken: null,
    status: "AVAILABLE",
    availableAt: 1_000_000,
    available: { lat: null, lng: null, city: null, state: null },
    current: null,
    currentAssignment: null,
    source: "none",
  };
  const baseMetrics: DriverMetrics = {
    driverId: "d1", asOf: new Date(0), completedLoads: 0, onTimeLoads: 0, lateLoads: 0, onTimeRate: null,
    averageDelayMinutes: null, averageDetentionMinutes: null, averageResponseMinutes: null, responseRate: null,
    noResponseIncidents: 0, breakdownIncidents: 0, accidentIncidents: 0, loadsLast30Days: 0, nightLoads: 0,
    laneExperience: [], evidence: { assignments: 0, agentTrips: 0, agentEvents: 0 },
  };
  const baseDriver: DriverRowForContext = {
    homeBaseCity: null, homeBaseState: null, equipmentTypes: [], endorsements: [], hazmatEndorsed: false, hos: null,
  };

  function makePreference(overrides: Partial<DriverPreference> = {}): DriverPreference {
    return {
      driverId: "d1", maxTripMiles: null, preferredRegions: [], preferredLanes: [],
      avoidRegions: [], avoidLanes: [], homeTimeTarget: null, willingToDriveNight: true,
      willingToRelocateMiles: null, preferredEquipment: [], updatedAt: new Date(0),
      ...overrides,
    };
  }

  function makeSources(overrides: {
    driver?: DriverRowForContext;
    preference?: DriverPreference | null;
    laneRuns?: number;
  } = {}): CandidateContextSources {
    const preferences = new Map<string, DriverPreference>();
    if (overrides.preference) preferences.set("d1", overrides.preference);
    return {
      availability: new Map([["d1", baseAvailability]]),
      metrics: new Map([["d1", baseMetrics]]),
      preferences,
      drivers: new Map([["d1", overrides.driver ?? baseDriver]]),
      laneRuns: () => overrides.laneRuns ?? 0,
    };
  }

  it("no lane key: laneRuns is 0 and lane.label is null (never even asks `sources.laneRuns`)", () => {
    // laneRuns would answer 5 if it were ever called with a real key — proving
    // buildCandidateContext itself short-circuits to 0 on a null key, rather
    // than happening to receive 0 from the sources.
    const sources = makeSources({ laneRuns: 5 });
    const load: CandidateContextInput = {
      requiredEquip: "DryVan",
      stops: [
        { type: "pickup", address: "Unknown Yard", lat: null, lng: null },
        { type: "delivery", address: "Unknown Dock", lat: null, lng: null },
      ],
    };
    const ctx = buildCandidateContext(sources, load, { driverId: "d1", deadheadMi: 10 });
    expect(ctx.lane).toEqual({ key: null, label: null });
    expect(ctx.laneRuns).toBe(0);
  });

  it("fix round 1: valid pickup/delivery coordinates but an unparseable address — lane.key is non-null, lane.label is null", () => {
    // Distinguishes "no coordinates" (the case above, both null) from "have
    // coordinates but can't build a City/ST label" — laneOfContextStops must
    // compute `key` from lat/lng alone, independent of whether the address
    // text parses.
    const sources = makeSources({ laneRuns: 3 });
    const load: CandidateContextInput = {
      requiredEquip: "DryVan",
      stops: [
        { type: "pickup", address: "Dock 7", lat: CHICAGO.lat, lng: CHICAGO.lng }, // valid coords, no "City, ST" in the text
        { type: "delivery", address: NASHVILLE.address, lat: NASHVILLE.lat, lng: NASHVILLE.lng },
      ],
    };
    const ctx = buildCandidateContext(sources, load, { driverId: "d1", deadheadMi: 10 });
    expect(ctx.lane.key).not.toBeNull();
    expect(ctx.lane.label).toBeNull();
    // A null label can never match an avoidLanes entry, and laneRuns still
    // resolves normally off the real key.
    expect(ctx.laneRuns).toBe(3);
  });

  it("unknown home base: deliveryToHomeMi is null", () => {
    const sources = makeSources({ driver: { ...baseDriver, homeBaseCity: "Nowhereville", homeBaseState: "ZZ" } });
    const load: CandidateContextInput = {
      requiredEquip: "DryVan",
      stops: [
        { type: "pickup", address: CHICAGO.address, lat: CHICAGO.lat, lng: CHICAGO.lng },
        { type: "delivery", address: NASHVILLE.address, lat: NASHVILLE.lat, lng: NASHVILLE.lng },
      ],
    };
    const ctx = buildCandidateContext(sources, load, { driverId: "d1", deadheadMi: 10 });
    expect(ctx.homeTime.deliveryToHomeMi).toBeNull();
    expect(ctx.homeTime.homeBaseCity).toBe("Nowhereville");
  });

  it("willingToRelocateMiles null: withinRelocate is null even though a preferences row exists", () => {
    const sources = makeSources({ preference: makePreference({ willingToRelocateMiles: null }) });
    const load: CandidateContextInput = {
      requiredEquip: "DryVan",
      stops: [
        { type: "pickup", address: CHICAGO.address, lat: CHICAGO.lat, lng: CHICAGO.lng },
        { type: "delivery", address: NASHVILLE.address, lat: NASHVILLE.lat, lng: NASHVILLE.lng },
      ],
    };
    const ctx = buildCandidateContext(sources, load, { driverId: "d1", deadheadMi: 10 });
    expect(ctx.preferences).not.toBeNull();
    expect(ctx.homeTime.withinRelocate).toBeNull();
  });

  it("region/lane matching is case-insensitive", () => {
    const sources = makeSources({
      preference: makePreference({ avoidRegions: ["ny"], avoidLanes: ["  chicago, il > new york, ny  "] }),
    });
    const load: CandidateContextInput = {
      requiredEquip: "DryVan",
      stops: [
        { type: "pickup", address: CHICAGO.address, lat: CHICAGO.lat, lng: CHICAGO.lng },
        { type: "delivery", address: NEW_YORK.address, lat: NEW_YORK.lat, lng: NEW_YORK.lng },
      ],
    };
    const ctx = buildCandidateContext(sources, load, { driverId: "d1", deadheadMi: 10 });
    expect(ctx.lane.label).toBe("Chicago, IL > New York, NY");
    expect(ctx.preferences?.regionAvoided).toBe(true);
    expect(ctx.preferences?.laneAvoided).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// laneRunsByDriver / laneFamiliarity agreement (Task 6 split the counting out
// of laneFamiliarity; the saturation math must still land on the same score).
// ---------------------------------------------------------------------------

describe("laneRunsByDriver / laneFamiliarity", () => {
  it("laneFamiliarity's score is laneRunsByDriver's own count run through the saturation formula", async () => {
    const org = await prisma.org.create({ data: { name: "Lane Agreement Co" } });
    const driver = await prisma.driver.create({
      data: { email: "lane@x.com", passwordHash: "x", name: "Lane Driver", orgId: org.id },
    });

    for (let i = 0; i < 2; i++) {
      const day = i + 1;
      const histLoad = await prisma.load.create({
        data: {
          orgId: org.id, requiredEquip: "DryVan", revenueCents: 50000, status: "delivered",
          stops: {
            create: [
              { sequence: 1, type: "pickup", address: CHICAGO.address, lat: CHICAGO.lat, lng: CHICAGO.lng },
              { sequence: 2, type: "delivery", address: NASHVILLE.address, lat: NASHVILLE.lat, lng: NASHVILLE.lng },
            ],
          },
        },
      });
      await prisma.assignment.create({
        data: {
          orgId: org.id, loadId: histLoad.id, driverId: driver.id, status: "completed",
          plannedStart: new Date(`2026-03-0${day}T08:00:00.000Z`),
          plannedEnd: new Date(`2026-03-0${day}T20:00:00.000Z`),
          completedAt: new Date(`2026-03-0${day}T20:00:00.000Z`),
        },
      });
    }

    const key = laneKey(CHICAGO, NASHVILLE);
    const runs = await laneRunsByDriver(org.id, key);
    const familiarity = await laneFamiliarity(org.id, key);

    expect(runs.get(driver.id)).toBe(2);
    expect(familiarity.get(driver.id)).toBeCloseTo(2 / FAMILIARITY_SATURATION_RUNS, 10);
  });

  it("both return an empty Map for a null key", async () => {
    const org = await prisma.org.create({ data: { name: "Null Key Co" } });
    expect((await laneRunsByDriver(org.id, null)).size).toBe(0);
    expect((await laneFamiliarity(org.id, null)).size).toBe(0);
  });
});
