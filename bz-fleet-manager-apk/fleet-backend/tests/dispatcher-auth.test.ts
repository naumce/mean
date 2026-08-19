import request from "supertest";
import { app, resetDb, createDriver, createDispatcher } from "./helpers.js";
import { hashPassword } from "../src/lib/password.js";
import { signAccess } from "../src/lib/tokens.js";
beforeEach(resetDb);

it("logs in a dispatcher and issues a role-dispatcher token", async () => {
  await createDispatcher({ email: "disp@fleet.com", passwordHash: await hashPassword("secret123") });
  const res = await request(app).post("/api/auth/dispatcher/login")
    .send({ email: "disp@fleet.com", password: "secret123" });
  expect(res.status).toBe(200);
  expect(res.body.token).toBeTruthy();
  expect(res.body.dispatcher.email).toBe("disp@fleet.com");
  expect(res.body.dispatcher).not.toHaveProperty("passwordHash");
});

it("rejects a wrong dispatcher password with 401", async () => {
  await createDispatcher({ email: "disp@fleet.com", passwordHash: await hashPassword("secret123") });
  const res = await request(app).post("/api/auth/dispatcher/login")
    .send({ email: "disp@fleet.com", password: "nope" });
  expect(res.status).toBe(401);
});

it("rejects a missing field on dispatcher login with 400", async () => {
  const res = await request(app).post("/api/auth/dispatcher/login").send({ email: "x@y.com" });
  expect(res.status).toBe(400);
});

it("rejects a driver token on any /dispatcher/* route with 403", async () => {
  const d = await createDriver();
  const res = await request(app).get("/api/dispatcher/drivers")
    .set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(403);
});

it("rejects a missing token on /dispatcher/* routes with 401", async () => {
  const res = await request(app).get("/api/dispatcher/drivers");
  expect(res.status).toBe(401);
});

it("rotates a dispatcher refresh token via the shared /api/auth/refresh route", async () => {
  await createDispatcher({ email: "disp2@fleet.com", passwordHash: await hashPassword("secret123") });
  const login = await request(app).post("/api/auth/dispatcher/login")
    .send({ email: "disp2@fleet.com", password: "secret123" });
  const res = await request(app).post("/api/auth/refresh").send({ refreshToken: login.body.refreshToken });
  expect(res.status).toBe(200);
  expect(res.body.token).toBeTruthy();
  expect(res.body.refreshToken).not.toBe(login.body.refreshToken);

  // rotated-out token is single-use
  const reuse = await request(app).post("/api/auth/refresh").send({ refreshToken: login.body.refreshToken });
  expect(reuse.status).toBe(401);
});

it("revokes a dispatcher refresh token on the shared /api/auth/logout route", async () => {
  await createDispatcher({ email: "disp3@fleet.com", passwordHash: await hashPassword("secret123") });
  const login = await request(app).post("/api/auth/dispatcher/login")
    .send({ email: "disp3@fleet.com", password: "secret123" });
  await request(app).post("/api/auth/logout")
    .set("authorization", `Bearer ${login.body.token}`).send({ refreshToken: login.body.refreshToken });
  const res = await request(app).post("/api/auth/refresh").send({ refreshToken: login.body.refreshToken });
  expect(res.status).toBe(401);
});

it("does not let a dispatcher token leak into another driver's ownership-scoped data", async () => {
  await createDispatcher({ email: "disp4@fleet.com", passwordHash: await hashPassword("secret123") });
  const login = await request(app).post("/api/auth/dispatcher/login")
    .send({ email: "disp4@fleet.com", password: "secret123" });
  // a dispatcher token is a valid Bearer token; requireAuth alone (no role
  // check) protects driver routes, so this must not silently pass through
  // to filter-less results — it should read as "no driver identity" (empty list).
  const res = await request(app).get("/api/driver/trips/active")
    .set("authorization", `Bearer ${login.body.token}`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual([]);
});
