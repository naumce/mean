import request from "supertest";
import { app, resetDb } from "./helpers.js";
import { prisma } from "../src/db.js";
import { signDispatcherAccess } from "../src/lib/tokens.js";
import { resetDemo } from "../src/lib/demoStory/index.js";
import { DEMO_TRACTOR_UNIT, DEMO_TRAILER_UNIT } from "../src/lib/demoStory/fixtures.js";
import type { DemoStory, Prisma } from "@prisma/client";

// Demo Mode — POST /demo/story/action: the seven actions and their stage
// guards, hit over HTTP so the 409/503/400 status codes are the thing under
// test, not just the thrown error classes. The runner is stubbed (its own
// real interval/engine wiring is simulation.test.ts's job; the story's own
// use of it is demo-story-observe.test.ts's); the harness is left disabled
// (no OLLAMA_URL) so askAi's "straight to engine" path is what runs here —
// the harness's own queue is ai-harness-runner.test.ts's job.

vi.mock("../src/lib/simulation/runner.js", () => ({
  startRunner: vi.fn(),
  stopRunner: vi.fn(),
  runnerState: vi.fn(() => ({ running: false, speed: null })),
}));
import { startRunner, stopRunner } from "../src/lib/simulation/runner.js";

beforeEach(() => {
  process.env.DEMO_MODE = "true";
  delete process.env.OLLAMA_URL;
  delete process.env.WORKER_URL;
  vi.mocked(startRunner).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.DEMO_MODE;
  delete process.env.WORKER_URL;
});

beforeEach(resetDb);

const MIN = 60_000;
const HOUR = 60 * MIN;

async function seedStory(stage: string, patch: Prisma.DemoStoryUpdateInput = {}): Promise<{ orgId: string; auth: string; story: DemoStory }> {
  const org = await prisma.org.create({ data: { name: `Action Org ${Math.random().toString(36).slice(2)}` } });
  const dispatcher = await prisma.dispatcher.create({ data: { email: `act-${org.id}@x.com`, passwordHash: "x", name: "Act Dispatcher", orgId: org.id } });
  await resetDemo(org.id, dispatcher.id);
  const story = await prisma.demoStory.update({ where: { orgId: org.id }, data: { stage, ...patch } });
  return { orgId: org.id, auth: `Bearer ${signDispatcherAccess(dispatcher.id)}`, story };
}

async function createAssignment(orgId: string, story: DemoStory, overrides: Partial<{ status: string; plannedStart: Date; plannedEnd: Date; driverId: string }> = {}) {
  const tractor = await prisma.tractor.findFirstOrThrow({ where: { orgId, unit: DEMO_TRACTOR_UNIT } });
  const trailer = await prisma.trailer.findFirstOrThrow({ where: { orgId, unit: DEMO_TRAILER_UNIT } });
  const plannedStart = overrides.plannedStart ?? new Date(Date.now() - 10 * MIN);
  const plannedEnd = overrides.plannedEnd ?? new Date(Date.now() + 50 * MIN);
  const status = overrides.status ?? "assigned";
  return prisma.assignment.create({
    data: {
      orgId, loadId: story.loadId!, driverId: overrides.driverId ?? story.driverId!, tractorId: tractor.id, trailerId: trailer.id,
      plannedStart, plannedEnd, status, startedAt: status === "in_progress" ? plannedStart : null,
    },
  });
}

async function createTrip(loadId: string, id: string) {
  return prisma.agentTrip.create({ data: { id, loadRef: "DEMO-CHI-DET", loadId, driverToken: `${id}-token`, brief: {}, status: "tracking" } });
}

function postAction(auth: string, body: Record<string, unknown>) {
  return request(app).post("/api/dispatcher/demo/story/action").set("authorization", auth).send(body);
}

const logTexts = (story: { log: { text: string }[] }): string[] => story.log.map((l) => l.text);

describe("POST /demo/story/action — stage guards", () => {
  const cases: { action: string; wrongStage: string; body?: Record<string, unknown> }[] = [
    { action: "ask_ai", wrongStage: "in_transit" },
    { action: "approve", wrongStage: "uncovered", body: { assignmentId: "x", driverId: "y" } },
    { action: "driver_reply", wrongStage: "uncovered", body: { text: "hi" } },
    { action: "customer_update_sent", wrongStage: "uncovered" },
    { action: "resolve", wrongStage: "uncovered" },
    { action: "skip_arrival", wrongStage: "uncovered" },
    { action: "next", wrongStage: "in_transit" },
  ];

  for (const { action, wrongStage, body } of cases) {
    it(`${action} 409s from "${wrongStage}"`, async () => {
      const { auth } = await seedStory(wrongStage);
      const res = await postAction(auth, { action, ...body });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "WRONG_STAGE", stage: wrongStage });
    });
  }
});

