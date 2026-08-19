import request from "supertest";
import { prisma } from "../src/db.js";
import { app, resetDb, createDriver } from "./helpers.js";
import { signAccess } from "../src/lib/tokens.js";
beforeEach(resetDb);

it("returns null when there is no current session", async () => {
  const d = await createDriver();
  const res = await request(app).get("/api/driver/session").set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(200);
  expect(res.body).toBeNull();
});

it("starts a session", async () => {
  const d = await createDriver();
  const res = await request(app).post("/api/driver/session/start").set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("active");
  expect(res.body.startedAt).toBeTruthy();

  const current = await request(app).get("/api/driver/session").set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(current.body.id).toBe(res.body.id);
});

it("returns 409 starting a second session while one is already active", async () => {
  const d = await createDriver();
  await request(app).post("/api/driver/session/start").set("authorization", `Bearer ${signAccess(d.id)}`);
  const res = await request(app).post("/api/driver/session/start").set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(409);
});

it("toggles a break on and accumulates totalBreakMs when toggled back off", async () => {
  const d = await createDriver();
  await request(app).post("/api/driver/session/start").set("authorization", `Bearer ${signAccess(d.id)}`);

  const onBreak = await request(app).post("/api/driver/session/break").set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(onBreak.status).toBe(200);
  expect(onBreak.body.status).toBe("on_break");
  expect(onBreak.body.breakStartedAt).toBeTruthy();

  // force the break to have "elapsed" so accumulation is observable
  await prisma.driverSession.update({
    where: { id: onBreak.body.id },
    data: { breakStartedAt: new Date(Date.now() - 60_000) },
  });

  const offBreak = await request(app).post("/api/driver/session/break").set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(offBreak.status).toBe(200);
  expect(offBreak.body.status).toBe("active");
  expect(offBreak.body.breakStartedAt).toBeNull();
  expect(offBreak.body.totalBreakMs).toBeGreaterThanOrEqual(60_000);
});

it("returns 404 toggling a break with no active session", async () => {
  const d = await createDriver();
  const res = await request(app).post("/api/driver/session/break").set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(404);
});

it("ends a session", async () => {
  const d = await createDriver();
  await request(app).post("/api/driver/session/start").set("authorization", `Bearer ${signAccess(d.id)}`);
  const res = await request(app).post("/api/driver/session/end").set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("ended");
  expect(res.body.endedAt).toBeTruthy();

  const current = await request(app).get("/api/driver/session").set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(current.body).toBeNull();
});

it("allows starting a new session after the previous one ended", async () => {
  const d = await createDriver();
  await request(app).post("/api/driver/session/start").set("authorization", `Bearer ${signAccess(d.id)}`);
  await request(app).post("/api/driver/session/end").set("authorization", `Bearer ${signAccess(d.id)}`);
  const res = await request(app).post("/api/driver/session/start").set("authorization", `Bearer ${signAccess(d.id)}`);
  expect(res.status).toBe(200);
});

it("never returns another driver's session as the caller's current session", async () => {
  const me = await createDriver({ email: "me@f.com" });
  const other = await createDriver({ email: "other@f.com" });
  await request(app).post("/api/driver/session/start").set("authorization", `Bearer ${signAccess(other.id)}`);
  const res = await request(app).get("/api/driver/session").set("authorization", `Bearer ${signAccess(me.id)}`);
  expect(res.status).toBe(200);
  expect(res.body).toBeNull();
});

it("returns 404 ending another driver's session (no active session of my own)", async () => {
  const me = await createDriver({ email: "me@f.com" });
  const other = await createDriver({ email: "other@f.com" });
  await request(app).post("/api/driver/session/start").set("authorization", `Bearer ${signAccess(other.id)}`);
  const res = await request(app).post("/api/driver/session/end").set("authorization", `Bearer ${signAccess(me.id)}`);
  expect(res.status).toBe(404);
});
