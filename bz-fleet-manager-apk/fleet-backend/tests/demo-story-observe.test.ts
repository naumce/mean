import { prisma } from "../src/db.js";
import { resetDb } from "./helpers.js";
import { observeStory, waitingOnFor } from "../src/lib/demoStory/index.js";
import { applyPatch } from "../src/lib/demoStory/patch.js";
import { DEMO_CUSTOMER_EMAIL } from "../src/lib/demoStory/fixtures.js";
import { runnerState, startRunner } from "../src/lib/simulation/runner.js";
import * as engineModule from "../src/lib/simulation/engine.js";
import * as realtimeModule from "../src/realtime.js";
import { MIN, addEvent, createAssignment, createTrip, logTexts, planAt, seedStory, simMinutes, stopSeededRunners } from "./demoStoryTestHelpers.js";

// Demo Mode — observeStory from "ai_recommendation" to "awaiting_customer_update":
// every automatic transition, driven by inserting the exact rows/events
// Night Shift itself would have written (evidence shapes verified against
// the worker's own agent.ts/detect.ts), plus the clock freeze at the
// scripted breakdown, the write guards and the error capture. The runner is
// the REAL one (started per test where the clock rule is under test, always
// stopped again in afterEach); every call passes an explicit `nowMs` so the
// plan fraction the story sees is exact. The stages from "customer_updated"
// on are demo-story-observe-delivery.test.ts's job.

// harnessEnabled() (aiHarness/config.ts) reads OLLAMA_URL at call time — most
// tests below don't care (a terminal run's own status decides the outcome
// before that check even runs), but "still queued, under the timeout" needs
// it set so the harness reads as configured; "harness disabled" overrides it
// back off for that one test. Saved/restored the same way
// ai-harness-runner.test.ts does, since OLLAMA_URL is process-global and this
// suite runs in the same worker as that one.
const ORIGINAL_OLLAMA_URL = process.env.OLLAMA_URL;
beforeEach(() => {
  process.env.OLLAMA_URL = "http://127.0.0.1:11434";
});
afterAll(() => {
  if (ORIGINAL_OLLAMA_URL === undefined) delete process.env.OLLAMA_URL;
  else process.env.OLLAMA_URL = ORIGINAL_OLLAMA_URL;
});

beforeEach(resetDb);
afterEach(() => {
  stopSeededRunners();
  vi.restoreAllMocks();
});

describe("observeStory — ai_recommendation", () => {
  it("a proposed run with a driverId moves to awaiting_approval, source ai, and logs the confidence", async () => {
    const { orgId, story } = await seedStory("ai_recommendation");
    const run = await prisma.aiDecisionRecord.create({
      data: {
        experimentId: story.experimentId!, orgId, loadId: story.loadId, driverId: story.driverId,
        kind: "dispatch_candidate", status: "proposed", context: {}, toolCalls: [], toolResults: [],
        confidence: 0.85,
      },
    });
    await prisma.demoStory.update({ where: { orgId }, data: { runId: run.id } });

    const result = await observeStory(orgId);

    expect(result?.stage).toBe("awaiting_approval");
    expect(result?.recommendedDriverId).toBe(story.driverId);
    expect(result?.recommendationSource).toBe("ai");
    expect(logTexts(result).at(-1)).toBe("AI recommends John Carter (confidence 0.85).");
  });

  it("harness disabled (no run at all) falls back to the deterministic recommendation, source engine", async () => {
    delete process.env.OLLAMA_URL;
    const { orgId, story } = await seedStory("ai_recommendation");

    const result = await observeStory(orgId);

    expect(result?.stage).toBe("awaiting_approval");
    expect(result?.recommendationSource).toBe("engine");
    expect(result?.recommendedDriverId).toBe(story.driverId); // John is the only driver in this org
    expect(logTexts(result).at(-1)).toMatch(/^AI unavailable — using the deterministic recommendation: John Carter\.$/);
  });

  it("a failed run also falls back to the deterministic recommendation", async () => {
    const { orgId, story } = await seedStory("ai_recommendation");
    const run = await prisma.aiDecisionRecord.create({
      data: { experimentId: story.experimentId!, orgId, loadId: story.loadId, kind: "dispatch_candidate", status: "failed", context: {}, toolCalls: [], toolResults: [] },
    });
    await prisma.demoStory.update({ where: { orgId }, data: { runId: run.id } });

    const result = await observeStory(orgId);
    expect(result?.stage).toBe("awaiting_approval");
    expect(result?.recommendationSource).toBe("engine");
  });

  it("a queued run under 3 minutes old is left alone — the story stays put", async () => {
    const { orgId, story } = await seedStory("ai_recommendation");
    const run = await prisma.aiDecisionRecord.create({
      data: { experimentId: story.experimentId!, orgId, loadId: story.loadId, kind: "dispatch_candidate", status: "queued", context: {}, toolCalls: [], toolResults: [] },
    });
    await prisma.demoStory.update({ where: { orgId }, data: { runId: run.id } });

    const result = await observeStory(orgId);
    expect(result?.stage).toBe("ai_recommendation");
    expect(result?.recommendationSource).toBeNull();
  });

  it("a queued run past 3 minutes falls back to the deterministic recommendation", async () => {
    const { orgId, story } = await seedStory("ai_recommendation");
    const run = await prisma.aiDecisionRecord.create({
      data: {
        experimentId: story.experimentId!, orgId, loadId: story.loadId, kind: "dispatch_candidate", status: "queued",
        context: {}, toolCalls: [], toolResults: [], proposedAt: new Date(Date.now() - 4 * MIN),
      },
    });
    await prisma.demoStory.update({ where: { orgId }, data: { runId: run.id } });

    const result = await observeStory(orgId);
    expect(result?.stage).toBe("awaiting_approval");
    expect(result?.recommendationSource).toBe("engine");
  });
});

