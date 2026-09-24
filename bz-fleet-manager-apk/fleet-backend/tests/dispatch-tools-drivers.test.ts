import { resetDb } from "./helpers.js";
import {
  getDriver,
  searchDrivers,
  getAvailableDrivers,
  getDriverAvailability,
  getDriverMetrics,
  getDriverHistory,
  getDriverLocationHistory,
} from "../src/lib/dispatchTools/index.js";
import { seedDispatchToolsFixture, NOW_MS, HOUR } from "./dispatch-tools-fixture.js";

// AI Dispatch Foundation, Task 5 — the driver-centric half of the read-only
// tool boundary. See dispatch-tools-fixture.ts's own header for the shared
// scenario (D1 AVAILABLE+accepting, D2 ON_LOAD via an active assignment, D3
// has a completed assignment + agent trip).

beforeEach(resetDb);

describe("getDriver", () => {
  it("returns profile fields plus availability, no metrics", async () => {
    const { orgA, d1 } = await seedDispatchToolsFixture();
    const driver = await getDriver(orgA.id, d1.id);

    expect(driver).toMatchObject({
      id: d1.id,
      name: "Available Driver",
      firstName: "Ava",
      lastName: "Ilable",
      cdlClass: "A",
      hazmatEndorsed: true,
      equipmentTypes: ["DryVan", "Reefer"],
      languages: ["en", "es"],
      preferredLanguage: "en",
      homeBaseCity: "Kansas City",
      homeBaseState: "MO",
      yearsExperience: 5,
    });
    expect(driver!.hos).not.toBeNull();
    expect(driver!.availability).toMatchObject({ status: "AVAILABLE", acceptingLoads: true });
  });

  it("returns null for a missing id or one belonging to another org", async () => {
    const { orgA, dB1 } = await seedDispatchToolsFixture();
    expect(await getDriver(orgA.id, dB1.id)).toBeNull();
    expect(await getDriver(orgA.id, "does-not-exist")).toBeNull();
  });
});

describe("searchDrivers", () => {
  it("filters by equipment (equipmentTypes has)", async () => {
    const { orgA, d1 } = await seedDispatchToolsFixture();
    const rows = await searchDrivers(orgA.id, { equipment: "Reefer" });
    expect(rows.map((r) => r.id)).toEqual([d1.id]);
  });

  it("filters by language (languages has OR preferredLanguage)", async () => {
    const { orgA, d1 } = await seedDispatchToolsFixture();
    const rows = await searchDrivers(orgA.id, { language: "es" });
    expect(rows.map((r) => r.id)).toEqual([d1.id]);
  });

  it("filters by state (homeBaseState)", async () => {
    const { orgA, d2 } = await seedDispatchToolsFixture();
    const rows = await searchDrivers(orgA.id, { state: "KS" });
    expect(rows.map((r) => r.id)).toEqual([d2.id]);
  });

  it("filters by availability status", async () => {
    const { orgA, d2 } = await seedDispatchToolsFixture();
    const rows = await searchDrivers(orgA.id, { status: "ON_LOAD" });
    expect(rows.map((r) => r.id)).toEqual([d2.id]);
  });

  it("filters by acceptingLoads", async () => {
    const { orgA, d1 } = await seedDispatchToolsFixture();
    const rows = await searchDrivers(orgA.id, { acceptingLoads: true });
    expect(rows.map((r) => r.id)).toEqual([d1.id]);
  });

  it("clamps to `limit`", async () => {
    const { orgA } = await seedDispatchToolsFixture();
    const rows = await searchDrivers(orgA.id, { limit: 1 });
    expect(rows).toHaveLength(1);
  });

  it("never returns another org's drivers", async () => {
    const { orgB, dB1 } = await seedDispatchToolsFixture();
    const rows = await searchDrivers(orgB.id, {});
    expect(rows.map((r) => r.id)).toEqual([dB1.id]);
  });
});

describe("getAvailableDrivers", () => {
  it("returns only AVAILABLE/AVAILABLE_SOON + accepting drivers", async () => {
    const { orgA, d1 } = await seedDispatchToolsFixture();
    const rows = await getAvailableDrivers(orgA.id);
    expect(rows.map((r) => r.driverId)).toEqual([d1.id]);
    expect(rows[0]).toMatchObject({ status: "AVAILABLE", acceptingLoads: true });
  });

  it("never leaks another org's drivers", async () => {
    const { orgB, dB1 } = await seedDispatchToolsFixture();
    // dB1 has no DriverAvailability row and no assignment -> UNAVAILABLE, so
    // org B's own list is empty; the assertion that matters is that org A's
    // available driver never appears here regardless.
    const rows = await getAvailableDrivers(orgB.id);
    expect(rows.some((r) => r.driverId !== dB1.id)).toBe(false);
  });
});

describe("getDriverAvailability", () => {
  it("returns the ON_LOAD view for a driver with an active assignment", async () => {
    const { orgA, d2, l3 } = await seedDispatchToolsFixture();
    const view = await getDriverAvailability(orgA.id, d2.id);
    expect(view).toMatchObject({ driverId: d2.id, status: "ON_LOAD" });
    expect(view!.currentAssignment?.loadId).toBe(l3.id);
  });

  it("returns null for a driver belonging to another org", async () => {
    const { orgA, dB1 } = await seedDispatchToolsFixture();
    expect(await getDriverAvailability(orgA.id, dB1.id)).toBeNull();
  });
});

describe("getDriverMetrics", () => {
  it("returns evidence-derived metrics for a driver with a completed load", async () => {
    const { orgA, d3 } = await seedDispatchToolsFixture();
    const metrics = await getDriverMetrics(orgA.id, d3.id);
    expect(metrics).toMatchObject({ driverId: d3.id, completedLoads: 1 });
  });

  it("returns null for a missing id or one belonging to another org", async () => {
    const { orgA, dB1 } = await seedDispatchToolsFixture();
    expect(await getDriverMetrics(orgA.id, dB1.id)).toBeNull();
    expect(await getDriverMetrics(orgA.id, "does-not-exist")).toBeNull();
  });
});

describe("getDriverHistory", () => {
  it("returns the driver's completed assignments", async () => {
    const { orgA, d3, l4 } = await seedDispatchToolsFixture();
    const rows = await getDriverHistory(orgA.id, d3.id);
    expect(rows!.map((r) => r.loadId)).toEqual([l4.id]);
  });

  it("returns null for a driver belonging to another org", async () => {
    const { orgA, dB1 } = await seedDispatchToolsFixture();
    expect(await getDriverHistory(orgA.id, dB1.id)).toBeNull();
  });
});

describe("getDriverLocationHistory", () => {
  it("returns pings since a given time, ascending", async () => {
    const { orgA, d1 } = await seedDispatchToolsFixture();
    const rows = await getDriverLocationHistory(orgA.id, d1.id, NOW_MS - 2.5 * HOUR);
    expect(rows).toHaveLength(2);
    expect(rows!.map((r) => r.atMs)).toEqual([NOW_MS - 2 * HOUR, NOW_MS - 1 * HOUR]);
    expect(rows![0]).toMatchObject({ lat: expect.any(Number), lng: expect.any(Number) });
  });

  it("returns null for a driver belonging to another org", async () => {
    const { orgA, dB1 } = await seedDispatchToolsFixture();
    expect(await getDriverLocationHistory(orgA.id, dB1.id, 0)).toBeNull();
  });
});
