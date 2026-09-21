import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
beforeEach(resetDb);

const signup = (over: Record<string, unknown> = {}) =>
  request(app).post("/api/auth/dispatcher/signup").send({
    orgName: "Acme Freight", name: "Dana Ops", email: "dana@acme.com", password: "hunter2secret", ...over,
  });

const day = 24 * 3600 * 1000;
const FROM = new Date(Date.now() - day).toISOString();
const TO = new Date(Date.now() + day).toISOString();

it("creates an org + first dispatcher and auto-logs-in with 201", async () => {
  const res = await signup();
  expect(res.status).toBe(201);
  expect(res.body.org.name).toBe("Acme Freight");
  expect(res.body.dispatcher.email).toBe("dana@acme.com");
  expect(res.body.dispatcher.orgId).toBe(res.body.org.id);
  expect(res.body.dispatcher).not.toHaveProperty("passwordHash");
  expect(res.body.token).toBeTruthy();
  expect(res.body.refreshToken).toBeTruthy();
});

it("honors a custom timezone and defaults to America/Chicago otherwise", async () => {
  const a = await signup();
  expect(a.body.org.timezone).toBe("America/Chicago");
  const b = await signup({ email: "b@acme.com", orgName: "B Org", timezone: "America/New_York" });
  expect(b.body.org.timezone).toBe("America/New_York");
});

it("scopes the new account to its own empty org — other orgs' fleets stay invisible", async () => {
  const other = await prisma.org.create({ data: { name: "Rival Carrier" } });
  await prisma.driver.create({ data: {
    email: "rival@x.com", passwordHash: "x", name: "Rival Driver", orgId: other.id,
  } });

  const res = await signup();
  const board = await request(app)
    .get(`/api/dispatcher/loadboard?from=${FROM}&to=${TO}`)
    .set("authorization", `Bearer ${res.body.token}`);
  expect(board.status).toBe(200);
  expect(board.body.lanes).toEqual([]);
  expect(board.body.loads).toEqual([]);

  const kpis = await request(app).get("/api/dispatcher/kpis")
    .set("authorization", `Bearer ${res.body.token}`);
  expect(kpis.status).toBe(200);
  expect(kpis.body.drivers.total).toBe(0);
});

it("can log in normally after signup", async () => {
  await signup();
  const res = await request(app).post("/api/auth/dispatcher/login")
    .send({ email: "dana@acme.com", password: "hunter2secret" });
  expect(res.status).toBe(200);
  expect(res.body.dispatcher.orgId).toBeTruthy();
});

it("rejects a duplicate email with 409 and creates no orphan org", async () => {
  await signup();
  const before = await prisma.org.count();
  const res = await signup({ orgName: "Second Try" });
  expect(res.status).toBe(409);
  expect(await prisma.org.count()).toBe(before);
});

it("rejects a short password with 400", async () => {
  const res = await signup({ password: "short" });
  expect(res.status).toBe(400);
});

it("rejects a missing org name with 400", async () => {
  const res = await signup({ orgName: undefined });
  expect(res.status).toBe(400);
});