describe("POST /demo/story/action — ask_ai", () => {
  it("harness disabled: moves to ai_recommendation with no run queued", async () => {
    const { auth, orgId, story } = await seedStory("uncovered");
    const res = await postAction(auth, { action: "ask_ai" });
    expect(res.status).toBe(200);
    expect(res.body.story).toMatchObject({ stage: "ai_recommendation", runId: null });

    const reread = await prisma.demoStory.findUniqueOrThrow({ where: { orgId } });
    expect((reread.log as { text: string }[]).at(-1)?.text).toBe("Asking AI for a recommendation.");
    expect(story.stage).toBe("uncovered"); // sanity: seedStory itself did not advance it
  });
});

describe("POST /demo/story/action — approve", () => {
  it("verifies the assignment, switches the agent on (pill watching), starts the runner, records the run's verdict, and moves to in_transit", async () => {
    const { auth, orgId, story } = await seedStory("awaiting_approval");
    const run = await prisma.aiDecisionRecord.create({
      data: { experimentId: story.experimentId!, orgId, loadId: story.loadId, kind: "dispatch_candidate", status: "proposed", context: {}, toolCalls: [], toolResults: [] },
    });
    await prisma.demoStory.update({ where: { orgId }, data: { runId: run.id } });
    const assignment = await createAssignment(orgId, story);

    const res = await postAction(auth, { action: "approve", assignmentId: assignment.id, driverId: story.driverId });

    expect(res.status).toBe(200);
    expect(res.body.story).toMatchObject({ stage: "in_transit", assignmentId: assignment.id, driverId: story.driverId });
    expect(logTexts(res.body.story)).toContain("Approved: John Carter assigned. Night Shift is watching this load.");

    const load = await prisma.load.findUniqueOrThrow({ where: { id: story.loadId! } });
    expect(load).toMatchObject({ agentEnabled: true, agentPill: "watching", agentPolicyId: story.policyId });
    expect(startRunner).toHaveBeenCalledWith(orgId, 3);
    const simState = await prisma.simDriverState.findUniqueOrThrow({ where: { driverId: story.driverId! } });
    expect(simState.mode).toBe("auto");

    const decidedRun = await prisma.aiDecisionRecord.findUniqueOrThrow({ where: { id: run.id } });
    expect(decidedRun.humanDecision).toMatchObject({ verdict: "accept", driverId: story.driverId });
    expect(decidedRun.decidedAt).toBeTruthy();
  });

  it("tightens the delivery window to a wall-clock 3.5 h from approval (no windowStart) and narrates the deadline", async () => {
    const { auth, orgId, story } = await seedStory("awaiting_approval");
    const assignment = await createAssignment(orgId, story);
    const before = await prisma.loadStop.findFirstOrThrow({ where: { loadId: story.loadId!, type: "delivery" }, include: { appointment: true } });
    expect(before.appointment!.windowEnd.getTime() - Date.now()).toBeGreaterThan(20 * HOUR); // generous until now

    const approvedAt = Date.now();
    const res = await postAction(auth, { action: "approve", assignmentId: assignment.id, driverId: story.driverId });
    expect(res.status).toBe(200);

    const after = await prisma.loadStop.findFirstOrThrow({ where: { loadId: story.loadId!, type: "delivery" }, include: { appointment: true } });
    expect(after.appointment!.windowStart).toBeNull();
    expect(Math.abs(after.appointment!.windowEnd.getTime() - (approvedAt + 3.5 * HOUR))).toBeLessThan(30_000);
    expect(logTexts(res.body.story).at(-1)).toMatch(/^Tight customer window: delivery due by \d{2}:\d{2}\.$/);
  });

  it("discards a stale pending stop (older than two worker polls) before switching on, leaving applied history and other kinds alone", async () => {
    const { auth, orgId, story } = await seedStory("awaiting_approval");
    const assignment = await createAssignment(orgId, story);
    await prisma.agentCommand.create({ data: { loadId: story.loadId!, kind: "stop", actorName: "reset", createdAt: new Date(Date.now() - 3 * MIN) } });
    const applied = await prisma.agentCommand.create({ data: { loadId: story.loadId!, kind: "stop", actorName: "earlier", appliedAt: new Date() } });
    const other = await prisma.agentCommand.create({ data: { loadId: story.loadId!, kind: "reply", payload: { text: "x" }, actorName: "someone" } });

    const res = await postAction(auth, { action: "approve", assignmentId: assignment.id, driverId: story.driverId });
    expect(res.status).toBe(200);

    expect(await prisma.agentCommand.count({ where: { loadId: story.loadId!, kind: "stop", appliedAt: null } })).toBe(0);
    expect(await prisma.agentCommand.findUnique({ where: { id: applied.id } })).not.toBeNull();
    expect(await prisma.agentCommand.findUnique({ where: { id: other.id } })).not.toBeNull();
  });

  it("refuses with 409 NIGHT_SHIFT_RELEASING while the reset's stop is still fresh, changing nothing", async () => {
    const { auth, orgId, story } = await seedStory("awaiting_approval");
    const assignment = await createAssignment(orgId, story);
    const stop = await prisma.agentCommand.create({ data: { loadId: story.loadId!, kind: "stop", actorName: "reset", createdAt: new Date(Date.now() - 10_000) } });

    const res = await postAction(auth, { action: "approve", assignmentId: assignment.id, driverId: story.driverId });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "NIGHT_SHIFT_RELEASING", message: "Night Shift is still releasing the previous demo — try again in a minute." });
    const reread = await prisma.demoStory.findUniqueOrThrow({ where: { orgId } });
    expect(reread).toMatchObject({ stage: "awaiting_approval", assignmentId: null });
    expect(await prisma.agentCommand.findUnique({ where: { id: stop.id } })).not.toBeNull();
    const load = await prisma.load.findUniqueOrThrow({ where: { id: story.loadId! } });
    expect(load.agentEnabled).toBe(false);
    expect(startRunner).not.toHaveBeenCalled();
    const delivery = await prisma.loadStop.findFirstOrThrow({ where: { loadId: story.loadId!, type: "delivery" }, include: { appointment: true } });
    expect(delivery.appointment!.windowEnd.getTime() - Date.now()).toBeGreaterThan(20 * HOUR); // not tightened either
  });

  it("clears a lock another dispatcher holds on the demo load before switching the agent on", async () => {
    const { auth, orgId, story } = await seedStory("awaiting_approval");
    const assignment = await createAssignment(orgId, story);
    const other = await prisma.dispatcher.create({ data: { email: `lock-${orgId}@x.com`, passwordHash: "x", name: "Other Dispatcher", orgId } });
    await prisma.loadLock.create({ data: { loadId: story.loadId!, orgId, dispatcherId: other.id, dispatcherName: other.name, expiresAt: new Date(Date.now() + 60_000) } });

    const res = await postAction(auth, { action: "approve", assignmentId: assignment.id, driverId: story.driverId });

    expect(res.status).toBe(200);
    expect(res.body.story.stage).toBe("in_transit");
    expect(await prisma.loadLock.findUnique({ where: { loadId: story.loadId! } })).toBeNull();
    const load = await prisma.load.findUniqueOrThrow({ where: { id: story.loadId! } });
    expect(load).toMatchObject({ agentEnabled: true, agentPill: "watching" });
  });

  it("adopts whoever the assignment names as the story's driver", async () => {
    const { auth, orgId, story } = await seedStory("awaiting_approval");
    const other = await prisma.driver.create({ data: { email: `other-${orgId}@x.com`, passwordHash: "x", name: "Maria Lopez", orgId, phone: "+15550100002" } });
    const assignment = await createAssignment(orgId, story, { driverId: other.id });

    const res = await postAction(auth, { action: "approve", assignmentId: assignment.id, driverId: other.id });

    expect(res.status).toBe(200);
    expect(res.body.story).toMatchObject({ stage: "in_transit", driverId: other.id });
    expect(logTexts(res.body.story)).toContain("Approved: Maria Lopez assigned. Night Shift is watching this load.");
    const simState = await prisma.simDriverState.findUniqueOrThrow({ where: { driverId: other.id } });
    expect(simState.mode).toBe("auto");
    const john = await prisma.driver.findUniqueOrThrow({ where: { id: story.driverId! } });
    expect(john.name).toBe("John Carter"); // the fixture is untouched
  });

  it("400s when assignmentId/driverId are missing", async () => {
    const { auth } = await seedStory("awaiting_approval");
    const res = await postAction(auth, { action: "approve" });
    expect(res.status).toBe(400);
  });

  it("400s INVALID_ACTION for an assignment whose driver is not the one named", async () => {
    const { auth, orgId, story } = await seedStory("awaiting_approval");
    const otherDriver = await prisma.driver.create({ data: { email: `other-${orgId}@x.com`, passwordHash: "x", name: "Someone Else", orgId } });
    const assignment = await createAssignment(orgId, story);

    const res = await postAction(auth, { action: "approve", assignmentId: assignment.id, driverId: otherDriver.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_ACTION");
    const reread = await prisma.demoStory.findUniqueOrThrow({ where: { orgId } });
    expect(reread.stage).toBe("awaiting_approval");
  });
});

