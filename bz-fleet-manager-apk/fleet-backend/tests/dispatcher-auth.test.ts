import request from "supertest";
import { app, resetDb, createDriver, createDispatcher } from "./helpers.js";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { signAccess, signDispatcherAccess } from "../src/lib/tokens.js";
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

it("answers the signed-in dispatcher, and refuses without a token", async () => {
  const dispatcher = await createDispatcher({
    email: "me@fleet.com", passwordHash: await hashPassword("secret123"),
  });
  const auth = `Bearer ${signDispatcherAccess(dispatcher.id)}`;
  const me = await request(app).get("/api/dispatcher/auth/me").set("authorization", auth).expect(200);
  expect(me.body.dispatcher.id).toBe(dispatcher.id);
  expect(me.body.dispatcher.email).toBe(dispatcher.email);
  expect(me.body.dispatcher).not.toHaveProperty("passwordHash");
  // The one deliberate omission from the login/signup shape — nothing in the
  // portal reads it (checked), unlike orgId below, which login/signup do
  // return and so /auth/me must too (fix round 3: a stripped orgId here was
  // the one real divergence a portal-side cast had been papering over).
  expect(me.body.dispatcher).not.toHaveProperty("createdAt");
  await request(app).get("/api/dispatcher/auth/me").expect(401);
});

it("echoes the dispatcher's org and orgId on /auth/me, same as login", async () => {
  const org = await prisma.org.create({ data: { name: "Acme Freight", timezone: "America/Denver" } });
  const dispatcher = await prisma.dispatcher.create({
    data: { email: "org-me@fleet.com", passwordHash: await hashPassword("secret123"), name: "Org Dispatcher", orgId: org.id },
  });
  const auth = `Bearer ${signDispatcherAccess(dispatcher.id)}`;
  const me = await request(app).get("/api/dispatcher/auth/me").set("authorization", auth).expect(200);
  expect(me.body.dispatcher.orgId).toBe(org.id);
  expect(me.body.org?.id).toBe(org.id);
  expect(me.body.org?.timezone).toBe("America/Denver");
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

it("signup with product=nightshift seeds a sheet plan and a link secret; default is tower", async () => {
  const a = await request(app).post("/api/auth/dispatcher/signup")
    .send({ orgName: "Sheet Co", name: "Ana", email: "ana@sheet.co", password: "pw-long-enough-1", product: "nightshift" });
  expect(a.status).toBe(201);
  // The signup response's org is an explicit field list, same as login/`/me`
  // — linkSecret must never reach a client, even the client that just made it.
  expect(a.body.org).not.toHaveProperty("linkSecret");
  const me = await request(app).get("/api/dispatcher/auth/me").set("Authorization", "Bearer " + a.body.token);
  expect(me.body.plan.tier).toBe("sheet");
  const org = await prisma.org.findUnique({ where: { id: a.body.org.id } });
  expect(org?.linkSecret).toMatch(/^[0-9a-f]{64}$/);
  const b = await request(app).post("/api/auth/dispatcher/signup")
    .send({ orgName: "Tower Co", name: "Bo", email: "bo@tower.co", password: "pw-long-enough-1" });
  const meB = await request(app).get("/api/dispatcher/auth/me").set("Authorization", "Bearer " + b.body.token);
  expect(meB.body.plan.tier).toBe("tower");
});

it("includes plan.tier on the login response's org shape, same as signup", async () => {
  await request(app).post("/api/auth/dispatcher/signup")
    .send({ orgName: "Login Plan Co", name: "Cy", email: "cy@loginplan.co", password: "pw-long-enough-1", product: "nightshift" });
  const login = await request(app).post("/api/auth/dispatcher/login")
    .send({ email: "cy@loginplan.co", password: "pw-long-enough-1" });
  expect(login.body.plan.tier).toBe("sheet");
});
