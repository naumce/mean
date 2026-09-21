import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { app, resetDb, createDispatcher } from "./helpers.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import { DAY_MS } from "../src/lib/demoTimeShift.js";

// The demo time-shift rewrites every timestamp in the database. On a real
// tenant that is not a feature, it is data loss with a friendly name — so the
// gate around it is the part worth testing hardest.

const DAY = DAY_MS;
let token: string;

beforeEach(async () => {
  await resetDb();
  await prisma.demoAnchor.deleteMany();
  const org = await prisma.org.create({ data: { name: "Demo Org" } });
  const d = await createDispatcher({ email: "demo-dispatch@fleet.com" });
  await prisma.dispatcher.update({ where: { id: d.id }, data: { orgId: org.id } });
  token = signDispatcherAccess(d.id);
});

afterEach(() => {
  delete process.env.DEMO_MODE;
});

const auth = (r: request.Test) => r.set("authorization", `Bearer ${token}`);

describe("demo time-shift endpoint", () => {
  it("is ABSENT, not merely refused, when DEMO_MODE is off", async () => {
    // 404 rather than 403 deliberately: a 403 confirms the endpoint exists and
    // invites someone to go hunting for the flag that switches it on.
    delete process.env.DEMO_MODE;
    const post = await auth(request(app).post("/api/dispatcher/demo/shift"));
    expect(post.status).toBe(404);
    const get = await auth(request(app).get("/api/dispatcher/demo/shift"));
    expect(get.status).toBe(404);
  });

  it("stays absent for any value that is not exactly \"true\"", async () => {
    // "1", "yes" and "TRUE" are the values a hurried environment file grows.
    // None of them may open a hole that rewrites a customer's timestamps.
    for (const v of ["1", "yes", "TRUE", "on", ""]) {
      process.env.DEMO_MODE = v;
      const res = await auth(request(app).post("/api/dispatcher/demo/shift"));
      expect(res.status, `DEMO_MODE=${JSON.stringify(v)} must not enable this`).toBe(404);
    }
  });

  it("still requires an authenticated dispatcher when DEMO_MODE is on", async () => {
    process.env.DEMO_MODE = "true";
    const res = await request(app).post("/api/dispatcher/demo/shift");
    expect(res.status).toBe(401);
  });

  it("previews the move without performing it", async () => {
    process.env.DEMO_MODE = "true";
    const anchor = new Date(Date.now() - 4 * DAY - 3_600_000);
    await prisma.demoAnchor.create({ data: { id: "singleton", anchorAt: anchor } });

    const res = await auth(request(app).get("/api/dispatcher/demo/shift"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ shifted: true, days: 4 });

    // The preview must not have moved anything.
    const after = await prisma.demoAnchor.findFirstOrThrow();
    expect(after.anchorAt.getTime()).toBe(anchor.getTime());
  });

  it("moves the scenario and reports how far", async () => {
    process.env.DEMO_MODE = "true";
    const anchor = new Date(Date.now() - 3 * DAY - 3_600_000);
    await prisma.demoAnchor.create({ data: { id: "singleton", anchorAt: anchor } });
    const org = await prisma.org.create({ data: { name: "Shifted", createdAt: anchor } });

    const res = await auth(request(app).post("/api/dispatcher/demo/shift"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ shifted: true, days: 3 });

    const moved = await prisma.org.findUniqueOrThrow({ where: { id: org.id } });
    expect(moved.createdAt.getTime()).toBe(anchor.getTime() + 3 * DAY);
  });

  it("answers 200 with a reason when there is nothing to move", async () => {
    // Pressing the button twice is expected behaviour, not an error, and the
    // UI should not have to render a failure for it.
    process.env.DEMO_MODE = "true";
    await prisma.demoAnchor.create({ data: { id: "singleton", anchorAt: new Date() } });
    const res = await auth(request(app).post("/api/dispatcher/demo/shift"));
    expect(res.status).toBe(200);
    expect(res.body.shifted).toBe(false);
    expect(res.body.reason).toMatch(/already current/i);
  });
});