describe("POST /demo/story/action — driver_reply", () => {
  it("503s WORKER_UNAVAILABLE when WORKER_URL is unset", async () => {
    const { auth, story } = await seedStory("awaiting_driver_reply");
    await createTrip(story.loadId!, "act-trip-1");

    const res = await postAction(auth, { action: "driver_reply", text: "I'm okay, engine trouble" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("WORKER_UNAVAILABLE");
  });

  it("503s WORKER_UNAVAILABLE when there is no AgentTrip yet", async () => {
    process.env.WORKER_URL = "http://worker.invalid";
    const { auth } = await seedStory("awaiting_driver_reply");
    const res = await postAction(auth, { action: "driver_reply", text: "hello" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("WORKER_UNAVAILABLE");
  });

  it("proxies to the worker's real driver-link endpoint and logs the reply", async () => {
    process.env.WORKER_URL = "http://worker.invalid";
    const { auth, story } = await seedStory("awaiting_driver_reply");
    await createTrip(story.loadId!, "act-trip-2");
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await postAction(auth, { action: "driver_reply", text: "engine trouble, pulled over" });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://worker.invalid/d/act-trip-2-token/reply",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ text: "engine trouble, pulled over" }) }),
    );
    expect(logTexts(res.body.story).at(-1)).toBe('John: "engine trouble, pulled over"');
    // driver_reply never advances the stage itself — observeStory's own
    // awaiting_driver_reply heartbeat reacts to whatever Night Shift does next.
    expect(res.body.story.stage).toBe("awaiting_driver_reply");
  });

  it("503s with the status in the message when the worker answers non-2xx (a 404 after a worker restart), logging nothing", async () => {
    process.env.WORKER_URL = "http://worker.invalid";
    const { auth, orgId, story } = await seedStory("awaiting_driver_reply");
    await createTrip(story.loadId!, "act-trip-3");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    const before = (await prisma.demoStory.findUniqueOrThrow({ where: { orgId } })).log as unknown[];

    const res = await postAction(auth, { action: "driver_reply", text: "engine trouble" });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "WORKER_UNAVAILABLE", message: expect.stringContaining("404") });
    const after = (await prisma.demoStory.findUniqueOrThrow({ where: { orgId } })).log as unknown[];
    expect(after).toHaveLength(before.length);
  });

  it("503s when the worker cannot be reached at all", async () => {
    process.env.WORKER_URL = "http://worker.invalid";
    const { auth, story } = await seedStory("awaiting_driver_reply");
    await createTrip(story.loadId!, "act-trip-4");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));

    const res = await postAction(auth, { action: "driver_reply", text: "engine trouble" });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "WORKER_UNAVAILABLE", message: expect.stringContaining("ECONNREFUSED") });
  });

  it("400s with no text", async () => {
    const { auth } = await seedStory("awaiting_driver_reply");
    const res = await postAction(auth, { action: "driver_reply" });
    expect(res.status).toBe(400);
  });
});

