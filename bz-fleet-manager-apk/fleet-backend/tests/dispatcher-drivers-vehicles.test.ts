import request from "supertest";
import { prisma } from "../src/db.js";
import { app, resetDb, createDispatcher } from "./helpers.js";
import { signAccess, signDispatcherAccess } from "../src/lib/tokens.js";
beforeEach(resetDb);

async function dispatcherAuth() {
  const disp = await createDispatcher();
  return `Bearer ${signDispatcherAccess(disp.id)}`;
}

describe("driver CRUD", () => {
  it("creates a driver, lists it, and the created driver can log in", async () => {
    const auth = await dispatcherAuth();
    const create = await request(app).post("/api/dispatcher/drivers").set("authorization", auth)
      .send({ email: "newdrv@fleet.com", name: "New Driver", password: "secret123" });
    expect(create.status).toBe(201);
    expect(create.body.email).toBe("newdrv@fleet.com");
    expect(create.body).not.toHaveProperty("passwordHash");

    const list = await request(app).get("/api/dispatcher/drivers").set("authorization", auth);
    expect(list.status).toBe(200);
    expect(list.body.map((d: { email: string }) => d.email)).toContain("newdrv@fleet.com");

    const login = await request(app).post("/api/auth/driver/login")
      .send({ email: "newdrv@fleet.com", password: "secret123" });
    expect(login.status).toBe(200);
    expect(login.body.driver.email).toBe("newdrv@fleet.com");
  });

  it("rejects creating a driver with a duplicate email with 409", async () => {
    const auth = await dispatcherAuth();
    await request(app).post("/api/dispatcher/drivers").set("authorization", auth)
      .send({ email: "dupe@fleet.com", name: "First", password: "secret123" });
    const res = await request(app).post("/api/dispatcher/drivers").set("authorization", auth)
      .send({ email: "dupe@fleet.com", name: "Second", password: "secret123" });
    expect(res.status).toBe(409);
  });

  it("gets a single driver by id", async () => {
    const auth = await dispatcherAuth();
    const create = await request(app).post("/api/dispatcher/drivers").set("authorization", auth)
      .send({ email: "single@fleet.com", name: "Single", password: "secret123" });
    const res = await request(app).get(`/api/dispatcher/drivers/${create.body.id}`).set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe("single@fleet.com");
  });

  it("returns 404 for an unknown driver id", async () => {
    const auth = await dispatcherAuth();
    const res = await request(app).get("/api/dispatcher/drivers/does-not-exist").set("authorization", auth);
    expect(res.status).toBe(404);
  });

  it("updates a driver and the change persists", async () => {
    const auth = await dispatcherAuth();
    const create = await request(app).post("/api/dispatcher/drivers").set("authorization", auth)
      .send({ email: "upd@fleet.com", name: "Before", password: "secret123" });
    const update = await request(app).put(`/api/dispatcher/drivers/${create.body.id}`).set("authorization", auth)
      .send({ name: "After", phone: "555-0100" });
    expect(update.status).toBe(200);
    expect(update.body.name).toBe("After");

    const fetched = await request(app).get(`/api/dispatcher/drivers/${create.body.id}`).set("authorization", auth);
    expect(fetched.body.name).toBe("After");
    expect(fetched.body.phone).toBe("555-0100");
  });

  it("returns a driver's location history", async () => {
    const auth = await dispatcherAuth();
    const create = await request(app).post("/api/dispatcher/drivers").set("authorization", auth)
      .send({ email: "loc@fleet.com", name: "Loc", password: "secret123" });
    await prisma.driverLocation.create({ data: { driverId: create.body.id, latitude: 41.6, longitude: 21.7 } });
    await prisma.driverLocation.create({ data: { driverId: create.body.id, latitude: 41.7, longitude: 21.8 } });
    const res = await request(app).get(`/api/dispatcher/drivers/${create.body.id}/locations`)
      .set("authorization", auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

describe("vehicle CRUD + assignment", () => {
  it("creates a vehicle and lists it", async () => {
    const auth = await dispatcherAuth();
    const create = await request(app).post("/api/dispatcher/vehicles").set("authorization", auth)
      .send({ plate: "DSP-001", model: "Sprinter" });
    expect(create.status).toBe(201);
    const list = await request(app).get("/api/dispatcher/vehicles").set("authorization", auth);
    expect(list.body.map((v: { plate: string }) => v.plate)).toContain("DSP-001");
  });

  it("updates a vehicle", async () => {
    const auth = await dispatcherAuth();
    const create = await request(app).post("/api/dispatcher/vehicles").set("authorization", auth)
      .send({ plate: "DSP-002" });
    const update = await request(app).put(`/api/dispatcher/vehicles/${create.body.id}`).set("authorization", auth)
      .send({ model: "Transit" });
    expect(update.status).toBe(200);
    expect(update.body.model).toBe("Transit");
  });

  it("assigns a vehicle to a driver, reflected in the driver's /driver/vehicle", async () => {
    const auth = await dispatcherAuth();
    const driver = await request(app).post("/api/dispatcher/drivers").set("authorization", auth)
      .send({ email: "veh@fleet.com", name: "Veh Driver", password: "secret123" });
    const vehicle = await request(app).post("/api/dispatcher/vehicles").set("authorization", auth)
      .send({ plate: "DSP-003" });
    const assign = await request(app).post(`/api/dispatcher/vehicles/${vehicle.body.id}/assign`)
      .set("authorization", auth).send({ driverId: driver.body.id });
    expect(assign.status).toBe(200);
    expect(assign.body.driverId).toBe(driver.body.id);

    const res = await request(app).get("/api/driver/vehicle")
      .set("authorization", `Bearer ${signAccess(driver.body.id)}`);
    expect(res.status).toBe(200);
    expect(res.body.plate).toBe("DSP-003");
  });
});

// Regression suite for a live cross-tenant read AND write: this router was
// mounted without attachOrgScope and none of its handlers filtered by org, so
// any dispatcher could list every org's drivers (email, phone, GPS, pushToken),
// read another tenant's location history, rename a foreign driver, and pair a
// vehicle with a driver in an unrelated org. Each case below asserts the
// EFFECT (row contents after the call), not just the status code.
describe("cross-tenant isolation", () => {
  async function makeTenant(name: string) {
    const org = await prisma.org.create({ data: { name } });
    const driver = await prisma.driver.create({
      data: {
        email: `${name.toLowerCase()}-drv@x.com`, passwordHash: "x",
        name: `${name} Driver`, phone: "555-0001", orgId: org.id,
      },
    });
    const dispatcher = await prisma.dispatcher.create({
      data: { email: `${name.toLowerCase()}-disp@x.com`, passwordHash: "x", name: `${name} Disp`, orgId: org.id },
    });
    return { org, driver, auth: `Bearer ${signDispatcherAccess(dispatcher.id)}` };
  }

  it("GET /drivers returns only the caller's own org's drivers", async () => {
    const a = await makeTenant("Alpha");
    const b = await makeTenant("Beta");

    const res = await request(app).get("/api/dispatcher/drivers").set("authorization", b.auth);
    expect(res.status).toBe(200);
    const ids = res.body.map((d: { id: string }) => d.id);
    const emails = res.body.map((d: { email: string }) => d.email);
    expect(ids).toContain(b.driver.id);
    expect(ids).not.toContain(a.driver.id);
    expect(emails).not.toContain(a.driver.email);
  });

  it("GET /drivers/:id 404s a driver in another org", async () => {
    const a = await makeTenant("Alpha");
    const b = await makeTenant("Beta");

    const res = await request(app).get(`/api/dispatcher/drivers/${a.driver.id}`).set("authorization", b.auth);
    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty("email");
  });

  it("PUT /drivers/:id 404s a driver in another org AND leaves the row untouched", async () => {
    const a = await makeTenant("Alpha");
    const b = await makeTenant("Beta");

    const res = await request(app).put(`/api/dispatcher/drivers/${a.driver.id}`)
      .set("authorization", b.auth).send({ name: "PWNED", phone: "666-6666" });
    expect(res.status).toBe(404);

    // The write is the part that matters: re-read from the database.
    const after = await prisma.driver.findUniqueOrThrow({ where: { id: a.driver.id } });
    expect(after.name).toBe("Alpha Driver");
    expect(after.phone).toBe("555-0001");
  });

  it("GET /drivers/:id/locations 404s another org's GPS history", async () => {
    const a = await makeTenant("Alpha");
    const b = await makeTenant("Beta");
    await prisma.driverLocation.create({ data: { driverId: a.driver.id, latitude: 41.6, longitude: 21.7 } });

    const res = await request(app).get(`/api/dispatcher/drivers/${a.driver.id}/locations`)
      .set("authorization", b.auth);
    expect(res.status).toBe(404);
    expect(Array.isArray(res.body)).toBe(false);
  });

  it("GET /vehicles hides another org's assigned vehicle", async () => {
    const a = await makeTenant("Alpha");
    const b = await makeTenant("Beta");
    await prisma.vehicle.create({ data: { plate: "ALPHA-1", driverId: a.driver.id } });

    const res = await request(app).get("/api/dispatcher/vehicles").set("authorization", b.auth);
    expect(res.status).toBe(200);
    expect(res.body.map((v: { plate: string }) => v.plate)).not.toContain("ALPHA-1");
  });

  it("PUT /vehicles/:id 404s another org's vehicle AND leaves the row untouched", async () => {
    const a = await makeTenant("Alpha");
    const b = await makeTenant("Beta");
    const veh = await prisma.vehicle.create({ data: { plate: "ALPHA-2", model: "Sprinter", driverId: a.driver.id } });

    const res = await request(app).put(`/api/dispatcher/vehicles/${veh.id}`)
      .set("authorization", b.auth).send({ plate: "PWNED", model: "PWNED" });
    expect(res.status).toBe(404);

    const after = await prisma.vehicle.findUniqueOrThrow({ where: { id: veh.id } });
    expect(after.plate).toBe("ALPHA-2");
    expect(after.model).toBe("Sprinter");
  });

  it("POST /vehicles/:id/assign 404s a foreign DRIVER and leaves the vehicle unassigned", async () => {
    const a = await makeTenant("Alpha");
    const b = await makeTenant("Beta");
    const veh = await prisma.vehicle.create({ data: { plate: "BETA-1" } });

    const res = await request(app).post(`/api/dispatcher/vehicles/${veh.id}/assign`)
      .set("authorization", b.auth).send({ driverId: a.driver.id });
    expect(res.status).toBe(404);

    const after = await prisma.vehicle.findUniqueOrThrow({ where: { id: veh.id } });
    expect(after.driverId).toBeNull();
  });

  it("POST /vehicles/:id/assign 404s a foreign VEHICLE and leaves it with its own driver", async () => {
    const a = await makeTenant("Alpha");
    const b = await makeTenant("Beta");
    const veh = await prisma.vehicle.create({ data: { plate: "ALPHA-3", driverId: a.driver.id } });

    const res = await request(app).post(`/api/dispatcher/vehicles/${veh.id}/assign`)
      .set("authorization", b.auth).send({ driverId: b.driver.id });
    expect(res.status).toBe(404);

    const after = await prisma.vehicle.findUniqueOrThrow({ where: { id: veh.id } });
    expect(after.driverId).toBe(a.driver.id);
  });

  it("a driver created by a scoped dispatcher carries that dispatcher's orgId", async () => {
    const b = await makeTenant("Beta");

    const create = await request(app).post("/api/dispatcher/drivers").set("authorization", b.auth)
      .send({ email: "fresh@fleet.com", name: "Fresh", password: "secret123" });
    expect(create.status).toBe(201);

    const row = await prisma.driver.findUniqueOrThrow({ where: { id: create.body.id } });
    expect(row.orgId).toBe(b.org.id);

    // ...and is therefore visible to the dispatcher who created it.
    const list = await request(app).get("/api/dispatcher/drivers").set("authorization", b.auth);
    expect(list.body.map((d: { id: string }) => d.id)).toContain(create.body.id);
  });

  it("an unscoped legacy dispatcher still sees and edits everything", async () => {
    const a = await makeTenant("Alpha");
    const b = await makeTenant("Beta");
    const orgless = await prisma.driver.create({
      data: { email: "orgless@x.com", passwordHash: "x", name: "Orgless" },
    });
    const legacy = await createDispatcher({ email: "legacy@x.com" });
    const auth = `Bearer ${signDispatcherAccess(legacy.id)}`;

    const list = await request(app).get("/api/dispatcher/drivers").set("authorization", auth);
    const ids = list.body.map((d: { id: string }) => d.id);
    expect(ids).toEqual(expect.arrayContaining([a.driver.id, b.driver.id, orgless.id]));

    expect((await request(app).get(`/api/dispatcher/drivers/${a.driver.id}`).set("authorization", auth)).status)
      .toBe(200);
    expect((await request(app).get(`/api/dispatcher/drivers/${a.driver.id}/locations`).set("authorization", auth)).status)
      .toBe(200);

    // The ORGLESS driver is the case that separates "unscoped caller sees
    // everything" from "an orgless row is nobody's": the guard has to let a
    // null-org dispatcher through to a null-org driver, not 404 it.
    expect((await request(app).get(`/api/dispatcher/drivers/${orgless.id}`).set("authorization", auth)).status)
      .toBe(200);
    expect((await request(app).get(`/api/dispatcher/drivers/${orgless.id}/locations`).set("authorization", auth)).status)
      .toBe(200);
    const updOrgless = await request(app).put(`/api/dispatcher/drivers/${orgless.id}`)
      .set("authorization", auth).send({ name: "Renamed Orgless" });
    expect(updOrgless.status).toBe(200);
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: orgless.id } })).name).toBe("Renamed Orgless");

    const upd = await request(app).put(`/api/dispatcher/drivers/${a.driver.id}`)
      .set("authorization", auth).send({ name: "Renamed By Legacy" });
    expect(upd.status).toBe(200);
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: a.driver.id } })).name).toBe("Renamed By Legacy");
  });
});
