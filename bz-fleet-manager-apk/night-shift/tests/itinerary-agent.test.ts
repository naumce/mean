// Slice 2 (2026-09-19): the agent records the itinerary with its plan,
// escalates before the first mile when the driver's clock cannot carry the
// run, and writes the re-timed remainder with every cadence write.
import { describe, expect, it } from "vitest";
import { Agent } from "../src/core/agent.js";
import { pointAlongRoute } from "../src/core/geo.js";
import { STANDARD } from "../src/core/policy.js";
import { FakeClock, KeywordClassifier, MemoryEvents, MemoryMailer, MemoryMessenger, MemoryPhone, MemorySheet, StraightRouter } from "../src/fakes/index.js";
import type { Brief, BriefContext, LngLat } from "../src/core/types.js";

const POLICY = { ...STANDARD, shadow: false };
const KC = { lat: 39.1, lng: -94.58 }, DSM = { lat: 41.59, lng: -93.62 };
const T0 = Date.UTC(2026, 8, 6, 11, 10), MIN = 60_000, t = (m: number) => T0 + m * MIN;

const context = (hos: BriefContext["hos"]): BriefContext => ({
  driverId: "d1", hazmatClass: null, commodity: null, customerName: null, brokerName: null, notes: null, apptText: null, updateText: null, hos,
  stops: [
    { type: "pickup", name: "Kansas City, MO", ...KC, windowStartMs: null, windowEndMs: T0, dwellMin: 30 },
    { type: "delivery", name: "Des Moines, IA", ...DSM, windowStartMs: null, windowEndMs: t(400), dwellMin: 30 },
  ],
});
const briefWith = (hos: BriefContext["hos"]): Brief => ({
  loadRef: "W-19", origin: { name: "Kansas City, MO", ...KC }, destination: { name: "Des Moines, IA", ...DSM }, equipment: "DryVan",
  departAtMs: T0, deadlineAtMs: t(400), driverName: "Jake", driverPhone: "+15550001", customerEmail: null, minutesSinceBreakAtDepart: 0,
  context: context(hos),
});

async function start(brief: Brief) {
  const clock = new FakeClock(T0), mailer = new MemoryMailer(), events = new MemoryEvents(), router = new StraightRouter(60);
  const geometry: LngLat[] = (await router.route(KC, DSM, { equipment: "DryVan", departAtMs: T0 })).geometry;
  const agent = new Agent({ clock, router, sheet: new MemorySheet(), messenger: new MemoryMessenger(), phone: new MemoryPhone(), mailer, classifier: new KeywordClassifier(), events, restStops: [], landmarks: [], dispatcherEmail: "boss@x", tz: "America/Chicago", dispatcherPhone: null, policy: POLICY }, brief);
  await agent.start();
  return { agent, clock, mailer, events, geometry };
}

describe("itinerary on the agent", () => {
  it("the plan event carries the itinerary: stops, planned arrival, slack", async () => {
    const { events } = await start(briefWith({ driveRemainingMin: 600, windowRemainingMin: 800, cycleRemainingMin: 3000, minutesSinceBreak: 0 }));
    const plan = events.events.find((e) => e.kind === "plan")!;
    const itin = plan.evidence.itinerary as { legs: Array<{ kind: string }>; slackMin: number; hos: { feasible: boolean } };
    expect(itin.legs.map((l) => l.kind)).toEqual(["stop", "drive", "stop"]);
    expect(itin.hos.feasible).toBe(true);
    expect(itin.slackMin).toBeGreaterThan(0);
    expect(events.events.some((e) => e.kind === "escalation")).toBe(false);
  });

  it("a run the driver's hours cannot carry is escalated at planning time, before any ping", async () => {
    const { events, mailer } = await start(briefWith({ driveRemainingMin: 60, windowRemainingMin: 800, cycleRemainingMin: 3000, minutesSinceBreak: 0 }));
    const infeasible = events.events.find((e) => e.kind === "action" && e.evidence.kind === "hos_infeasible");
    expect(infeasible?.actionTaken).toMatch(/hours cannot carry this run/);
    expect(events.events.some((e) => e.kind === "escalation")).toBe(true);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].body).toMatch(/10-hour rest/);
  });

  it("every cadence write carries the itinerary re-timed from the last fix", async () => {
    const { agent, clock, events, geometry } = await start(briefWith(null));
    await agent.onAccept();
    const at = (mi: number) => pointAlongRoute(geometry, mi / 179.5);
    clock.set(t(1));
    await agent.onPing({ atMs: t(1), ...at(0) });
    const write = [...events.events].reverse().find((e) => e.kind === "sheet_write")!;
    const remaining = write.evidence.remaining as { legs: Array<{ kind: string }>; etaAtMs: number; slackMin: number };
    expect(remaining.legs.map((l) => l.kind)).toEqual(["drive", "stop"]);
    expect(remaining.etaAtMs).toBeGreaterThan(t(1));
    expect(typeof remaining.slackMin).toBe("number");
  });
});
