import { prisma } from "../src/db.js";
import { resetDb } from "./helpers.js";
import { observeStory } from "../src/lib/demoStory/index.js";
import { DETROIT_DELIVERY } from "../src/lib/demoStory/fixtures.js";
import { runnerState, startRunner } from "../src/lib/simulation/runner.js";
import * as engineModule from "../src/lib/simulation/engine.js";
import * as realtimeModule from "../src/realtime.js";
import { DETROIT, MIN, addEvent, createAssignment, createTrip, logTexts, planAt, seedStory, simMinutes, stopSeededRunners } from "./demoStoryTestHelpers.js";

// Demo Mode — observeStory from "customer_updated" to "delivered": the truck
// moving again under the runner, the approach guard, the observe-driven
// last miles, the dock hold and its three exits. The runner is the REAL one
// (started per test where the clock rule is under test, stopped again in
// afterEach); every call passes an explicit `nowMs` so the plan fraction the
// story sees is exact — and the hold test advances it per poll, because the
// engine's clock follows the wall clock even while the truck stands still.

beforeEach(resetDb);
afterEach(() => {
  stopSeededRunners();
  vi.restoreAllMocks();
});

const pendingStops = (loadId: string) => prisma.agentCommand.count({ where: { loadId, kind: "stop", appliedAt: null } });

describe("observeStory — customer_updated", () => {
  it("a resolved unplanned_stop anomaly event moves the story to resolved", async () => {
    const { orgId, story } = await seedStory("customer_updated");
    const trip = await createTrip(story.loadId!);
    await addEvent(trip.id, "anomaly", { key: "unplanned_stop@x", resolved: true });

    const result = await observeStory(orgId);
    expect(result?.stage).toBe("resolved");
  });

  it("a resolved anomaly of another kind (the delay clearing) is not the stop clearing", async () => {
    const { orgId, story } = await seedStory("customer_updated");
    const trip = await createTrip(story.loadId!);
    await addEvent(trip.id, "anomaly", { key: "delay", resolved: true });

    const result = await observeStory(orgId);
    expect(result?.stage).toBe("customer_updated");
  });

  it("falls back to resolved after 3 minutes with no resolved event", async () => {
    const { orgId } = await seedStory("customer_updated");
    await prisma.demoStory.update({ where: { orgId }, data: { updatedAt: new Date(Date.now() - 4 * MIN) } });

    const result = await observeStory(orgId);
    expect(result?.stage).toBe("resolved");
  });

  it("stays put under 3 minutes with no resolved event", async () => {
    const { orgId } = await seedStory("customer_updated");
    const result = await observeStory(orgId);
    expect(result?.stage).toBe("customer_updated");
  });

  it("stops the runner once the truck reaches 90% of the plan while still waiting, so the engine cannot deliver it", async () => {
    const now = Date.now();
    const { orgId, story } = await seedStory("customer_updated");
    await createAssignment(orgId, story, planAt(now, 0.91, 1000));
    startRunner(orgId, 3);

    const result = await observeStory(orgId, now);

    expect(result?.stage).toBe("customer_updated");
    expect(runnerState(orgId).running).toBe(false);
    expect(await simMinutes(orgId)).toBe(0); // guarded, not stepped — stepping is the resolved stage's job
  });
});

