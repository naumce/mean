import request from "supertest";
import { prisma } from "../src/db.js";
import { app, resetDb, createDriver } from "./helpers.js";
import { signAccess } from "../src/lib/tokens.js";
beforeEach(resetDb);

describe("safety", () => {
  it("persists a panic alert", async () => {
    const d = await createDriver();
    const res = await request(app).post("/api/driver/panic")
      .set("authorization", `Bearer ${signAccess(d.id)}`)
      .send({ latitude: 41.6, longitude: 21.7 });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("panic");
    expect(res.body.latitude).toBe(41.6);
    const alerts = await prisma.safetyAlert.findMany({ where: { driverId: d.id, kind: "panic" } });
    expect(alerts).toHaveLength(1);
  });

  it("persists an emergency alert with description and reason", async () => {
    const d = await createDriver();
    const res = await request(app).post("/api/driver/emergency")
      .set("authorization", `Bearer ${signAccess(d.id)}`)
      .send({ latitude: 1, longitude: 2, description: "flat tire", reason: "breakdown" });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("emergency");
    expect(res.body.description).toBe("flat tire");
    expect(res.body.reason).toBe("breakdown");
  });

  it("persists a fuel log", async () => {
    const d = await createDriver();
    const res = await request(app).post("/api/driver/fuel")
      .set("authorization", `Bearer ${signAccess(d.id)}`)
      .send({ amount: 50, cost: 75.5, odometer: 12345 });
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(50);
    expect(res.body.cost).toBe(75.5);
    const logs = await prisma.fuelLog.findMany({ where: { driverId: d.id } });
    expect(logs).toHaveLength(1);
  });
});

describe("vehicle", () => {
  it("reports a vehicle issue", async () => {
    const d = await createDriver();
    const vehicle = await prisma.vehicle.create({ data: { plate: "ABC-123" } });
    const res = await request(app).post(`/api/vehicles/${vehicle.id}/issues`)
      .set("authorization", `Bearer ${signAccess(d.id)}`)
      .send({ description: "brake noise", severity: "high" });
    expect(res.status).toBe(200);
    expect(res.body.description).toBe("brake noise");
    expect(res.body.vehicleId).toBe(vehicle.id);
    expect(res.body.driverId).toBe(d.id);
  });

  it("returns 400 reporting an issue without a description", async () => {
    const d = await createDriver();
    const vehicle = await prisma.vehicle.create({ data: { plate: "ABC-124" } });
    const res = await request(app).post(`/api/vehicles/${vehicle.id}/issues`)
      .set("authorization", `Bearer ${signAccess(d.id)}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 reporting an issue on a nonexistent vehicle", async () => {
    const d = await createDriver();
    const res = await request(app).post("/api/vehicles/does-not-exist/issues")
      .set("authorization", `Bearer ${signAccess(d.id)}`)
      .send({ description: "brake noise" });
    expect(res.status).toBe(404);
  });

  it("returns the driver's assigned vehicle", async () => {
    const d = await createDriver();
    const vehicle = await prisma.vehicle.create({ data: { plate: "ABC-125", driverId: d.id } });
    const res = await request(app).get("/api/driver/vehicle").set("authorization", `Bearer ${signAccess(d.id)}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(vehicle.id);
  });

  it("returns 404 when the driver has no assigned vehicle", async () => {
    const d = await createDriver();
    const res = await request(app).get("/api/driver/vehicle").set("authorization", `Bearer ${signAccess(d.id)}`);
    expect(res.status).toBe(404);
  });
});

describe("navigation", () => {
  it("echoes a route request with a null distance", async () => {
    const d = await createDriver();
    const res = await request(app).post("/api/navigation/route")
      .set("authorization", `Bearer ${signAccess(d.id)}`)
      .send({ origin: "A", destination: "B", waypoints: ["C"] });
    expect(res.status).toBe(200);
    expect(res.body.origin).toBe("A");
    expect(res.body.destination).toBe("B");
    expect(res.body.waypoints).toEqual(["C"]);
    expect(res.body.distance).toBeNull();
  });

  it("persists a navigation incident", async () => {
    const d = await createDriver();
    const res = await request(app).post("/api/navigation/incident")
      .set("authorization", `Bearer ${signAccess(d.id)}`)
      .send({ type: "road_closure", latitude: 1, longitude: 2, description: "closed road" });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe("road_closure");
    const incidents = await prisma.incident.findMany({ where: { driverId: d.id } });
    expect(incidents).toHaveLength(1);
  });
});