describe("POST /demo/story/action — customer_update_sent and resolve (the thaw)", () => {
  it("customer_update_sent moves awaiting_customer_update -> customer_updated, wakes the driver and restarts the runner", async () => {
    const { auth, orgId, story } = await seedStory("awaiting_customer_update");
    await prisma.simDriverState.create({ data: { driverId: story.driverId!, mode: "stopped" } });

    const res = await postAction(auth, { action: "customer_update_sent" });
    expect(res.status).toBe(200);
    expect(res.body.story.stage).toBe("customer_updated");
    const simState = await prisma.simDriverState.findUniqueOrThrow({ where: { driverId: story.driverId! } });
    expect(simState.mode).toBe("auto");
    expect(startRunner).toHaveBeenCalledWith(orgId, 3);
  });

  it("resolve works from awaiting_customer_update (no draft was ever attached) and restarts the runner", async () => {
    const { auth, orgId, story } = await seedStory("awaiting_customer_update");
    await prisma.simDriverState.create({ data: { driverId: story.driverId!, mode: "stopped" } });

    const res = await postAction(auth, { action: "resolve" });
    expect(res.status).toBe(200);
    expect(res.body.story.stage).toBe("resolved");
    expect((await prisma.simDriverState.findUniqueOrThrow({ where: { driverId: story.driverId! } })).mode).toBe("auto");
    expect(startRunner).toHaveBeenCalledWith(orgId, 3);
  });

  it("resolve works from customer_updated (the normal path)", async () => {
    const { auth } = await seedStory("customer_updated");
    const res = await postAction(auth, { action: "resolve" });
    expect(res.status).toBe(200);
    expect(res.body.story.stage).toBe("resolved");
  });

  it("resolve is idempotent: a second call while already resolved changes nothing and does not restart the runner", async () => {
    const { auth } = await seedStory("customer_updated");
    const first = await postAction(auth, { action: "resolve" });
    expect(first.status).toBe(200);
    vi.mocked(startRunner).mockClear();

    const second = await postAction(auth, { action: "resolve" });
    expect(second.status).toBe(200);
    expect(second.body.story.stage).toBe("resolved");
    expect(second.body.story.log).toEqual(first.body.story.log);
    expect(startRunner).not.toHaveBeenCalled();
  });
});

