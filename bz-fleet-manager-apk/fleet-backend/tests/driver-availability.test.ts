import request from "supertest";
import type { Prisma } from "@prisma/client";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import {
  AVAILABLE_SOON_WINDOW_MS,
  deriveStatus,
  cityStateFromAddress,
  projectAvailability,
} from "../src/lib/driverAvailability.js";

beforeEach(resetDb);

const KC = { lat: 39.0997, lng: -94.5786 };
const OMAHA = { lat: 41.2565, lng: -95.9345 };
const OMAHA_ADDRESS = "Omaha dock, Omaha, NE 68102";

// Counts Driver-model calls made while `countingDriverQueries` is true — mirrors
// tests/dispatcher-mount-order.test.ts's own $use counter (same file-isolation
// reasoning: vitest gives each test file its own module graph, and $use has no
// deregister, so this never reaches another suite).
let countingDriverQueries = false;
let driverQueryCount = 0;
prisma.$use(async (params: Prisma.MiddlewareParams, next: (p: Prisma.MiddlewareParams) => Promise<unknown>) => {
  if (countingDriverQueries && params.model === "Driver") driverQueryCount++;
  return next(params);
});

// ---------------------------------------------------------------------------
// Pure-function unit tests: cityStateFromAddress / projectAvailability / deriveStatus
// ---------------------------------------------------------------------------

describe("cityStateFromAddress", () => {
  it("parses a full street address, preserving source capitalisation", () => {
    expect(cityStateFromAddress("123 Dock Rd, Kansas City, MO 64101")).toEqual({ city: "Kansas City", state: "MO" });
  });
  it("parses a bare City, ST", () => {
    expect(cityStateFromAddress("Wichita, KS")).toEqual({ city: "Wichita", state: "KS" });
  });
  it("returns null/null when there is no recognisable state token", () => {
    expect(cityStateFromAddress("Main Warehouse")).toEqual({ city: null, state: null });
    expect(cityStateFromAddress("Skopje, Macedonia")).toEqual({ city: null, state: null });
  });
});

describe("projectAvailability", () => {
  it("basis current_assignment_last_drop: uses the last geocoded delivery stop and the assignment's planned end", () => {
    const driver = { lastLat: KC.lat, lastLng: KC.lng };
    const current = {
      plannedEnd: new Date("2026-08-21T15:00:00.000Z"),
      load: {
        stops: [
          { type: "pickup", address: "KC dock", lat: KC.lat, lng: KC.lng },
          { type: "delivery", address: OMAHA_ADDRESS, lat: OMAHA.lat, lng: OMAHA.lng },
        ],
      },
    };
    expect(projectAvailability(driver, current, Date.now())).toEqual({
      at: current.plannedEnd.getTime(),
      lat: OMAHA.lat,
      lng: OMAHA.lng,
      city: "Omaha",
      state: "NE",
      basis: "current_assignment_last_drop",
    });
  });

  it("basis last_ping: an ungeocoded delivery stop falls back to the driver's last ping", () => {
    // KC is the gazetteer's own "kansas city|mo" coordinate (distance 0), so
    // the last-ping basis now names it — see the dedicated "at"/"beyond 3 mi"
    // tests below for the threshold itself.
    const driver = { lastLat: KC.lat, lastLng: KC.lng };
    const current = {
      plannedEnd: new Date("2026-08-21T15:00:00.000Z"),
      load: { stops: [{ type: "delivery", address: "pending geocode", lat: null, lng: null }] },
    };
    expect(projectAvailability(driver, current, Date.now())).toEqual({
      at: current.plannedEnd.getTime(),
      lat: KC.lat,
      lng: KC.lng,
      city: "Kansas City",
      state: "MO",
      basis: "last_ping",
    });
  });

  it("basis last_ping also applies with no current assignment at all, and `at` is nowMs", () => {
    const now = Date.now();
    expect(projectAvailability({ lastLat: KC.lat, lastLng: KC.lng }, null, now)).toEqual({
      at: now,
      lat: KC.lat,
      lng: KC.lng,
      city: "Kansas City",
      state: "MO",
      basis: "last_ping",
    });
  });

  it("basis last_ping: within 3 mi of a known place, city/state resolve to it (\"at\")", () => {
    // ~2 mi north of the gazetteer's own Kansas City coordinate — still
    // within the LAST_PING_CITY_MAX_MI=3 threshold.
    const nearKC = { lastLat: KC.lat + 0.03, lastLng: KC.lng };
    const result = projectAvailability(nearKC, null, Date.now());
    expect(result.basis).toBe("last_ping");
    expect(result.city).toBe("Kansas City");
    expect(result.state).toBe("MO");
  });

  it("basis last_ping: beyond 3 mi of any known place, city/state stay null", () => {
    // ~87 mi from Kansas City (and further still from every other gazetteer
    // hub) — nearestKnownPlace still finds a nearest entry, just not within
    // the 3 mi "at" threshold.
    const farFromKC = { lastLat: KC.lat + 1, lastLng: KC.lng + 1 };
    const result = projectAvailability(farFromKC, null, Date.now());
    expect(result.basis).toBe("last_ping");
    expect(result.city).toBeNull();
    expect(result.state).toBeNull();
  });

  it("basis none: no current assignment and no ping", () => {
    const now = Date.now();
    expect(projectAvailability({ lastLat: null, lastLng: null }, null, now)).toEqual({
      at: now,
      lat: null,
      lng: null,
      city: null,
      state: null,
      basis: "none",
    });
  });

  it("basis none also applies with a current assignment whose stops are all ungeocoded and no ping", () => {
    const current = {
      plannedEnd: new Date("2026-08-21T15:00:00.000Z"),
      load: { stops: [{ type: "delivery", address: "pending geocode", lat: null, lng: null }] },
    };
    expect(projectAvailability({ lastLat: null, lastLng: null }, current, Date.now())).toEqual({
      at: current.plannedEnd.getTime(),
      lat: null,
      lng: null,
      city: null,
      state: null,
      basis: "none",
    });
  });
});