describe("observeStory — in_transit: the scripted breakdown freezes the clock", () => {
  it("forces a tick once when the assignment is still 'assigned' past its plannedStart", async () => {
    const { orgId, story } = await seedStory("in_transit");
    const assignment = await createAssignment(orgId, story, { status: "assigned", plannedStart: new Date(Date.now() - 5 * MIN), plannedEnd: new Date(Date.now() + 55 * MIN), startedAt: null });

    const result = await observeStory(orgId);

    const reread = await prisma.assignment.findUniqueOrThrow({ where: { id: assignment.id } });
    expect(reread.status).toBe("in_progress");
    expect(result?.breakdownTriggeredAt).toBeNull(); // the started plan is judged on the next poll, not this one
  });

  it("crossing breakdownAtFraction stops the runner, parks the driver, stamps breakdownTriggeredAt, and narrates once", async () => {
    const now = Date.now();
    const { orgId, story } = await seedStory("in_transit", { breakdownAtFraction: 0.4 });
    await createAssignment(orgId, story, planAt(now, 0.45, 60));
    startRunner(orgId, 3);
    expect(runnerState(orgId).running).toBe(true);

    const first = await observeStory(orgId, now);

    expect(first?.stage).toBe("in_transit"); // stays put — only Night Shift's own detection advances it
    expect(first?.breakdownTriggeredAt?.getTime()).toBe(now);
    expect(runnerState(orgId).running).toBe(false);
    expect((await prisma.simulationState.findUniqueOrThrow({ where: { orgId } })).running).toBe(false);
    const simState = await prisma.simDriverState.findUniqueOrThrow({ where: { driverId: story.driverId! } });
    expect(simState.mode).toBe("stopped");
    expect(logTexts(first).at(-1)).toMatch(/^Truck stopped unexpectedly near .+\.$/);

    const second = await observeStory(orgId, now);
    expect(logTexts(second)).toEqual(logTexts(first)); // guarded — no re-fire
    expect(second?.breakdownTriggeredAt?.getTime()).toBe(now);
  });

  it("below breakdownAtFraction nothing happens and the runner keeps its clock", async () => {
    const now = Date.now();
    const { orgId, story } = await seedStory("in_transit"); // 0.05 default
    await createAssignment(orgId, story, planAt(now, 0.02, 600));
    startRunner(orgId, 3);

    const result = await observeStory(orgId, now);

    expect(result?.breakdownTriggeredAt).toBeNull();
    expect(runnerState(orgId).running).toBe(true);
    expect(await prisma.driverLocation.count({ where: { driverId: story.driverId! } })).toBe(0);
  });

  it("every poll after the breakdown writes one stopped ping through tick(orgId, 0) — same point, sim clock untouched", async () => {
    const now = Date.now();
    const { orgId, story } = await seedStory("in_transit", { breakdownTriggeredAt: new Date(now - MIN) });
    await createAssignment(orgId, story, planAt(now, 0.1, 600));
    await prisma.simDriverState.create({ data: { driverId: story.driverId!, mode: "stopped" } });
    await prisma.driver.update({ where: { id: story.driverId! }, data: { lastLat: 41.6, lastLng: -87.3 } });
    await prisma.simulationState.update({ where: { orgId }, data: { simMinutesAdvanced: 7 } });
    const spy = vi.spyOn(realtimeModule, "emitToDispatchers");

    await observeStory(orgId, now);
    await observeStory(orgId, now);

    const pings = await prisma.driverLocation.findMany({ where: { driverId: story.driverId! } });
    expect(pings).toHaveLength(2);
    for (const p of pings) expect(p).toMatchObject({ latitude: 41.6, longitude: -87.3 });
    expect(await simMinutes(orgId)).toBe(7);
    expect(spy.mock.calls.filter((c) => c[1] === "driver_location")).toHaveLength(2);
    const assignment = await prisma.assignment.findFirstOrThrow({ where: { loadId: story.loadId! } });
    expect(assignment.status).toBe("in_progress");
  });

  it("an unresolved unplanned_stop anomaly event moves the story to breakdown_detected", async () => {
    const now = Date.now();
    const { orgId, story } = await seedStory("in_transit", { breakdownTriggeredAt: new Date(now - MIN) });
    await createAssignment(orgId, story, planAt(now, 0.1, 600));
    const trip = await createTrip(story.loadId!);
    await addEvent(trip.id, "anomaly", { kind: "unplanned_stop", key: `unplanned_stop@${now - 30_000}`, firstSeenMs: now - 60_000, lastSeenMs: now, observedMin: 2 });

    const result = await observeStory(orgId, now);
    expect(result?.stage).toBe("breakdown_detected");
    expect(logTexts(result).at(-1)).toBe("Night Shift flagged the stop.");
  });

  it("a RESOLVED unplanned_stop does not re-trigger breakdown_detected", async () => {
    const now = Date.now();
    const { orgId, story } = await seedStory("in_transit", { breakdownTriggeredAt: new Date(now - MIN) });
    await createAssignment(orgId, story, planAt(now, 0.1, 600));
    const trip = await createTrip(story.loadId!);
    await addEvent(trip.id, "anomaly", { kind: "unplanned_stop", key: "unplanned_stop@x" }, now - 5000);
    await addEvent(trip.id, "anomaly", { key: "unplanned_stop@x", resolved: true }, now);

    const result = await observeStory(orgId, now);
    expect(result?.stage).toBe("in_transit");
  });

  it("an assignment that completed before the breakdown could fire lands on error instead of waiting forever", async () => {
    const { orgId, story } = await seedStory("in_transit");
    await createAssignment(orgId, story, { status: "completed", plannedStart: new Date(Date.now() - 120 * MIN), plannedEnd: new Date(Date.now() - 5 * MIN) });

    const result = await observeStory(orgId);
    expect(result?.stage).toBe("error");
    expect(result?.error).toMatch(/delivered before the scripted breakdown/);
  });
});

