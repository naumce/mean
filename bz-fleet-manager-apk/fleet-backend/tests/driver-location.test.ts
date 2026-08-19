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