async function seedOrgAndDriver(overrides: Partial<{ lastLat: number | null; lastLng: number | null }> = {}) {
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const dispatcher = await prisma.dispatcher.create({
    data: { email: "d@x.com", passwordHash: "x", name: "D", orgId: org.id },
  });
  const auth = `Bearer ${signDispatcherAccess(dispatcher.id)}`;
  const driver = await prisma.driver.create({
    data: {
      email: "jake@x.com", passwordHash: "x", name: "Jake", orgId: org.id,
      lastLat: overrides.lastLat ?? null, lastLng: overrides.lastLng ?? null,
    },
  });
  return { org, dispatcher, auth, driver };
}

async function createAssignedLoad(
  orgId: string,
  driverId: string,
  opts: { plannedEnd: Date; deliveryAddress?: string; deliveryLat?: number | null; deliveryLng?: number | null },
) {
  const load = await prisma.load.create({
    data: {
      orgId, externalId: "L-CUR", requiredEquip: "DryVan", status: "assigned",
      stops: {
        create: [
          { sequence: 1, type: "pickup", address: "KC dock", lat: KC.lat, lng: KC.lng },
          {
            sequence: 2, type: "delivery", address: opts.deliveryAddress ?? OMAHA_ADDRESS,
            lat: opts.deliveryLat === undefined ? OMAHA.lat : opts.deliveryLat,
            lng: opts.deliveryLng === undefined ? OMAHA.lng : opts.deliveryLng,
          },
        ],
      },
    },
  });
  const assignment = await prisma.assignment.create({
    data: {
      orgId, loadId: load.id, driverId, status: "assigned",
      plannedStart: new Date(opts.plannedEnd.getTime() - 6 * 3600 * 1000),
      plannedEnd: opts.plannedEnd,
    },
  });
  return { load, assignment };
}