describe("observeStory — breakdown_detected (driver contacted)", () => {
  it("a message action event after the breakdown moves the story to awaiting_driver_reply", async () => {
    const now = Date.now();
    const { orgId, story } = await seedStory("breakdown_detected", { breakdownTriggeredAt: new Date(now - 2 * MIN) });
    await createAssignment(orgId, story, planAt(now, 0.1, 600));
    const trip = await createTrip(story.loadId!, { createdAt: new Date(now - 10 * MIN) });
    await addEvent(trip.id, "action", { anomalyKey: "unplanned_stop@x", rung: 1, kind: "message", channel: "chat", text: "Everything okay?" }, now);

    const result = await observeStory(orgId, now);
    expect(result?.stage).toBe("awaiting_driver_reply");
    expect(await prisma.driverLocation.count({ where: { driverId: story.driverId! } })).toBe(1); // the hold ping
    expect(logTexts(result).at(-1)).toBe("Night Shift messaged the driver and is waiting to hear back.");
  });

  // contact-fix-brief.md, finding (dry run 5, live): Night Shift keeps one
  // open question at a time, so on a hot load its rung-1 `message` can fire
  // at the very first ping — before the scripted breakdown itself trips.
  // The old `afterBreakdown` fence missed this and waited the full
  // RUNG1_COOLDOWN_MIN for rung 2 while the real contact sat unread.
  it("a message action stamped after the trip start but BEFORE the breakdown still counts, with the 'had already asked' narration", async () => {
    const now = Date.now();
    const { orgId, story } = await seedStory("breakdown_detected", { breakdownTriggeredAt: new Date(now) });
    await createAssignment(orgId, story, planAt(now, 0.1, 600));
    const trip = await createTrip(story.loadId!, { createdAt: new Date(now - 10 * MIN) });
    await addEvent(trip.id, "action", { anomalyKey: "unplanned_stop@x", rung: 1, kind: "message", channel: "chat", text: "Everything okay?" }, now - 6_000);

    const result = await observeStory(orgId, now);
    expect(result?.stage).toBe("awaiting_driver_reply");
    expect(logTexts(result).at(-1)).toBe(
      "Night Shift had already asked the driver if everything was OK before the stop was flagged, and is waiting to hear back.",
    );
  });

  // Guards the fence's floor, not just its removal: a purge miss could leave
  // a stale trip (and its events) from a previous run sitting on the same
  // load. That trip's own message must not count for THIS run just because
  // it predates the current trip's start.
  it("a message action stamped BEFORE the trip start (a leftover trip from a previous run) is not counted", async () => {
    const now = Date.now();
    const { orgId, story } = await seedStory("breakdown_detected", { breakdownTriggeredAt: new Date(now - 2 * MIN) });
    await createAssignment(orgId, story, planAt(now, 0.1, 600));
    const staleTrip = await createTrip(story.loadId!, { createdAt: new Date(now - 30 * MIN) });
    await addEvent(staleTrip.id, "action", { anomalyKey: "unplanned_stop@x", rung: 1, kind: "message", channel: "chat", text: "Everything okay?" }, now - 25 * MIN);
    await createTrip(story.loadId!, { createdAt: new Date(now - 5 * MIN) }); // this run's own trip

    const result = await observeStory(orgId, now);
    expect(result?.stage).toBe("breakdown_detected");
  });

  it("a shadow would_say on a driver channel after the breakdown also counts", async () => {
    const now = Date.now();
    const { orgId, story } = await seedStory("breakdown_detected", { breakdownTriggeredAt: new Date(now - 2 * MIN) });
    await createAssignment(orgId, story, planAt(now, 0.1, 600));
    const trip = await createTrip(story.loadId!);
    await addEvent(trip.id, "would_say", { channel: "chat", to: "+15550100001", text: "Everything okay?" }, now);

    const result = await observeStory(orgId, now);
    expect(result?.stage).toBe("awaiting_driver_reply");
  });

  it("ignores the trip-start invite (a would_say from before the breakdown) and shadow emails/calls", async () => {
    const now = Date.now();
    const { orgId, story } = await seedStory("breakdown_detected", { breakdownTriggeredAt: new Date(now - 2 * MIN) });
    await createAssignment(orgId, story, planAt(now, 0.1, 600));
    const trip = await createTrip(story.loadId!);
    await addEvent(trip.id, "would_say", { channel: "sms", to: "+15550100001", text: "Hi John, tap the link to accept…" }, now - 5 * MIN);
    await addEvent(trip.id, "action", { kind: "invite", channel: "sms", text: "…" }, now - 5 * MIN);
    await addEvent(trip.id, "would_say", { channel: "email", to: "dispatcher@example.invalid", text: "escalation" }, now);
    await addEvent(trip.id, "would_say", { channel: "call", to: "+15550100001", text: "script" }, now);

    const result = await observeStory(orgId, now);
    expect(result?.stage).toBe("breakdown_detected");
  });
});