describe("POST /demo/story/action — skip_arrival", () => {
  it("switches the agent off (clearing another dispatcher's lock first) and completes the delivery via a real tick", async () => {
    const { auth, orgId, story } = await seedStory("delivering", { holdStartedAt: new Date() });
    await prisma.load.update({ where: { id: story.loadId! }, data: { agentEnabled: true, agentPill: "watching" } });
    await createAssignment(orgId, story, { status: "in_progress", plannedStart: new Date(Date.now() - 119 * MIN), plannedEnd: new Date(Date.now() + 1 * MIN) });
    const other = await prisma.dispatcher.create({ data: { email: `lock-${orgId}@x.com`, passwordHash: "x", name: "Other Dispatcher", orgId } });
    await prisma.loadLock.create({ data: { loadId: story.loadId!, orgId, dispatcherId: other.id, dispatcherName: other.name, expiresAt: new Date(Date.now() + 60_000) } });

    const res = await postAction(auth, { action: "skip_arrival" });

    expect(res.status).toBe(200);
    expect(res.body.story.stage).toBe("delivered");
    expect(logTexts(res.body.story).at(-1)).toBe("Delivered (arrival wait skipped).");

    const load = await prisma.load.findUniqueOrThrow({ where: { id: story.loadId! } });
    expect(load.agentEnabled).toBe(false);
    expect(await prisma.loadLock.findUnique({ where: { loadId: story.loadId! } })).toBeNull();
    const assignment = await prisma.assignment.findFirstOrThrow({ where: { loadId: story.loadId! } });
    expect(assignment.status).toBe("completed");
  });
});

describe("POST /demo/story/action — next", () => {
  it("uncovered -> the same effect as ask_ai", async () => {
    const { auth } = await seedStory("uncovered");
    const res = await postAction(auth, { action: "next" });
    expect(res.status).toBe(200);
    expect(res.body.story.stage).toBe("ai_recommendation");
  });

  it("customer_updated -> the same effect as resolve", async () => {
    const { auth } = await seedStory("customer_updated");
    const res = await postAction(auth, { action: "next" });
    expect(res.status).toBe(200);
    expect(res.body.story.stage).toBe("resolved");
  });
});

// Sanity: stopRunner is imported so the stub is provably wired for this
// file's mock factory even though no test above asserts a call to it
// directly (resetDemo's own purge is what calls it, exercised in
// demo-story-reset.test.ts against the REAL runner).
void stopRunner;
