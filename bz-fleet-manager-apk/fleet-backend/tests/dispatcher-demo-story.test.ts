import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import { STAGES } from "../src/lib/demoStory/index.js";

// Demo Mode — the HTTP surface itself: DEMO_MODE gating (absent, not
// merely refused, same convention as dispatcherDemo.ts/dispatcherSim.ts),
// response shapes, and org scoping. The story's own business behaviour is
// tests/demo-story-{reset,observe,actions}.test.ts's job.

beforeEach(resetDb);
afterEach(() => {
  delete process.env.DEMO_MODE;
});

async function seedOrgWithDispatcher(name = "Demo Story Route Org") {
  const org = await prisma.org.create({ data: { name } });
  const dispatcher = await prisma.dispatcher.create({ data: { email: `route-${org.id}@x.com`, passwordHash: "x", name: "Route Dispatcher", orgId: org.id } });
  return { org, dispatcher, auth: `Bearer ${signDispatcherAccess(dispatcher.id)}` };
}

describe("DEMO_MODE gating", () => {
  it("is ABSENT — 404 — for every /demo/story route when DEMO_MODE is unset", async () => {
    delete process.env.DEMO_MODE;
    const { auth } = await seedOrgWithDispatcher();

    const calls: Array<() => Promise<request.Response>> = [
      () => request(app).get("/api/dispatcher/demo/story").set("authorization", auth),
      () => request(app).post("/api/dispatcher/demo/story/reset").set("authorization", auth).send({}),
      () => request(app).post("/api/dispatcher/demo/story/action").set("authorization", auth).send({ action: "ask_ai" }),
    ];
    for (const call of calls) expect((await call()).status).toBe(404);
  });

  it("stays absent for any DEMO_MODE value that is not exactly \"true\"", async () => {
    const { auth } = await seedOrgWithDispatcher();
    for (const v of ["1", "yes", "TRUE", "on", ""]) {
      process.env.DEMO_MODE = v;
      const res = await request(app).get("/api/dispatcher/demo/story").set("authorization", auth);
      expect(res.status, `DEMO_MODE=${JSON.stringify(v)} must not enable this`).toBe(404);
    }
  });

  it("still requires an authenticated dispatcher when DEMO_MODE is on", async () => {
    process.env.DEMO_MODE = "true";
    const res = await request(app).get("/api/dispatcher/demo/story");
    expect(res.status).toBe(401);
  });
});

describe("GET /demo/story — shape", () => {
  it("answers a not-started view before any Reset, with the full static STAGES table", async () => {
    process.env.DEMO_MODE = "true";
    const { auth } = await seedOrgWithDispatcher();

    const res = await request(app).get("/api/dispatcher/demo/story").set("authorization", auth);

    expect(res.status).toBe(200);
    expect(res.body.story).toBeNull();
    expect(res.body.stages).toEqual(STAGES);
    expect(res.body.stages.map((s: { id: string }) => s.id)).toEqual([
      "uncovered", "ai_recommendation", "awaiting_approval", "in_transit", "breakdown_detected",
      "driver_contacted", "escalated", "customer_updated", "resolved", "delivered",
    ]);
    expect(res.body.waitingOn).toBeNull();
    expect(res.body.links).toEqual({ cockpitLoadId: null, aiRunId: null, driverId: null, agentTimelineLoadId: null });
    expect(res.body.worker).toEqual({ configured: false });
    expect(res.body.sim).toMatchObject({ running: false, speed: null, simNowMs: expect.any(Number) });
    expect(res.body.pill).toBeNull();
  });

  it("400s ORG_REQUIRED for an unscoped (legacy/dev) dispatcher", async () => {
    process.env.DEMO_MODE = "true";
    const dispatcher = await prisma.dispatcher.create({ data: { email: "unscoped@x.com", passwordHash: "x", name: "Unscoped" } });
    const auth = `Bearer ${signDispatcherAccess(dispatcher.id)}`;
    const res = await request(app).get("/api/dispatcher/demo/story").set("authorization", auth);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "ORG_REQUIRED" });
  });

  it("reports the worker as configured once WORKER_URL is set", async () => {
    process.env.DEMO_MODE = "true";
    process.env.WORKER_URL = "http://worker.invalid";
    const { auth } = await seedOrgWithDispatcher();
    const res = await request(app).get("/api/dispatcher/demo/story").set("authorization", auth);
    expect(res.body.worker).toEqual({ configured: true });
    delete process.env.WORKER_URL;
  });
});

describe("POST /demo/story/reset then GET — full shape after a Reset", () => {
  it("returns the fresh story, waitingOn ask_ai, the right links, and the load's pill", async () => {
    process.env.DEMO_MODE = "true";
    const { auth } = await seedOrgWithDispatcher();

    const resetRes = await request(app).post("/api/dispatcher/demo/story/reset").set("authorization", auth).send({});
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.story).toMatchObject({ stage: "uncovered" });

    const res = await request(app).get("/api/dispatcher/demo/story").set("authorization", auth);
    expect(res.status).toBe(200);
    const story = res.body.story;
    expect(story).toMatchObject({ stage: "uncovered", loadId: expect.any(String), driverId: expect.any(String) });
    expect(res.body.waitingOn).toBe("ask_ai");
    expect(res.body.links).toEqual({
      cockpitLoadId: story.loadId, aiRunId: story.runId, driverId: story.driverId, agentTimelineLoadId: story.loadId,
    });
    expect(res.body.pill).toBe("off");
  });

  it("400s ORG_REQUIRED for reset with an unscoped dispatcher", async () => {
    process.env.DEMO_MODE = "true";
    const dispatcher = await prisma.dispatcher.create({ data: { email: "unscoped2@x.com", passwordHash: "x", name: "Unscoped" } });
    const auth = `Bearer ${signDispatcherAccess(dispatcher.id)}`;
    const res = await request(app).post("/api/dispatcher/demo/story/reset").set("authorization", auth).send({});
    expect(res.status).toBe(400);
  });
});

