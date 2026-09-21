import { describe, expect, it } from "vitest";
import { Agent } from "../../src/core/agent.js";
import { pointAlongRoute } from "../../src/core/geo.js";
import { applyAction, initialLadder, nextAction } from "../../src/core/ladder.js";
import { STANDARD } from "../../src/core/policy.js";
import type { Policy } from "../../src/core/policy.js";
import { FakeClock, KeywordClassifier, MemoryEvents, MemoryMailer, MemoryMessenger, MemoryPhone, MemorySheet, StraightRouter } from "../../src/fakes/index.js";
import type { Brief } from "../../src/core/types.js";

const KC = { lat: 39.1, lng: -94.58 }, DSM = { lat: 41.59, lng: -93.62 };
const T0 = Date.UTC(2026, 8, 6, 11, 10), MIN = 60_000, t = (m: number) => T0 + m * MIN;
const brief: Brief = {
  loadRef: "W-POLICY", origin: { name: "Kansas City, MO", ...KC }, destination: { name: "Des Moines, IA", ...DSM }, equipment: "DryVan",
  departAtMs: T0, deadlineAtMs: t(245), driverName: "Jake", driverPhone: "+15550001", customerEmail: null, minutesSinceBreakAtDepart: 0,
};

describe("STANDARD", () => {
  it("carries the old constants' values, so a trip on STANDARD behaves exactly as the agent always has", () => {
    expect(STANDARD.stopMin).toBe(15);
    expect(STANDARD.delayMin).toBe(30);
    expect(STANDARD.darkMin).toBe(20);
    expect(STANDARD.darkAtStopMin).toBe(60);
    expect(STANDARD.offRouteMi).toBeCloseTo(3.1, 1);
    expect(STANDARD.offRouteMin).toBe(10);
    expect(STANDARD.rungGapMin).toBe(5); // what CALL_RETRY_MIN did
    expect(STANDARD.maxCalls).toBe(2);
  });

  it("starts every trip as a rehearsal: shadow is on until a dispatcher reviews it", () => {
    expect(STANDARD.shadow).toBe(true);
  });
});

describe("policy.stopMin bounds the unplanned-stop rule", () => {
  /** Same route, same pings, only the policy differs: drive 31 minutes,
   *  then park for 10 — long enough to ask under a 5-minute policy, not
   *  long enough under the 15-minute default. */
  async function driveAndPark(policy: Policy): Promise<MemoryMessenger> {
    const clock = new FakeClock(T0);
    const messenger = new MemoryMessenger();
    const router = new StraightRouter(60);
    const geometry = (await router.route(KC, DSM, { equipment: "DryVan", departAtMs: T0 })).geometry;
    const agent = new Agent(
      {
        clock, router, sheet: new MemorySheet(), messenger, phone: new MemoryPhone(), mailer: new MemoryMailer(),
        classifier: new KeywordClassifier(), events: new MemoryEvents(), restStops: [], landmarks: [],
        dispatcherEmail: "boss@x", tz: "America/Chicago", policy,
      },
      brief,
    );
    await agent.start();
    clock.set(T0);
    await agent.onAccept();
    const at = (mi: number) => pointAlongRoute(geometry, mi / 179.5);
    for (let m = 0; m <= 30; m += 1) { clock.set(t(m)); await agent.onPing({ atMs: t(m), ...at(m) }); }
    for (let m = 31; m <= 41; m += 1) { clock.set(t(m)); await agent.onPing({ atMs: t(m), ...at(31) }); } // 10 min parked
    return messenger;
  }

  it("a stop shorter than the policy's stopMin is not an anomaly, one longer is", async () => {
    // shadow forced off on both: the only variable under test is stopMin,
    // not whether a send happens at all.
    const quiet = await driveAndPark({ ...STANDARD, shadow: false }); // stopMin 15 — 10 min never trips it
    const asks = await driveAndPark({ ...STANDARD, stopMin: 5, shadow: false }); // stopMin 5 — 10 min does
    expect(quiet.sent.filter((m) => m.channel === "chat" && /stopped/i.test(m.text))).toHaveLength(0);
    expect(asks.sent.filter((m) => m.channel === "chat" && /stopped/i.test(m.text))).toHaveLength(1);
  });
});