describe("observeStory — awaiting_driver_reply", () => {
  it("an escalation with a draft attached proposes a customer update", async () => {
    const now = Date.now();
    const { orgId, story } = await seedStory("awaiting_driver_reply", { breakdownTriggeredAt: new Date(now - 2 * MIN) });
    await createAssignment(orgId, story, planAt(now, 0.1, 600));
    const trip = await createTrip(story.loadId!);
    await addEvent(trip.id, "escalation", { reason: "driver reports a breakdown", deadlineAtRisk: true, draftAttached: true, anomalyKey: "unplanned_stop@x", messageId: "m1" }, now);

    const result = await observeStory(orgId, now);
    expect(result?.stage).toBe("awaiting_customer_update");
    expect(logTexts(result).at(-1)).toBe("Night Shift escalated: driver reports a breakdown; a customer update is proposed.");
  });

  it("an escalation with no draft says so instead", async () => {
    const now = Date.now();
    const { orgId, story } = await seedStory("awaiting_driver_reply", { breakdownTriggeredAt: new Date(now - 2 * MIN) });
    await createAssignment(orgId, story, planAt(now, 0.1, 600));
    const trip = await createTrip(story.loadId!);
    await addEvent(trip.id, "escalation", { reason: "driver reports a breakdown", deadlineAtRisk: false, draftAttached: false, anomalyKey: "unplanned_stop@x", messageId: null }, now);

    const result = await observeStory(orgId, now);
    expect(result?.stage).toBe("awaiting_customer_update");
    expect(logTexts(result).at(-1)).toBe("Night Shift escalated: driver reports a breakdown; no customer update was proposed (deadline not at risk).");
  });

  it("a trip-start escalation from before the breakdown is not the one the story waits for", async () => {
    const now = Date.now();
    const { orgId, story } = await seedStory("awaiting_driver_reply", { breakdownTriggeredAt: new Date(now - 2 * MIN) });
    await createAssignment(orgId, story, planAt(now, 0.1, 600));
    const trip = await createTrip(story.loadId!);
    await addEvent(trip.id, "escalation", { reason: "hours cannot carry this run", deadlineAtRisk: false, draftAttached: false, anomalyKey: null, messageId: null }, now - 10 * MIN);

    const result = await observeStory(orgId, now);
    expect(result?.stage).toBe("awaiting_driver_reply");
  });
});

