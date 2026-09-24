import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";

beforeEach(resetDb);

// GET/PATCH /api/dispatcher/drivers/:id/preference (AI Dispatch Foundation,
// Task 9): the schema's own DriverPreference row (added by Task 1), read as
// the documented defaults when no row exists yet and upserted by PATCH.

async function seedOrgAndDriver() {
  const org = await prisma.org.create({ data: { name: "Acme" } });
  const dispatcher = await prisma.dispatcher.create({
    data: { email: "d@x.com", passwordHash: "x", name: "D", orgId: org.id },
  });
  const auth = `Bearer ${signDispatcherAccess(dispatcher.id)}`;
  const driver = await prisma.driver.create({
    data: { email: "jake@x.com", passwordHash: "x", name: "Jake", orgId: org.id },
  });
  return { org, dispatcher, auth, driver };
}

const DEFAULTS = {
  maxTripMiles: null,
  preferredRegions: [],
  preferredLanes: [],
  avoidRegions: [],
  avoidLanes: [],
  homeTimeTarget: null,
  willingToDriveNight: true,
  willingToRelocateMiles: null,
  preferredEquipment: [],
};

describe("GET /drivers/:id/preference", () => {
  it("answers the documented defaults when no DriverPreference row exists", async () => {
    const { auth, driver } = await seedOrgAndDriver();
    const res = await request(app).get(`/api/dispatcher/drivers/${driver.id}/preference`).set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DEFAULTS);
  });

  it("answers the real row once one exists, same shape as the defaults", async () => {
    const { auth, driver } = await seedOrgAndDriver();
    await prisma.driverPreference.create({
      data: { driverId: driver.id, maxTripMiles: 500, preferredRegions: ["TX", "OK"], willingToDriveNight: false },
    });
    const res = await request(app).get(`/api/dispatcher/drivers/${driver.id}/preference`).set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ...DEFAULTS, maxTripMiles: 500, preferredRegions: ["TX", "OK"], willingToDriveNight: false,
    });
    expect(res.body).not.toHaveProperty("driverId");
    expect(res.body).not.toHaveProperty("updatedAt");
  });

  it("404s a driver outside the caller's org", async () => {
    const { driver } = await seedOrgAndDriver();
    const other = await prisma.org.create({ data: { name: "Other" } });
    const foreign = await prisma.dispatcher.create({ data: { email: "f@x.com", passwordHash: "x", name: "F", orgId: other.id } });
    const res = await request(app).get(`/api/dispatcher/drivers/${driver.id}/preference`)
      .set("authorization", `Bearer ${signDispatcherAccess(foreign.id)}`);
    expect(res.status).toBe(404);
  });

  it("404s a nonexistent driver", async () => {
    const { auth } = await seedOrgAndDriver();
    const res = await request(app).get("/api/dispatcher/drivers/does-not-exist/preference").set("authorization", auth);
    expect(res.status).toBe(404);
  });
});