describe("policy.maxCalls bounds the ladder", () => {
  const T1 = 1_000_000;
  const at = (min: number) => T1 + min * MIN;

  it("0 calls escalates straight from the rung-2 message/SMS — the driver is never called", () => {
    const policy: Policy = { ...STANDARD, maxCalls: 0 };
    let s = initialLadder();

    let a = nextAction(s, { nowMs: at(0), linkOpenedMs: at(0), policy });
    expect(a).toEqual({ rung: 1, kind: "message" });
    s = applyAction(s, a!, at(0));

    // RUNG1_COOLDOWN_MIN (10) later: rung 2, the link was just opened so it
    // is a chat again, not an SMS fallback.
    a = nextAction(s, { nowMs: at(10), linkOpenedMs: at(0), policy });
    expect(a).toEqual({ rung: 2, kind: "message_again" });
    s = applyAction(s, a!, at(10));

    // RUNG2_COOLDOWN_MIN (15) later: with a live ladder this would be
    // "call" — maxCalls 0 means it is "escalate" instead, and no call was
    // ever placed.
    a = nextAction(s, { nowMs: at(25), linkOpenedMs: at(0), policy });
    expect(a).toEqual({ rung: 4, kind: "escalate" });
  });
});

describe("policy.shadow", () => {
  const BOSS = "+38978000000";

  /** The exact stop-ladder-to-escalation scenario the live-mode tests use —
   *  message 77 · again 87 · call 102 · retry 107 · escalate 112, plus the
   *  dispatcher's briefing call — but on a shadow policy. */
  async function runShadowLadder() {
    const clock = new FakeClock(T0), messenger = new MemoryMessenger(), phone = new MemoryPhone(), mailer = new MemoryMailer();
    const events = new MemoryEvents(), sheet = new MemorySheet();
    const router = new StraightRouter(60);
    const geometry = (await router.route(KC, DSM, { equipment: "DryVan", departAtMs: T0 })).geometry;
    const agent = new Agent(
      {
        clock, router, sheet, messenger, phone, mailer, classifier: new KeywordClassifier(), events,
        restStops: [], landmarks: [], dispatcherEmail: "boss@x", dispatcherPhone: BOSS, tz: "America/Chicago",
        policy: STANDARD, // shadow: true is STANDARD's own default — no override needed
      },
      brief,
    );
    await agent.start();
    clock.set(T0);
    await agent.onAccept();
    const at = (mi: number) => pointAlongRoute(geometry, mi / 179.5);
    for (let m = 0; m <= 61; m += 1) { clock.set(t(m)); await agent.onPing({ atMs: t(m), ...at(m) }); }
    for (let m = 62; m <= 112; m += 1) { clock.set(t(m)); await agent.onPing({ atMs: t(m), ...at(62) }); }
    return { agent, messenger, phone, mailer, sheet };
  }

  it("writes a would-say line and sends nothing — the driver, the dispatcher and the customer hear nothing", async () => {
    const { agent, messenger, phone, mailer, sheet } = await runShadowLadder();

    // Nothing reached anybody: not the invite, not the stop question, not
    // the call, not the escalation email, not the dispatcher's briefing.
    expect(messenger.sent).toHaveLength(0);
    expect(phone.calls).toHaveLength(0);
    expect(mailer.sent).toHaveLength(0);

    // ...but the sheet's log knows exactly what would have gone out.
    const wouldSays = sheet.log.filter((l) => l.event.kind === "would_say");
    expect(wouldSays.length).toBeGreaterThan(0);
    for (const l of wouldSays) expect(String(l.event.actionTaken)).toMatch(/^would say:/);
    expect(wouldSays.some((l) => /stopped/i.test(String((l.event.evidence as { text?: string }).text)))).toBe(true);

    // The ladder still climbed all the way to escalation — shadow changes
    // what leaves the building, not what the agent decides.
    const ladder = Object.values(agent.state.ladders)[0];
    expect(ladder.stopped).toBe(true);
    expect(ladder.stoppedReason).toBe("escalated");
  });
});