describe("observeStory — awaiting_customer_update (the thaw)", () => {
  it("the shadow would_say to the sink moves the story to customer_updated, sets the driver to auto and restarts the runner at speed 3", async () => {
    const now = Date.now();
    const { orgId, story } = await seedStory("awaiting_customer_update", { breakdownTriggeredAt: new Date(now - 2 * MIN) });
    await createAssignment(orgId, story, planAt(now, 0.1, 600));
    await prisma.simDriverState.create({ data: { driverId: story.driverId!, mode: "stopped" } });
    const trip = await createTrip(story.loadId!);
    await addEvent(trip.id, "would_say", { channel: "email", to: DEMO_CUSTOMER_EMAIL, text: "We're delayed" }, now);

    const result = await observeStory(orgId, now);

    expect(result?.stage).toBe("customer_updated");
    const simState = await prisma.simDriverState.findUniqueOrThrow({ where: { driverId: story.driverId! } });
    expect(simState.mode).toBe("auto");
    expect(runnerState(orgId)).toEqual({ running: true, speed: 3 });
    expect((await prisma.simulationState.findUniqueOrThrow({ where: { orgId } })).running).toBe(true);
    expect(logTexts(result).slice(-2)).toEqual([
      "Customer update sent to the demo sink (shadow mode — no email left the system).",
      "Truck moving again.",
    ]);
  });

  it("a would_say email to the DISPATCHER (the escalation's own email) does not count as the customer update", async () => {
    const { orgId, story } = await seedStory("awaiting_customer_update");
    const trip = await createTrip(story.loadId!);
    await addEvent(trip.id, "would_say", { channel: "email", to: "dispatcher@example.invalid", text: "escalation email" });

    const result = await observeStory(orgId);
    expect(result?.stage).toBe("awaiting_customer_update");
    expect(runnerState(orgId).running).toBe(false);
  });

  it("a live (non-shadow) customer_delay email also counts", async () => {
    const { orgId, story } = await seedStory("awaiting_customer_update");
    const trip = await createTrip(story.loadId!);
    await addEvent(trip.id, "email", { to: DEMO_CUSTOMER_EMAIL, kind: "customer_delay", subject: "Delay", messageId: "m2" });

    const result = await observeStory(orgId);
    expect(result?.stage).toBe("customer_updated");
  });
});

describe("waitingOnFor — awaiting_customer_update picks the same escalation the narration used (finding F1a/M1)", () => {
  it("an escalation dated BEFORE the breakdown must not decide customer_update_sent vs resolve", async () => {
    const now = Date.now();
    const { story } = await seedStory("awaiting_customer_update", { breakdownTriggeredAt: new Date(now) });
    const trip = await createTrip(story.loadId!);
    // Stale: an escalation from before THIS run's breakdown (a previous
    // run's leftover, or a trip-start escalation) that happens to carry a
    // draft. Without the `afterBreakdown` fence this is the "latest
    // escalation of any age" and wrongly flips the button to "send".
    await addEvent(trip.id, "escalation", { reason: "old", draftAttached: true }, now - 10 * MIN);

    const result = await waitingOnFor(story, now);
    expect(result).toBe("resolve"); // no escalation AFTER the breakdown exists yet
  });

  it("an escalation dated AFTER the breakdown correctly offers the send button", async () => {
    const now = Date.now();
    const { story } = await seedStory("awaiting_customer_update", { breakdownTriggeredAt: new Date(now - 5 * MIN) });
    const trip = await createTrip(story.loadId!);
    await addEvent(trip.id, "escalation", { reason: "current", draftAttached: true }, now - 1 * MIN);

    const result = await waitingOnFor(story, now);
    expect(result).toBe("customer_update_sent");
  });
});