describe("deriveStatus", () => {
  it("AVAILABLE_SOON exactly at the 4h boundary; ON_LOAD one ms past it", async () => {
    const { org, driver } = await seedOrgAndDriver();
    const now = Date.now();
    const { assignment } = await createAssignedLoad(org.id, driver.id, { plannedEnd: new Date(now) });

    expect(deriveStatus(null, { ...assignment, plannedEnd: new Date(now + AVAILABLE_SOON_WINDOW_MS) }, now))
      .toBe("AVAILABLE_SOON");
    expect(deriveStatus(null, { ...assignment, plannedEnd: new Date(now + AVAILABLE_SOON_WINDOW_MS + 1) }, now))
      .toBe("ON_LOAD");
  });

  it("AVAILABLE when acceptingLoads and no current assignment", async () => {
    const { driver } = await seedOrgAndDriver();
    // availabilityStatus set explicitly (not left at the schema's own
    // "UNAVAILABLE" default) — otherwise rule 1 would fire on the default
    // value itself and this wouldn't isolate rule 3 at all. See the
    // "defaults to the schema's own UNAVAILABLE" test below, which pins down
    // that default-collision behaviour on purpose instead of hiding it.
    const explicit = await prisma.driverAvailability.create({
      data: { driverId: driver.id, source: "manual", acceptingLoads: true, availabilityStatus: "AVAILABLE" },
    });
    expect(deriveStatus(explicit, null, Date.now())).toBe("AVAILABLE");
  });

  it("UNAVAILABLE with no row and no current assignment", () => {
    expect(deriveStatus(null, null, Date.now())).toBe("UNAVAILABLE");
  });

  it("a manual OFF_DUTY/UNAVAILABLE row wins even over an active assignment", async () => {
    const { org, driver } = await seedOrgAndDriver();
    const now = Date.now();
    const { assignment } = await createAssignedLoad(org.id, driver.id, { plannedEnd: new Date(now + 1000) });
    const offDuty = await prisma.driverAvailability.create({
      data: { driverId: driver.id, source: "manual", availabilityStatus: "OFF_DUTY" },
    });
    expect(deriveStatus(offDuty, assignment, now)).toBe("OFF_DUTY");
  });

  it("a simulation-sourced row's availabilityStatus is not an override, but its acceptingLoads is still read", async () => {
    const { driver } = await seedOrgAndDriver();
    const simulated = await prisma.driverAvailability.create({
      data: { driverId: driver.id, source: "simulation", availabilityStatus: "OFF_DUTY", acceptingLoads: true },
    });
    // Were the override honoured this would be OFF_DUTY; it isn't, so the
    // normal rules run and acceptingLoads (read straight off the same row)
    // makes it AVAILABLE instead — proving both halves of the rule at once.
    expect(deriveStatus(simulated, null, Date.now())).toBe("AVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// Routes: GET /drivers/availability, GET /drivers/:id/availability,
// PATCH /drivers/:id/availability
// ---------------------------------------------------------------------------

describe("GET /drivers/:id/availability", () => {
  it("defaults for a driver with no DriverAvailability row and no active assignment", async () => {
    const { auth, driver } = await seedOrgAndDriver();
    const res = await request(app).get(`/api/dispatcher/drivers/${driver.id}/availability`).set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      driverId: driver.id,
      acceptingLoads: false,
      locationSharingEnabled: false,
      locationSharingUpdatedAt: null,
      shareToken: null,
      status: "UNAVAILABLE",
      source: "none",
      available: { lat: null, lng: null, city: null, state: null },
      current: null,
      currentAssignment: null,
    });
  });

  it("a missing row still yields AVAILABLE_SOON/ON_LOAD from an active assignment", async () => {
    const { org, auth, driver } = await seedOrgAndDriver();
    await createAssignedLoad(org.id, driver.id, { plannedEnd: new Date(Date.now() + 1000) });
    const res = await request(app).get(`/api/dispatcher/drivers/${driver.id}/availability`).set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("none");
    expect(res.body.status).toBe("AVAILABLE_SOON");
    expect(res.body.currentAssignment.deliveryCity).toBe("Omaha");
  });

  it("falls back to the last ping when there is no current assignment", async () => {
    const { auth, driver } = await seedOrgAndDriver({ lastLat: KC.lat, lastLng: KC.lng });
    const pingAt = new Date("2026-08-20T00:00:00.000Z");
    await prisma.driver.update({ where: { id: driver.id }, data: { lastLocationAt: pingAt } });

    const res = await request(app).get(`/api/dispatcher/drivers/${driver.id}/availability`).set("authorization", auth);
    expect(res.status).toBe(200);
    // KC is the gazetteer's own "kansas city|mo" coordinate (distance 0), so
    // the projection's last-ping basis names it too, same as `current.near`.
    expect(res.body.available).toEqual({ lat: KC.lat, lng: KC.lng, city: "Kansas City", state: "MO" });
    // `near` resolves essentially on top of it (Task 9) — distanceMi is
    // asserted loosely since it is a real haversine computation, not a fixed
    // constant.
    expect(res.body.current).toEqual({
      lat: KC.lat, lng: KC.lng, at: pingAt.getTime(),
      near: { city: "Kansas City", state: "MO", distanceMi: expect.any(Number) },
    });
    expect(res.body.current.near.distanceMi).toBeLessThan(1);
  });

  it("a manual OFF_DUTY row wins over what would otherwise be AVAILABLE", async () => {
    const { auth, driver } = await seedOrgAndDriver();
    await prisma.driverAvailability.create({
      data: { driverId: driver.id, source: "manual", availabilityStatus: "OFF_DUTY", acceptingLoads: true },
    });
    const res = await request(app).get(`/api/dispatcher/drivers/${driver.id}/availability`).set("authorization", auth);
    expect(res.body.status).toBe("OFF_DUTY");
  });

  it("a simulation-sourced row's status is not treated as a manual override", async () => {
    const { auth, driver } = await seedOrgAndDriver();
    await prisma.driverAvailability.create({
      data: { driverId: driver.id, source: "simulation", availabilityStatus: "OFF_DUTY", acceptingLoads: true },
    });
    const res = await request(app).get(`/api/dispatcher/drivers/${driver.id}/availability`).set("authorization", auth);
    expect(res.body.status).toBe("AVAILABLE");
    expect(res.body.source).toBe("simulation");
    expect(res.body.acceptingLoads).toBe(true);
  });

  it("404s for a driver outside the caller's org", async () => {
    const { driver } = await seedOrgAndDriver();
    const other = await prisma.org.create({ data: { name: "Other" } });
    const foreign = await prisma.dispatcher.create({ data: { email: "f@x.com", passwordHash: "x", name: "F", orgId: other.id } });
    const res = await request(app).get(`/api/dispatcher/drivers/${driver.id}/availability`)
      .set("authorization", `Bearer ${signDispatcherAccess(foreign.id)}`);
    expect(res.status).toBe(404);
  });

  it("404s for a nonexistent driver", async () => {
    const { auth } = await seedOrgAndDriver();
    const res = await request(app).get("/api/dispatcher/drivers/does-not-exist/availability").set("authorization", auth);
    expect(res.status).toBe(404);
  });
});

describe("GET /drivers/availability (list)", () => {
  it("returns every driver in the caller's org and excludes another org's driver", async () => {
    const { org, auth, driver } = await seedOrgAndDriver();
    const other = await prisma.org.create({ data: { name: "Other" } });
    const foreignDriver = await prisma.driver.create({
      data: { email: "foreign@x.com", passwordHash: "x", name: "Foreign", orgId: other.id },
    });
    await prisma.driver.create({ data: { email: "second@x.com", passwordHash: "x", name: "Second", orgId: org.id } });

    const res = await request(app).get("/api/dispatcher/drivers/availability").set("authorization", auth);
    expect(res.status).toBe(200);
    const ids = (res.body as { driverId: string }[]).map((v) => v.driverId);
    expect(ids).toContain(driver.id);
    expect(ids).not.toContain(foreignDriver.id);
    expect(ids).toHaveLength(2);
  });

  it("answers with exactly one Driver query, regardless of driver count (no per-driver queries)", async () => {
    const { org, auth } = await seedOrgAndDriver();
    await prisma.driver.create({ data: { email: "second@x.com", passwordHash: "x", name: "Second", orgId: org.id } });
    await prisma.driver.create({ data: { email: "third@x.com", passwordHash: "x", name: "Third", orgId: org.id } });

    driverQueryCount = 0;
    countingDriverQueries = true;
    const res = await request(app).get("/api/dispatcher/drivers/availability").set("authorization", auth);
    countingDriverQueries = false;

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(driverQueryCount).toBe(1);
  });
});

describe("PATCH /drivers/:id/availability", () => {
  it("a first PATCH with only acceptingLoads and no explicit status creates a 'derived' row, not an override — and still exposes a shareToken", async () => {
    // A row becomes a manual STATUS override only when the dispatcher
    // explicitly PATCHes availabilityStatus. Without it, a freshly created
    // row is written source:"derived" (deriveStatus ignores a non-manual
    // row's status entirely), so acceptingLoads:true here correctly yields
    // AVAILABLE rather than being masked by the schema's own "UNAVAILABLE"
    // availabilityStatus default.
    const { auth, driver } = await seedOrgAndDriver();
    expect(await prisma.driverAvailability.findUnique({ where: { driverId: driver.id } })).toBeNull();

    const res = await request(app).patch(`/api/dispatcher/drivers/${driver.id}/availability`)
      .set("authorization", auth).send({ acceptingLoads: true });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("AVAILABLE");
    expect(res.body.source).toBe("derived");
    expect(res.body.acceptingLoads).toBe(true);
    expect(res.body.shareToken).toEqual(expect.any(String));
    expect((res.body.shareToken as string).length).toBeGreaterThan(0);

    const row = await prisma.driverAvailability.findUnique({ where: { driverId: driver.id } });
    expect(row?.source).toBe("derived");
    expect(row?.availabilityStatus).toBe("UNAVAILABLE"); // schema default, but inert for a non-manual row
  });

  it("a PATCH that explicitly sets availabilityStatus creates a manual row with that status", async () => {
    const { auth, driver } = await seedOrgAndDriver();
    const res = await request(app).patch(`/api/dispatcher/drivers/${driver.id}/availability`)
      .set("authorization", auth).send({ availabilityStatus: "OFF_DUTY" });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("manual");
    expect(res.body.status).toBe("OFF_DUTY");
  });

  it("an existing manual override survives a later PATCH that only touches acceptingLoads/location", async () => {
    const { auth, driver } = await seedOrgAndDriver();
    await prisma.driverAvailability.create({
      data: { driverId: driver.id, source: "manual", availabilityStatus: "OFF_DUTY" },
    });

    const res = await request(app).patch(`/api/dispatcher/drivers/${driver.id}/availability`)
      .set("authorization", auth).send({ acceptingLoads: true });
    expect(res.status).toBe(200);
    // Still OFF_DUTY — toggling acceptingLoads alone never clears an
    // existing explicit override.
    expect(res.body.status).toBe("OFF_DUTY");

    const row = await prisma.driverAvailability.findUnique({ where: { driverId: driver.id } });
    expect(row?.source).toBe("manual");
    expect(row?.availabilityStatus).toBe("OFF_DUTY");
    expect(row?.acceptingLoads).toBe(true);
  });

  it("a dispatcher clears an existing override by explicitly PATCHing a non-override status", async () => {
    const { auth, driver } = await seedOrgAndDriver();
    await prisma.driverAvailability.create({
      data: { driverId: driver.id, source: "manual", availabilityStatus: "OFF_DUTY" },
    });

    const res = await request(app).patch(`/api/dispatcher/drivers/${driver.id}/availability`)
      .set("authorization", auth).send({ availabilityStatus: "AVAILABLE", acceptingLoads: true });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("manual");
    // "AVAILABLE" isn't one of rule 1's override statuses, so the normal
    // derivation runs — acceptingLoads:true also yields AVAILABLE here, but
    // the point being proven is that OFF_DUTY no longer wins.
    expect(res.body.status).toBe("AVAILABLE");

    const row = await prisma.driverAvailability.findUnique({ where: { driverId: driver.id } });
    expect(row?.availabilityStatus).toBe("AVAILABLE");
  });

  it("field-by-field: an overridden field wins, an untouched field keeps the projection", async () => {
    const { org, auth, driver } = await seedOrgAndDriver();
    await createAssignedLoad(org.id, driver.id, { plannedEnd: new Date("2026-08-21T15:00:00.000Z") });

    const res = await request(app).patch(`/api/dispatcher/drivers/${driver.id}/availability`)
      .set("authorization", auth).send({ availableCity: "Custom City" });
    expect(res.status).toBe(200);
    expect(res.body.available.city).toBe("Custom City");
    // lat/lng/state were never overridden — still the projection's (Omaha's).
    expect(res.body.available.lat).toBe(OMAHA.lat);
    expect(res.body.available.lng).toBe(OMAHA.lng);
    expect(res.body.available.state).toBe("NE");
  });

  it("an overridden availableAt wins over the projected availableAt", async () => {
    const { org, auth, driver } = await seedOrgAndDriver();
    await createAssignedLoad(org.id, driver.id, { plannedEnd: new Date("2026-08-21T15:00:00.000Z") });
    const manualAt = "2026-08-25T00:00:00.000Z";

    const res = await request(app).patch(`/api/dispatcher/drivers/${driver.id}/availability`)
      .set("authorization", auth).send({ availableAt: manualAt });
    expect(res.status).toBe(200);
    expect(res.body.availableAt).toBe(new Date(manualAt).getTime());
  });

  it("404s for a driver outside the caller's org", async () => {
    const { driver } = await seedOrgAndDriver();
    const other = await prisma.org.create({ data: { name: "Other" } });
    const foreign = await prisma.dispatcher.create({ data: { email: "f2@x.com", passwordHash: "x", name: "F2", orgId: other.id } });
    const res = await request(app).patch(`/api/dispatcher/drivers/${driver.id}/availability`)
      .set("authorization", `Bearer ${signDispatcherAccess(foreign.id)}`)
      .send({ acceptingLoads: true });
    expect(res.status).toBe(404);
  });

  describe("validation", () => {
    it("400s an empty body", async () => {
      const { auth, driver } = await seedOrgAndDriver();
      const res = await request(app).patch(`/api/dispatcher/drivers/${driver.id}/availability`).set("authorization", auth).send({});
      expect(res.status).toBe(400);
    });

    it("400s an invalid availabilityStatus", async () => {
      const { auth, driver } = await seedOrgAndDriver();
      const res = await request(app).patch(`/api/dispatcher/drivers/${driver.id}/availability`)
        .set("authorization", auth).send({ availabilityStatus: "NOT_A_STATUS" });
      expect(res.status).toBe(400);
    });

    it("400s an out-of-range latitude/longitude", async () => {
      const { auth, driver } = await seedOrgAndDriver();
      const bad = await Promise.all([
        request(app).patch(`/api/dispatcher/drivers/${driver.id}/availability`).set("authorization", auth).send({ availableLat: 91 }),
        request(app).patch(`/api/dispatcher/drivers/${driver.id}/availability`).set("authorization", auth).send({ availableLng: -200 }),
      ]);
      expect(bad[0]!.status).toBe(400);
      expect(bad[1]!.status).toBe(400);
    });

    it("400s a location label over 80 characters", async () => {
      const { auth, driver } = await seedOrgAndDriver();
      const res = await request(app).patch(`/api/dispatcher/drivers/${driver.id}/availability`)
        .set("authorization", auth).send({ availableCity: "x".repeat(81) });
      expect(res.status).toBe(400);
    });

    it("400s a non-ISO availableAt", async () => {
      const { auth, driver } = await seedOrgAndDriver();
      const res = await request(app).patch(`/api/dispatcher/drivers/${driver.id}/availability`)
        .set("authorization", auth).send({ availableAt: "not-a-date" });
      expect(res.status).toBe(400);
    });
  });
});

describe("the shared projection agrees across routes", () => {
  it("GET /drivers/:id/next's availableAt matches GET /drivers/:id/availability's for the same fixture", async () => {
    const { org, auth, driver } = await seedOrgAndDriver({ lastLat: KC.lat, lastLng: KC.lng });
    await createAssignedLoad(org.id, driver.id, { plannedEnd: new Date("2026-08-21T15:00:00.000Z") });

    const [nextRes, availRes] = await Promise.all([
      request(app).get(`/api/dispatcher/drivers/${driver.id}/next`).set("authorization", auth),
      request(app).get(`/api/dispatcher/drivers/${driver.id}/availability`).set("authorization", auth),
    ]);
    expect(nextRes.status).toBe(200);
    expect(availRes.status).toBe(200);
    expect(nextRes.body.driver.availableAt).toBe(new Date(availRes.body.availableAt).toISOString());
    expect(availRes.body.currentAssignment.deliveryCity).toBe("Omaha");
  });
});
