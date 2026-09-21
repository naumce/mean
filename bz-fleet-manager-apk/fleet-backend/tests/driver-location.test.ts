import request from "supertest";
import { prisma } from "../src/db.js";
import { app, resetDb, createDriver } from "./helpers.js";
import { signAccess } from "../src/lib/tokens.js";
beforeEach(resetDb);

it("driver posts a location which is persisted and dispatcher-readable", async () => {
  const d = await createDriver();
  const res = await request(app).post("/api/driver/location")
    .set("authorization", `Bearer ${signAccess(d.id)}`)
    .send({ latitude: 41.99, longitude: 21.42, speed: 30 });
  expect(res.status).toBe(201);
  const rows = await prisma.driverLocation.findMany({ where: { driverId: d.id } });
  expect(rows).toHaveLength(1);
  expect(rows[0].latitude).toBeCloseTo(41.99);
});

it("a location post refreshes Driver.lastLat/lastLng for the dispatch engine", async () => {
  const d = await createDriver();
  await request(app).post("/api/driver/location")
    .set("authorization", `Bearer ${signAccess(d.id)}`)
    .send({ latitude: 39.0997, longitude: -94.5786 });
  const fresh = await prisma.driver.findUniqueOrThrow({ where: { id: d.id } });
  expect(fresh.lastLat).toBeCloseTo(39.0997);
  expect(fresh.lastLng).toBeCloseTo(-94.5786);
  expect(fresh.lastLocationAt).not.toBeNull();
});

it("rejects an out-of-range coordinate with 400", async () => {
  const d = await createDriver();
  const res = await request(app).post("/api/driver/location")
    .set("authorization", `Bearer ${signAccess(d.id)}`)
    .send({ latitude: 91, longitude: 0 });
  expect(res.status).toBe(400);
});

it("rejects a location post without auth", async () => {
  const res = await request(app).post("/api/driver/location").send({ latitude: 1, longitude: 2 });
  expect(res.status).toBe(401);
});

it("rejects an invalid location body", async () => {
  const d = await createDriver();
  const res = await request(app).post("/api/driver/location")
    .set("authorization", `Bearer ${signAccess(d.id)}`).send({ latitude: "nope" });
  expect(res.status).toBe(400);
});