describe("PATCH /drivers/:id/preference", () => {
  it("creates a row on the first PATCH (upsert) and returns it", async () => {
    const { auth, driver } = await seedOrgAndDriver();
    const res = await request(app).patch(`/api/dispatcher/drivers/${driver.id}/preference`)
      .set("authorization", auth)
      .send({ maxTripMiles: 750, preferredEquipment: ["DryVan", "Reefer"] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...DEFAULTS, maxTripMiles: 750, preferredEquipment: ["DryVan", "Reefer"] });

    const row = await prisma.driverPreference.findUnique({ where: { driverId: driver.id } });
    expect(row?.maxTripMiles).toBe(750);
  });

  it("a later PATCH updates the existing row field-by-field", async () => {
    const { auth, driver } = await seedOrgAndDriver();
    await prisma.driverPreference.create({ data: { driverId: driver.id, maxTripMiles: 500 } });
    const res = await request(app).patch(`/api/dispatcher/drivers/${driver.id}/preference`)
      .set("authorization", auth).send({ homeTimeTarget: "weekends" });
    expect(res.status).toBe(200);
    expect(res.body.homeTimeTarget).toBe("weekends");
    expect(res.body.maxTripMiles).toBe(500); // untouched field survives
  });

  it("accepts a valid lane label and region code", async () => {
    const { auth, driver } = await seedOrgAndDriver();
    const res = await request(app).patch(`/api/dispatcher/drivers/${driver.id}/preference`)
      .set("authorization", auth)
      .send({ preferredLanes: ["Chicago, IL > Dallas, TX"], avoidRegions: ["NY"] });
    expect(res.status).toBe(200);
    expect(res.body.preferredLanes).toEqual(["Chicago, IL > Dallas, TX"]);
    expect(res.body.avoidRegions).toEqual(["NY"]);
  });

  it("404s a driver outside the caller's org", async () => {
    const { driver } = await seedOrgAndDriver();
    const other = await prisma.org.create({ data: { name: "Other" } });
    const foreign = await prisma.dispatcher.create({ data: { email: "f2@x.com", passwordHash: "x", name: "F2", orgId: other.id } });
    const res = await request(app).patch(`/api/dispatcher/drivers/${driver.id}/preference`)
      .set("authorization", `Bearer ${signDispatcherAccess(foreign.id)}`)
      .send({ maxTripMiles: 100 });
    expect(res.status).toBe(404);
  });

  describe("validation", () => {
    it("400s an empty body", async () => {
      const { auth, driver } = await seedOrgAndDriver();
      const res = await request(app).patch(`/api/dispatcher/drivers/${driver.id}/preference`).set("authorization", auth).send({});
      expect(res.status).toBe(400);
    });

    it("400s a negative maxTripMiles/willingToRelocateMiles", async () => {
      const { auth, driver } = await seedOrgAndDriver();
      const bad = await Promise.all([
        request(app).patch(`/api/dispatcher/drivers/${driver.id}/preference`).set("authorization", auth).send({ maxTripMiles: -1 }),
        request(app).patch(`/api/dispatcher/drivers/${driver.id}/preference`).set("authorization", auth).send({ willingToRelocateMiles: -5 }),
      ]);
      expect(bad[0]!.status).toBe(400);
      expect(bad[1]!.status).toBe(400);
    });

    it("400s a region that isn't a 2-letter code", async () => {
      const { auth, driver } = await seedOrgAndDriver();
      const res = await request(app).patch(`/api/dispatcher/drivers/${driver.id}/preference`)
        .set("authorization", auth).send({ preferredRegions: ["Texas"] });
      expect(res.status).toBe(400);
    });

    it("400s a lane that doesn't match the 'City, ST > City, ST' shape", async () => {
      const { auth, driver } = await seedOrgAndDriver();
      const res = await request(app).patch(`/api/dispatcher/drivers/${driver.id}/preference`)
        .set("authorization", auth).send({ preferredLanes: ["Chicago to Dallas"] });
      expect(res.status).toBe(400);
    });

    it("400s a string-array field over 20 items", async () => {
      const { auth, driver } = await seedOrgAndDriver();
      const res = await request(app).patch(`/api/dispatcher/drivers/${driver.id}/preference`)
        .set("authorization", auth).send({ preferredEquipment: Array.from({ length: 21 }, (_, i) => `Type${i}`) });
      expect(res.status).toBe(400);
    });

    it("400s a homeTimeTarget over 40 characters", async () => {
      const { auth, driver } = await seedOrgAndDriver();
      const res = await request(app).patch(`/api/dispatcher/drivers/${driver.id}/preference`)
        .set("authorization", auth).send({ homeTimeTarget: "x".repeat(41) });
      expect(res.status).toBe(400);
    });

    it("400s a malformed maxTripMiles (non-integer)", async () => {
      const { auth, driver } = await seedOrgAndDriver();
      const res = await request(app).patch(`/api/dispatcher/drivers/${driver.id}/preference`)
        .set("authorization", auth).send({ maxTripMiles: 12.5 });
      expect(res.status).toBe(400);
    });
  });
});