describe("observeStory — resolved / delivering / delivered (the approach and the dock hold)", () => {
  it("approach: at 90% the runner stops and each poll moves the plan 5 minutes until 10 plan-minutes remain; then the truck is parked on the dock", async () => {
    const now = Date.now();
    const { orgId, story } = await seedStory("resolved");
    await createAssignment(orgId, story, planAt(now, 0.9, 1000)); // 100 plan-minutes left at 90%
    startRunner(orgId, 3);
    const spy = vi.spyOn(realtimeModule, "emitToDispatchers");

    const first = await observeStory(orgId, now);
    expect(first?.stage).toBe("resolved");
    expect(runnerState(orgId).running).toBe(false);
    expect(await simMinutes(orgId)).toBe(5);

    let polls = 1;
    let story2 = first;
    while (story2?.stage === "resolved" && polls < 40) {
      story2 = await observeStory(orgId, now);
      polls++;
    }

    expect(story2?.stage).toBe("delivering");
    expect(polls).toBe(19); // 18 steps of 5 minutes (100 left → 10 left), then the poll that parks the truck
    expect(await simMinutes(orgId)).toBe(90);
    const assignment = await prisma.assignment.findFirstOrThrow({ where: { loadId: story.loadId! } });
    expect(assignment.status).toBe("in_progress");
    expect((assignment.plannedEnd.getTime() - (now + 90 * MIN)) / MIN).toBe(10); // the dock budget: the 7-minute hold plus margin
    expect(story2?.holdStartedAt?.getTime()).toBe(now);
    const simState = await prisma.simDriverState.findUniqueOrThrow({ where: { driverId: story.driverId! } });
    expect(simState.mode).toBe("stopped");
    const last = await prisma.driverLocation.findFirstOrThrow({ where: { driverId: story.driverId! }, orderBy: { createdAt: "desc" } });
    expect(last).toMatchObject(DETROIT);
    const driver = await prisma.driver.findUniqueOrThrow({ where: { id: story.driverId! } });
    expect(driver.lastLat).toBe(DETROIT_DELIVERY.lat);
    expect(spy.mock.calls.filter((c) => c[1] === "driver_location")).toHaveLength(19); // 18 approach pings + the dock ping
  });

  it("below 90% the runner is left driving", async () => {
    const now = Date.now();
    const { orgId, story } = await seedStory("resolved");
    await createAssignment(orgId, story, planAt(now, 0.5, 1000));
    startRunner(orgId, 3);

    const result = await observeStory(orgId, now);
    expect(result?.stage).toBe("resolved");
    expect(runnerState(orgId).running).toBe(true);
    expect(await simMinutes(orgId)).toBe(0);
  });

  it("an assignment the engine completed on its own with no arrival on record is delivered with the skipped wording, and the agent is switched off", async () => {
    const { orgId, story } = await seedStory("resolved");
    await createAssignment(orgId, story, { status: "completed", plannedStart: new Date(Date.now() - 120 * MIN), plannedEnd: new Date(Date.now() - 5 * MIN) });
    await prisma.load.update({ where: { id: story.loadId! }, data: { agentEnabled: true, agentPill: "watching" } });

    const result = await observeStory(orgId);
    expect(result?.stage).toBe("delivered");
    expect(logTexts(result).at(-1)).toBe("Delivered (arrival wait skipped).");
    const load = await prisma.load.findUniqueOrThrow({ where: { id: story.loadId! } });
    expect(load).toMatchObject({ agentEnabled: false, agentPill: "off" });
    expect(await pendingStops(story.loadId!)).toBe(1);
  });

  it("an engine completion during the hold with an arrival on record is a clean delivery; the worker ends its own trip", async () => {
    const now = Date.now();
    const { orgId, story } = await seedStory("delivering", { holdStartedAt: new Date(now - 2 * MIN) });
    await createAssignment(orgId, story, { status: "completed", plannedStart: new Date(now - 120 * MIN), plannedEnd: new Date(now - MIN) });
    await prisma.load.update({ where: { id: story.loadId! }, data: { agentEnabled: true, agentPill: "delivered" } });
    const trip = await createTrip(story.loadId!);
    await addEvent(trip.id, "action", { kind: "arrived", arrivedAtMs: now - MIN, lateMin: 0 }, now - MIN);

    const result = await observeStory(orgId, now);
    expect(result?.stage).toBe("delivered");
    expect(logTexts(result).at(-1)).toBe("Delivered. Night Shift recorded the arrival.");
    const load = await prisma.load.findUniqueOrThrow({ where: { id: story.loadId! } });
    expect(load.agentEnabled).toBe(true);
    expect(await pendingStops(story.loadId!)).toBe(0);
  });

  it("delivering: every poll writes one dock ping itself — same coordinates, no stage change, no engine call", async () => {
    const now = Date.now();
    const { orgId, story } = await seedStory("delivering", { holdStartedAt: new Date(now) });
    await createAssignment(orgId, story, planAt(now, 0.98, 1000));
    await prisma.simDriverState.create({ data: { driverId: story.driverId!, mode: "stopped" } });
    const tickSpy = vi.spyOn(engineModule, "tick");

    const first = await observeStory(orgId, now);
    expect(first?.stage).toBe("delivering");
    const second = await observeStory(orgId, now);
    expect(second?.stage).toBe("delivering");

    const pings = await prisma.driverLocation.findMany({ where: { driverId: story.driverId! } });
    expect(pings).toHaveLength(2);
    for (const p of pings) expect(p).toMatchObject(DETROIT);
    const driver = await prisma.driver.findUniqueOrThrow({ where: { id: story.driverId! } });
    expect(driver).toMatchObject({ lastLat: DETROIT_DELIVERY.lat, lastLng: DETROIT_DELIVERY.lng });
    expect(tickSpy).not.toHaveBeenCalled();
    expect(await simMinutes(orgId)).toBe(0);
  });

  it("the hold survives seven minutes of wall time with the plan budget nearly spent: no engine completion, one dock ping per poll, and the arrival ends it", async () => {
    const t0 = Date.now();
    const { orgId, story } = await seedStory("delivering", { holdStartedAt: new Date(t0) });
    await createAssignment(orgId, story, { plannedStart: new Date(t0 - 96.4 * MIN), plannedEnd: new Date(t0 + 3.6 * MIN) });
    await prisma.simDriverState.create({ data: { driverId: story.driverId!, mode: "stopped" } });
    await prisma.driver.update({ where: { id: story.driverId! }, data: { lastLat: DETROIT_DELIVERY.lat, lastLng: DETROIT_DELIVERY.lng } });
    await prisma.load.update({ where: { id: story.loadId! }, data: { agentEnabled: true, agentPill: "watching" } });
    const tickSpy = vi.spyOn(engineModule, "tick");
    const emitSpy = vi.spyOn(realtimeModule, "emitToDispatchers");

    const stepMs = 20_000;
    for (let poll = 1; poll <= 20; poll++) {
      const result = await observeStory(orgId, t0 + poll * stepMs); // up to 6:40 into the hold
      expect(result?.stage).toBe("delivering");
    }

    expect(tickSpy).not.toHaveBeenCalled();
    const assignment = await prisma.assignment.findFirstOrThrow({ where: { loadId: story.loadId! } });
    expect(assignment.status).toBe("in_progress");
    const pings = await prisma.driverLocation.findMany({ where: { driverId: story.driverId! } });
    expect(pings).toHaveLength(20);
    for (const p of pings) expect(p).toMatchObject(DETROIT);
    expect(emitSpy.mock.calls.filter((c) => c[1] === "driver_location")).toHaveLength(20);
    expect(await simMinutes(orgId)).toBe(0);

    const trip = await createTrip(story.loadId!);
    const arrivedAtMs = t0 + 20 * stepMs + 10_000;
    await addEvent(trip.id, "action", { kind: "arrived", arrivedAtMs, lateMin: 0 }, arrivedAtMs);
    const done = await observeStory(orgId, t0 + 21 * stepMs); // 7:00 — the arrival, not the timeout, is what ends the hold
    expect(done?.stage).toBe("delivered");
    expect(logTexts(done).at(-1)).toBe("Delivered. Night Shift recorded the arrival.");
    expect(tickSpy).toHaveBeenCalledTimes(1);
    const load = await prisma.load.findUniqueOrThrow({ where: { id: story.loadId! } });
    expect(load).toMatchObject({ agentEnabled: true, status: "delivered" });
    expect(await pendingStops(story.loadId!)).toBe(0);
  });

  it("an arrived action event completes the delivery cleanly via tick", async () => {
    const now = Date.now();
    const { orgId, story } = await seedStory("delivering", { holdStartedAt: new Date(now) });
    await createAssignment(orgId, story, planAt(now, 0.99, 100));
    await prisma.load.update({ where: { id: story.loadId! }, data: { agentEnabled: true, agentPill: "watching" } });
    const trip = await createTrip(story.loadId!);
    await addEvent(trip.id, "action", { kind: "arrived", arrivedAtMs: now, lateMin: 0 }, now);

    const result = await observeStory(orgId, now);
    expect(result?.stage).toBe("delivered");
    expect(logTexts(result).at(-1)).toBe("Delivered. Night Shift recorded the arrival.");
    const assignment = await prisma.assignment.findFirstOrThrow({ where: { loadId: story.loadId! } });
    expect(assignment.status).toBe("completed");
    const load = await prisma.load.findUniqueOrThrow({ where: { id: story.loadId! } });
    expect(load.agentEnabled).toBe(true); // the worker ends its own trip on arrival — the story does not switch it off
    const simState = await prisma.simDriverState.findUniqueOrThrow({ where: { driverId: story.driverId! } });
    expect(simState.mode).toBe("auto");
  });

  it("7 minutes with no arrival switches the agent off BEFORE completing, logging the skipped wait", async () => {
    const now = Date.now();
    const { orgId, story } = await seedStory("delivering", { holdStartedAt: new Date(now - 7 * MIN) });
    await createAssignment(orgId, story, planAt(now, 0.99, 100));
    await prisma.load.update({ where: { id: story.loadId! }, data: { agentEnabled: true, agentPill: "watching" } });

    const result = await observeStory(orgId, now);
    expect(result?.stage).toBe("delivered");
    expect(logTexts(result).at(-1)).toBe("Delivered (arrival wait skipped).");
    const load = await prisma.load.findUniqueOrThrow({ where: { id: story.loadId! } });
    expect(load).toMatchObject({ agentEnabled: false, agentPill: "off", status: "delivered" });
    expect(await pendingStops(story.loadId!)).toBe(1);
  });

  it("a tick the engine had to skip leaves the story on delivering, tells the presenter once, and completes on a later poll", async () => {
    const now = Date.now();
    const { orgId, story } = await seedStory("delivering", { holdStartedAt: new Date(now) });
    await createAssignment(orgId, story, planAt(now, 0.99, 100));
    const trip = await createTrip(story.loadId!);
    await addEvent(trip.id, "action", { kind: "arrived", arrivedAtMs: now, lateMin: 0 }, now);
    const skipped = { simNowMs: now, pings: 0, started: 0, completed: 0, skipped: 1 };
    const tickSpy = vi.spyOn(engineModule, "tick").mockResolvedValueOnce(skipped).mockResolvedValueOnce(skipped);

    const first = await observeStory(orgId, now);
    expect(first?.stage).toBe("delivering");
    expect(logTexts(first).at(-1)).toMatch(/taking a moment longer/);

    const second = await observeStory(orgId, now);
    expect(second?.stage).toBe("delivering");
    expect(logTexts(second)).toEqual(logTexts(first)); // told once

    tickSpy.mockRestore();
    const third = await observeStory(orgId, now);
    expect(third?.stage).toBe("delivered");
    expect(logTexts(third).at(-1)).toBe("Delivered. Night Shift recorded the arrival.");
  });
});
