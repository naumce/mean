import { describe, expect, it } from "vitest";
import { Agent } from "../src/core/agent.js";
import { pointAlongRoute } from "../src/core/geo.js";
import { STANDARD } from "../src/core/policy.js";
import { FakeClock, KeywordClassifier, MemoryEvents, MemoryMailer, MemoryMessenger, MemoryPhone, MemorySheet, StraightRouter } from "../src/fakes/index.js";
import type { Brief, LngLat } from "../src/core/types.js";

// Pre-policy test: exercises live sends, so shadow is forced off.
const POLICY = { ...STANDARD, shadow: false };

const KC = { lat: 39.1, lng: -94.58 }, DSM = { lat: 41.59, lng: -93.62 };
const T0 = Date.UTC(2026, 8, 6, 11, 10), MIN = 60_000, t = (m: number) => T0 + m * MIN;
const BOSS = "+38978000000";
const brief: Brief = {
  loadRef: "W-19", origin: { name: "Kansas City, MO", ...KC }, destination: { name: "Des Moines, IA", ...DSM }, equipment: "DryVan",
  departAtMs: T0, deadlineAtMs: t(245), driverName: "Jake", driverPhone: "+15550001", customerEmail: null, minutesSinceBreakAtDepart: 0,
};

// Parked at mile 62 and silent: chat 77, chat 87, call 102, retry 107,
// escalation 112. The dispatcher's phone rings once, after the email.
async function run(dispatcherPhone: string | null) {
  const clock = new FakeClock(T0), phone = new MemoryPhone(), mailer = new MemoryMailer(), events = new MemoryEvents(), router = new StraightRouter(60);
  const geometry: LngLat[] = (await router.route(KC, DSM, { equipment: "DryVan", departAtMs: T0 })).geometry;
  const agent = new Agent({ clock, router, sheet: new MemorySheet(), messenger: new MemoryMessenger(), phone, mailer, classifier: new KeywordClassifier(), events, restStops: [], landmarks: [], dispatcherEmail: "boss@x", tz: "America/Chicago", dispatcherPhone, policy: POLICY }, brief);
  await agent.start(); clock.set(T0); await agent.onAccept();
  const at = (mi: number) => pointAlongRoute(geometry, mi / 179.5);
  for (let m = 0; m <= 61; m++) { clock.set(t(m)); await agent.onPing({ atMs: t(m), ...at(m) }); }
  for (let m = 62; m <= 120; m++) { clock.set(t(m)); await agent.onPing({ atMs: t(m), ...at(62) }); }
  return { agent, phone, mailer, events };
}

describe("the dispatcher's phone at escalation", () => {
  it("rings once with a spoken briefing after the escalation email, and never feeds the boss's words back as a driver reply", async () => {
    const { phone, mailer, events } = await run(BOSS);
    expect(mailer.sent).toHaveLength(1);
    const bossCalls = phone.calls.filter((c) => c.phone === BOSS);
    expect(bossCalls).toHaveLength(1);
    expect(bossCalls[0].script).toContain("W-19");
    expect(bossCalls[0].script).toContain("Jake");
    expect(bossCalls[0].script).toMatch(/unplanned stop unresolved after 2 calls/i);
    expect(bossCalls[0].script).toMatch(/emailed you/i);
    expect(bossCalls[0].script).toMatch(/Last position/);
    expect(phone.calls.filter((c) => c.phone === "+15550001")).toHaveLength(2);
    const record = events.events.filter((e) => e.kind === "dispatcher_call");
    expect(record).toHaveLength(1);
    expect(record[0].evidence.answered).toBe(false);
    expect(events.events.filter((e) => e.kind === "reply")).toHaveLength(0);
    // The briefing came after the email, not before it.
    const emailIdx = events.events.findIndex((e) => e.kind === "escalation");
    const callIdx = events.events.findIndex((e) => e.kind === "dispatcher_call");
    expect(callIdx).toBeGreaterThan(emailIdx);
  });

  it("with no dispatcher phone configured, nobody but the driver is called", async () => {
    const { phone, mailer } = await run(null);
    expect(mailer.sent).toHaveLength(1);
    expect(phone.calls.every((c) => c.phone === "+15550001")).toBe(true);
    expect(phone.calls).toHaveLength(2);
  });
});
