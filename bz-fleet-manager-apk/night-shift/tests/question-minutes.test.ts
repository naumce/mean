import { describe, expect, it } from "vitest";
import { Agent } from "../src/core/agent.js";
import { pointAlongRoute } from "../src/core/geo.js";
import { STANDARD } from "../src/core/policy.js";
import { FakeClock, KeywordClassifier, MemoryEvents, MemoryMailer, MemoryMessenger, MemoryPhone, MemorySheet, StraightRouter } from "../src/fakes/index.js";
import type { Brief } from "../src/core/types.js";

// Pre-policy test: exercises live sends, so shadow is forced off.
const POLICY = { ...STANDARD, shadow: false };

const KC = { lat: 39.1, lng: -94.58 }, DSM = { lat: 41.59, lng: -93.62 };
const T0 = Date.UTC(2026, 8, 6, 11, 10);
const brief: Brief = {
  loadRef: "W-19", origin: { name: "Kansas City, MO", ...KC }, destination: { name: "Des Moines, IA", ...DSM }, equipment: "DryVan",
  departAtMs: T0, deadlineAtMs: T0 + 245 * 60_000, driverName: "Jake", driverPhone: "+15550001", customerEmail: null, minutesSinceBreakAtDepart: 0,
};

// The page's heartbeat lands every 61 seconds, so a dwell is almost never a
// whole number of minutes. The driver reads "15 min", never "15.25 min".
describe("the stop question", () => {
  it("speaks whole minutes even when the fixes do not land on the minute", async () => {
    const clock = new FakeClock(T0), messenger = new MemoryMessenger(), router = new StraightRouter(60);
    const geometry = (await router.route(KC, DSM, { equipment: "DryVan", departAtMs: T0 })).geometry;
    const agent = new Agent({ clock, router, sheet: new MemorySheet(), messenger, phone: new MemoryPhone(), mailer: new MemoryMailer(), classifier: new KeywordClassifier(), events: new MemoryEvents(), restStops: [], landmarks: [], dispatcherEmail: "boss@x", tz: "America/Chicago", policy: POLICY }, brief);
    await agent.start(); clock.set(T0); await agent.onAccept();
    const at = (mi: number) => pointAlongRoute(geometry, mi / 179.5);
    const ping = async (i: number, mi: number) => { const ms = T0 + i * 61_000; clock.set(ms); await agent.onPing({ atMs: ms, ...at(mi) }); };
    for (let i = 0; i <= 30; i++) await ping(i, i);
    for (let i = 31; i <= 50; i++) await ping(i, 31);
    const question = messenger.sent.find((m) => /stopped/.test(m.text));
    expect(question).toBeDefined();
    expect(question!.text).toMatch(/stopped \d+ min near/);
    expect(question!.text).not.toMatch(/\d\.\d/);
  });
});