describe("observeStory — concurrency", () => {
  it("two concurrent polls across the breakdown produce one stopped write and one narration line", async () => {
    const now = Date.now();
    const { orgId, story } = await seedStory("in_transit", { breakdownAtFraction: 0.4 });
    await createAssignment(orgId, story, planAt(now, 0.45, 600));
    startRunner(orgId, 3);

    const [a, b] = await Promise.all([observeStory(orgId, now), observeStory(orgId, now)]);

    const stopped = logTexts(await prisma.demoStory.findUniqueOrThrow({ where: { orgId } })).filter((t) => t.startsWith("Truck stopped"));
    expect(stopped).toHaveLength(1);
    expect(a?.breakdownTriggeredAt?.getTime()).toBe(now);
    expect(b?.breakdownTriggeredAt?.getTime()).toBe(now);
    expect(runnerState(orgId).running).toBe(false);
    // The second poll ran after the first and saw the breakdown already
    // fired: its job was one hold ping, not a second trigger.
    expect(await prisma.driverLocation.count({ where: { driverId: story.driverId! } })).toBe(1);
  });

  it("applyPatch: a stale copy never overwrites a newer write — re-read on conflict, applied once", async () => {
    const { orgId, story: stale } = await seedStory("in_transit");
    const newer = await prisma.demoStory.update({
      where: { orgId },
      data: { log: [...(stale.log as object[]), { atMs: Date.now(), stage: "in_transit", text: "A" }], updatedAt: new Date(stale.updatedAt.getTime() + 1000) },
    });
    expect(newer.updatedAt.getTime()).not.toBe(stale.updatedAt.getTime());

    const result = await applyPatch(orgId, stale, { logTexts: ["B"] });
    expect(logTexts(result).slice(-2)).toEqual(["A", "B"]);
  });

  it("applyPatch: every write moves updatedAt, so a second write from the same copy conflicts instead of clobbering", async () => {
    const { orgId, story } = await seedStory("in_transit");

    const first = await applyPatch(orgId, story, { logTexts: ["A"] });
    expect(first.updatedAt.getTime()).toBeGreaterThan(story.updatedAt.getTime());

    const second = await applyPatch(orgId, story, { logTexts: ["B"] }); // the same stale copy again
    expect(logTexts(second).slice(-2)).toEqual(["A", "B"]);
  });

  it("applyPatch: a stage transition another writer already made is dropped, not made twice", async () => {
    const { orgId, story: stale } = await seedStory("breakdown_detected");
    await prisma.demoStory.update({ where: { orgId }, data: { stage: "awaiting_driver_reply", updatedAt: new Date(stale.updatedAt.getTime() + 1000) } });

    const result = await applyPatch(orgId, stale, { stage: "awaiting_driver_reply", logTexts: ["dup"] });
    expect(result.stage).toBe("awaiting_driver_reply");
    expect(logTexts(result)).not.toContain("dup");
  });
});

describe("observeStory — error capture (never throws)", () => {
  it("a thrown error inside a transition lands the story on stage error, with the message recorded, instead of throwing", async () => {
    const { orgId, story } = await seedStory("in_transit");
    await createAssignment(orgId, story, { status: "assigned", plannedStart: new Date(Date.now() - 5 * MIN) });
    vi.spyOn(engineModule, "tick").mockRejectedValueOnce(new Error("boom: simulated engine failure"));

    const result = await observeStory(orgId);

    expect(result?.stage).toBe("error");
    expect(result?.error).toContain("boom: simulated engine failure");
  });
});

describe("observeStory — no story yet", () => {
  it("returns null rather than throwing when the org has never been reset", async () => {
    const org = await prisma.org.create({ data: { name: "Never Reset Org" } });
    await expect(observeStory(org.id)).resolves.toBeNull();
  });
});
