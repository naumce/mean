import { resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { captureBaseline, feasibleIdsFromToolResult } from "../src/lib/aiHarness/baseline.js";
import { findFeasibleDrivers } from "../src/lib/dispatchTools/dispatch.js";

// Qwen Harness v0.1, Task 4 — baseline.ts: a deterministic snapshot of what
// ⚡Suggest already knows about a load, captured before a model run starts.
// The fixture below follows the same shape tests/candidate-context.test.ts
// and tests/dispatcher-suggest.test.ts already use (org + tractor + matching
// trailer + geocoded pickup/delivery stops with appointments), with one
// driver left fully-HOS-fresh (feasible) and one dropped to 30 minutes of
// remaining drive time — nowhere near enough for this lane — so it is
// blocked on HOS alone (same technique as dispatcher-suggest.test.ts's
// "nohours" driver).

beforeEach(resetDb);

const CHICAGO = { lat: 41.8781, lng: -87.6298, address: "123 Dock Rd, Chicago, IL 60601" };
const NASHVILLE = { lat: 36.1627, lng: -86.7816, address: "456 Warehouse Ave, Nashville, TN 37201" };
const FAR = new Date("2027-01-01T00:00:00.000Z");
const FRESH_HOS = { driveRemainingMin: 660, windowRemainingMin: 840, cycleRemainingMin: 4200, minutesSinceBreak: 0 };

async function seedBaselineFixture() {
  const org = await prisma.org.create({ data: { name: "Baseline Co" } });
  await prisma.tractor.create({ data: { orgId: org.id, unit: "T1", status: "active" } });
  await prisma.trailer.create({ data: { orgId: org.id, unit: "R1", type: "Reefer", status: "active" } });

  const feasible = await prisma.driver.create({
    data: {
      email: "feasible@baseline.com", passwordHash: "x", name: "Feasible Driver", orgId: org.id,
      lastLat: CHICAGO.lat, lastLng: CHICAGO.lng, hos: { create: FRESH_HOS },
    },
  });
  await prisma.driverAvailability.create({
    data: { driverId: feasible.id, source: "manual", acceptingLoads: true, availabilityStatus: "AVAILABLE" },
  });

  const blocked = await prisma.driver.create({
    data: {
      email: "blocked@baseline.com", passwordHash: "x", name: "Blocked Driver", orgId: org.id,
      lastLat: CHICAGO.lat, lastLng: CHICAGO.lng,
      hos: { create: { ...FRESH_HOS, driveRemainingMin: 30 } },
    },
  });

  const load = await prisma.load.create({
    data: {
      orgId: org.id, externalId: "L-BASE", requiredEquip: "Reefer", revenueCents: 60000, status: "open",
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

  return { org, feasible, blocked, load };
}

describe("captureBaseline", () => {
  it("captures candidates in the engine's order, feasibleDriverIds, topFeasibleDriverId, and per-row context", async () => {
    const { org, feasible, blocked, load } = await seedBaselineFixture();

    const baseline = await captureBaseline(org.id, load.id);
    expect(baseline).not.toBeNull();
    if (!baseline) return;

    expect(baseline.requiredEquip).toBe("Reefer");
    expect(baseline.note).toBeNull();
    expect(new Date(baseline.capturedAt).toString()).not.toBe("Invalid Date");

    // Engine order: feasible first, infeasible after (suggest.ts's own sort).
    expect(baseline.candidates.map((c) => c.driverId)).toEqual([feasible.id, blocked.id]);
    expect(baseline.feasibleDriverIds).toEqual([feasible.id]);
    expect(baseline.topFeasibleDriverId).toBe(feasible.id);

    const feasibleRow = baseline.candidates.find((c) => c.driverId === feasible.id);
    expect(feasibleRow).toMatchObject({ feasible: true, blockedReason: null });
    expect(feasibleRow?.score).not.toBeNull();
    expect(feasibleRow?.context).toMatchObject({
      availabilityStatus: "AVAILABLE",
      laneRuns: 0,
      hosKnown: true,
    });

    const blockedRow = baseline.candidates.find((c) => c.driverId === blocked.id);
    expect(blockedRow?.feasible).toBe(false);
    expect(blockedRow?.score).toBeNull();
    expect(typeof blockedRow?.blockedReason).toBe("string");
    expect(blockedRow?.blockedReason).toMatch(/remaining/i);
    // Still ranked and still carries context while infeasible — never hidden.
    expect(blockedRow?.context).not.toBeNull();
    expect(blockedRow?.context?.hosKnown).toBe(true);
  });

  it("returns null for a load belonging to another org", async () => {
    const { load } = await seedBaselineFixture();
    const otherOrg = await prisma.org.create({ data: { name: "Someone Else's Org" } });

    const baseline = await captureBaseline(otherOrg.id, load.id);
    expect(baseline).toBeNull();
  });

  it("returns null for a load id that does not exist", async () => {
    const { org } = await seedBaselineFixture();
    const baseline = await captureBaseline(org.id, "no-such-load");
    expect(baseline).toBeNull();
  });
});

describe("feasibleIdsFromToolResult", () => {
  it("extracts feasible driverIds from a real findFeasibleDrivers result", async () => {
    const { org, feasible, blocked, load } = await seedBaselineFixture();

    const result = await findFeasibleDrivers(org.id, load.id);
    const ids = feasibleIdsFromToolResult(result);

    expect(ids).toEqual([feasible.id]);
    expect(ids).not.toContain(blocked.id);
  });

  it("returns [] for garbage input and never throws", () => {
    expect(feasibleIdsFromToolResult(null)).toEqual([]);
    expect(feasibleIdsFromToolResult(undefined)).toEqual([]);
    expect(feasibleIdsFromToolResult("not an object")).toEqual([]);
    expect(feasibleIdsFromToolResult(42)).toEqual([]);
    expect(feasibleIdsFromToolResult([])).toEqual([]);
    expect(feasibleIdsFromToolResult({})).toEqual([]);
    expect(feasibleIdsFromToolResult({ candidates: "not-an-array" })).toEqual([]);
    expect(feasibleIdsFromToolResult({ candidates: [null, 42, "nope"] })).toEqual([]);
    expect(feasibleIdsFromToolResult({ candidates: [{ driverId: 5, feasible: true }] })).toEqual([]);
    expect(feasibleIdsFromToolResult({ candidates: [{ feasible: true }] })).toEqual([]);
    expect(feasibleIdsFromToolResult({ candidates: [{ driverId: "d1", feasible: "true" }] })).toEqual([]);
  });
});