describe("GET /demo/story — waitingOn while Night Shift releases the previous run", () => {
  it("answers night_shift_releasing during awaiting_approval while a fresh stop is pending, and approve once it has aged", async () => {
    process.env.DEMO_MODE = "true";
    const { org, auth } = await seedOrgWithDispatcher();
    await request(app).post("/api/dispatcher/demo/story/reset").set("authorization", auth).send({});
    const story = await prisma.demoStory.update({ where: { orgId: org.id }, data: { stage: "awaiting_approval" } });
    const stop = await prisma.agentCommand.create({ data: { loadId: story.loadId!, kind: "stop", actorName: "reset", createdAt: new Date(Date.now() - 10_000) } });

    const fresh = await request(app).get("/api/dispatcher/demo/story").set("authorization", auth);
    expect(fresh.status).toBe(200);
    expect(fresh.body.waitingOn).toBe("night_shift_releasing");

    await prisma.agentCommand.update({ where: { id: stop.id }, data: { createdAt: new Date(Date.now() - 3 * 60_000) } });
    const aged = await request(app).get("/api/dispatcher/demo/story").set("authorization", auth);
    expect(aged.body.waitingOn).toBe("approve");
  });
});

describe("cross-org isolation", () => {
  it("org A's Reset never appears in org B's GET, and org B's dispatcher cannot approve against org A's assignment", async () => {
    process.env.DEMO_MODE = "true";
    const a = await seedOrgWithDispatcher("Cross Org A");
    const b = await seedOrgWithDispatcher("Cross Org B");

    const resetA = await request(app).post("/api/dispatcher/demo/story/reset").set("authorization", a.auth).send({});
    expect(resetA.status).toBe(200);

    const getB = await request(app).get("/api/dispatcher/demo/story").set("authorization", b.auth);
    expect(getB.status).toBe(200);
    expect(getB.body.story).toBeNull(); // org B has never been reset — org A's row must not leak across

    // org B resets its own story, then tries to approve using ORG A's assignment id.
    await request(app).post("/api/dispatcher/demo/story/reset").set("authorization", b.auth).send({});
    await prisma.demoStory.update({ where: { orgId: b.org.id }, data: { stage: "awaiting_approval" } });

    const storyA = await prisma.demoStory.findUniqueOrThrow({ where: { orgId: a.org.id } });
    const tractorA = await prisma.tractor.findFirstOrThrow({ where: { orgId: a.org.id } });
    const trailerA = await prisma.trailer.findFirstOrThrow({ where: { orgId: a.org.id } });
    const assignmentA = await prisma.assignment.create({
      data: {
        orgId: a.org.id, loadId: storyA.loadId!, driverId: storyA.driverId!, tractorId: tractorA.id, trailerId: trailerA.id,
        plannedStart: new Date(), plannedEnd: new Date(Date.now() + 60 * 60_000), status: "assigned",
      },
    });

    const crossApprove = await request(app)
      .post("/api/dispatcher/demo/story/action")
      .set("authorization", b.auth)
      .send({ action: "approve", assignmentId: assignmentA.id, driverId: storyA.driverId });
    expect(crossApprove.status).toBeGreaterThanOrEqual(400);
    expect(crossApprove.status).not.toBe(200);

    // org A's own story must be completely unaffected by org B's attempt.
    const rereadA = await prisma.demoStory.findUniqueOrThrow({ where: { orgId: a.org.id } });
    expect(rereadA.stage).toBe("uncovered");
  });
});

describe("reset -> commit -> reset -> commit again", () => {
  it("the second POST /assignments succeeds — a Rate row a first commit left behind must not 409 the second run's commit", async () => {
    process.env.DEMO_MODE = "true";
    const { auth } = await seedOrgWithDispatcher();

    const firstReset = await request(app).post("/api/dispatcher/demo/story/reset").set("authorization", auth).send({});
    expect(firstReset.status).toBe(200);
    const { loadId, driverId } = firstReset.body.story as { loadId: string; driverId: string };

    const suggest = await request(app).get(`/api/dispatcher/suggest?loadId=${loadId}`).set("authorization", auth);
    expect(suggest.status).toBe(200);
    const { tractorId, trailerId } = suggest.body as { tractorId: string; trailerId: string };

    const firstCommit = await request(app)
      .post("/api/dispatcher/assignments")
      .set("authorization", auth)
      .send({ loadId, driverId, tractorId, trailerId });
    expect(firstCommit.status).toBe(201);

    const secondReset = await request(app).post("/api/dispatcher/demo/story/reset").set("authorization", auth).send({});
    expect(secondReset.status).toBe(200);
    expect(secondReset.body.story.loadId).toBe(loadId); // same row id across resets, by design

    // The exact same call as firstCommit — this is the one that 409'd before
    // the fix, with nothing else running and a plain retry unable to help.
    const secondCommit = await request(app)
      .post("/api/dispatcher/assignments")
      .set("authorization", auth)
      .send({ loadId, driverId, tractorId, trailerId });
    expect(secondCommit.status).toBe(201);
  });
});
