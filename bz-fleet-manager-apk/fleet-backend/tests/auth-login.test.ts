import request from "supertest";
import { app, resetDb, createDriver } from "./helpers.js";
import { hashPassword } from "../src/lib/password.js";
beforeEach(resetDb);

it("logs in with valid credentials", async () => {
  await createDriver({ email: "drv@fleet.com", passwordHash: await hashPassword("secret123") });
  const res = await request(app).post("/api/auth/driver/login")
    .send({ email: "drv@fleet.com", password: "secret123" });
  expect(res.status).toBe(200);
  expect(res.body.token).toBeTruthy();
  expect(res.body.driver.email).toBe("drv@fleet.com");
  expect(res.body).toHaveProperty("requiresPasswordChange", false);
  expect(res.body.driver).not.toHaveProperty("passwordHash");
});

it("rejects a wrong password with 401", async () => {
  await createDriver({ email: "drv@fleet.com", passwordHash: await hashPassword("secret123") });
  const res = await request(app).post("/api/auth/driver/login")
    .send({ email: "drv@fleet.com", password: "nope" });
  expect(res.status).toBe(401);
});

it("rejects a missing field with 400", async () => {
  const res = await request(app).post("/api/auth/driver/login").send({ email: "x@y.com" });
  expect(res.status).toBe(400);
});
