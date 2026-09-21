import { describe, expect, it } from "vitest";
import { Agent } from "../src/core/agent.js";
import { pointAlongRoute } from "../src/core/geo.js";
import { STANDARD } from "../src/core/policy.js";
import { FakeClock, KeywordClassifier, MemoryEvents, MemoryMailer, MemoryMessenger, MemoryPhone, MemorySheet, StraightRouter } from "../src/fakes/index.js";
import type { Brief } from "../src/core/types.js";
import type { CallOutcome } from "../src/ports/index.js";

// Pre-policy test: exercises live sends, so shadow is forced off.
const POLICY = { ...STANDARD, shadow: false };

// A phone whose call does not come back until the test says so — the live
// adapter waits up to 90 s for Twilio's webhooks, and pings keep arriving.
class HeldPhone extends MemoryPhone {
  resolvers: Array<(o: CallOutcome) => void> = [];
  override async call(phone: string, script: string): Promise<CallOutcome> {
    this.calls = [...this.calls, { phone, script, turns: [{ role: "agent", text: script }] }];
    return new Promise<CallOutcome>((resolve) => { this.resolvers = [...this.resolvers, resolve]; });
  }
  hangUpAll(): void {
    const rs = this.resolvers;
    this.resolvers = [];
    for (const r of rs) r({ answered: false, transcript: null, confidence: null });
  }
}

const KC = { lat: 39.1, lng: -94.58 }, DSM = { lat: 41.59, lng: -93.62 };
const T0 = Date.UTC(2026, 8, 6, 11, 10), MIN = 60_000, t = (m: number) => T0 + m * MIN;
const brief: Brief = {
  loadRef: "W-19", origin: { name: "Kansas City, MO", ...KC }, destination: { name: "Des Moines, IA", ...DSM }, equipment: "DryVan",
  departAtMs: T0, deadlineAtMs: t(245), driverName: "Jake", driverPhone: "+15550001", customerEmail: null, minutesSinceBreakAtDepart: 0,
};

describe("one evaluation at a time", () => {
  it("does not place a second call when a ping and a tick arrive while a call is in progress", async () => {
    const clock = new FakeClock(T0), phone = new HeldPhone(), router = new StraightRouter(60);
    const geometry = (await router.route(KC, DSM, { equipment: "DryVan", departAtMs: T0 })).geometry;
    const agent = new Agent({ clock, router, sheet: new MemorySheet(), messenger: new MemoryMessenger(), phone, mailer: new MemoryMailer(), classifier: new KeywordClassifier(), events: new MemoryEvents(), restStops: [], landmarks: [], dispatcherEmail: "boss@x", tz: "America/Chicago", policy: POLICY }, brief);
    await agent.start(); clock.set(T0); await agent.onAccept();
    const at = (mi: number) => pointAlongRoute(geometry, mi / 179.5);
    const ping = async (m: number, mi: number) => { clock.set(t(m)); await agent.onPing({ atMs: t(m), ...at(mi) }); };
    for (let m = 0; m <= 30; m++) await ping(m, m);
    // Parked at mile 31: stop at 46, chat at 46 and 56, the call is due at 71.
    for (let m = 31; m <= 70; m++) await ping(m, 31);
    expect(phone.calls).toHaveLength(0);

    clock.set(t(71));
    const inFlight = agent.onPing({ atMs: t(71), ...at(31) });
    await new Promise((r) => setTimeout(r, 0));
    expect(phone.calls).toHaveLength(1);

    // The page pings again and the worker ticks while the phone is ringing.
    clock.set(t(72));
    const laterPing = agent.onPing({ atMs: t(72), ...at(31) });
    const laterTick = agent.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(phone.calls).toHaveLength(1);

    phone.hangUpAll();
    await Promise.all([inFlight, laterPing, laterTick]);
    expect(phone.calls).toHaveLength(1);
    // The ping that arrived during the call was still recorded.
    expect(agent.state.pings[agent.state.pings.length - 1].atMs).toBe(t(72));
    const ladder = Object.values(agent.state.ladders)[0];
    expect(ladder.callAttempts).toBe(1);
  });
});
