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
