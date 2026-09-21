import { describe, expect, it } from "vitest";
import { Agent } from "../src/core/agent.js";
import { pointAlongRoute } from "../src/core/geo.js";
import { STANDARD } from "../src/core/policy.js";
import { FakeClock, KeywordClassifier, MemoryEvents, MemoryMailer, MemoryMessenger, MemoryPhone, MemorySheet, StraightRouter } from "../src/fakes/index.js";
import type { Brief } from "../src/core/types.js";

// Pre-policy test: exercises live sends, so shadow is forced off.
const POLICY = { ...STANDARD, shadow: false };

const KC = { lat: 39.1, lng: -94.58 }, DSM = { lat: 41.59, lng: -93.62 };
const T0 = Date.UTC(2026, 8, 6, 11, 10), MIN = 60_000, t = (m: number) => T0 + m * MIN;
const brief: Brief = {
  loadRef: "W-19", origin: { name: "Kansas City, MO", ...KC }, destination: { name: "Des Moines, IA", ...DSM }, equipment: "DryVan",
  departAtMs: T0, deadlineAtMs: t(245), driverName: "Jake", driverPhone: "+15550001", customerEmail: null, minutesSinceBreakAtDepart: 0,
};

describe("accept is a one-way step", () => {
  it("a second accept from a reloaded page does not move a tracking truck back or re-stamp its departure", async () => {
    const clock = new FakeClock(T0), events = new MemoryEvents(), router = new StraightRouter(60);
    const geometry = (await router.route(KC, DSM, { equipment: "DryVan", departAtMs: T0 })).geometry;
    const agent = new Agent({ clock, router, sheet: new MemorySheet(), messenger: new MemoryMessenger(), phone: new MemoryPhone(), mailer: new MemoryMailer(), classifier: new KeywordClassifier(), events, restStops: [], landmarks: [], dispatcherEmail: "boss@x", tz: "America/Chicago", policy: POLICY }, brief);
    await agent.start();
    clock.set(t(1)); await agent.onAccept();
    clock.set(t(2)); await agent.onPing({ atMs: t(2), ...pointAlongRoute(geometry, 0) });
    expect(agent.state.status).toBe("tracking");
    expect(agent.state.departedAt).toBe(t(2));

    clock.set(t(10)); await agent.onAccept();
    expect(agent.state.status).toBe("tracking");
    expect(agent.state.acceptedAt).toBe(t(1));
    clock.set(t(11)); await agent.onPing({ atMs: t(11), ...pointAlongRoute(geometry, 11 / 179.5) });
    expect(agent.state.departedAt).toBe(t(2));
    expect(events.events.filter((e) => e.kind === "action" && e.evidence.kind === "accepted")).toHaveLength(1);
    expect(events.events.filter((e) => e.kind === "action" && e.evidence.kind === "departed")).toHaveLength(1);
  });
});
