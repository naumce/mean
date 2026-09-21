import { beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/core/agent.js";
import { MAX_DELIVERY_FAILURES } from "../../src/core/constants.js";
import { pointAlongRoute } from "../../src/core/geo.js";
import { STANDARD } from "../../src/core/policy.js";
import { FakeClock, KeywordClassifier, MemoryEvents, MemoryMailer, MemoryMessenger, MemoryPhone, MemorySheet, StraightRouter } from "../../src/fakes/index.js";
import type { Brief, LngLat } from "../../src/core/types.js";

// Pre-policy test: exercises live sends, so shadow is forced off.
const POLICY = { ...STANDARD, shadow: false };

// A messenger whose gateway goes down for the night once the invite is out.
class DeadMessenger extends MemoryMessenger {
  dead = false;
  attempts = 0;
  override async sendChat(phone: string, text: string): Promise<void> {
    if (!this.dead) return super.sendChat(phone, text);
    this.attempts += 1; throw new Error("503 gateway");
  }
  override async sendSms(phone: string, text: string): Promise<void> {
    if (!this.dead) return super.sendSms(phone, text);
    this.attempts += 1; throw new Error("503 gateway");
  }
}

const KC = { lat: 39.1, lng: -94.58 }, DSM = { lat: 41.59, lng: -93.62 };
const T0 = Date.UTC(2026, 8, 6, 11, 10), MIN = 60_000, t = (m: number) => T0 + m * MIN;
const brief: Brief = {
  loadRef: "W-19", origin: { name: "Kansas City, MO", ...KC }, destination: { name: "Des Moines, IA", ...DSM }, equipment: "DryVan",
  departAtMs: T0, deadlineAtMs: t(245), driverName: "Jake", driverPhone: "+15550001", customerEmail: null, minutesSinceBreakAtDepart: 0,
};

describe("delivery-failure budget", () => {
  let clock: FakeClock, messenger: DeadMessenger, mailer: MemoryMailer, events: MemoryEvents, agent: Agent, geometry: LngLat[];
  beforeEach(async () => {
    clock = new FakeClock(T0); messenger = new DeadMessenger(); mailer = new MemoryMailer(); events = new MemoryEvents();
    const router = new StraightRouter(60);
    geometry = (await router.route(KC, DSM, { equipment: "DryVan", departAtMs: T0 })).geometry;
    agent = new Agent({ clock, router, sheet: new MemorySheet(), messenger, phone: new MemoryPhone(), mailer, classifier: new KeywordClassifier(), events, restStops: [], landmarks: [], dispatcherEmail: "boss@x", tz: "America/Chicago", policy: POLICY }, brief);
    await agent.start(); clock.set(T0); await agent.onAccept();
    messenger.dead = true;
  });
  const at = (mi: number) => pointAlongRoute(geometry, mi / 179.5);
  const drive = async (a: number, b: number, mi: (m: number) => number) => { for (let m = a; m <= b; m++) { clock.set(t(m)); await agent.onPing({ atMs: t(m), ...at(mi(m)) }); } };

  it("escalates to the dispatcher once after MAX_DELIVERY_FAILURES consecutive failed sends, and stops trying on every ladder", async () => {
    await drive(0, 61, (m) => m);
    // Parked at mile 62: the stop rule fires at 77 and the delay rule at 93.
    // Every send fails; rungs are held; retries come on the cooldown; the
    // stop ladder's budget trips at 97 and takes the delay ladder down with
    // it — one dead gateway is one piece of news, not one per anomaly.
    await drive(62, 120, () => 62);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].subject).toMatch(/could not reach/i);
    expect(messenger.attempts).toBeGreaterThanOrEqual(MAX_DELIVERY_FAILURES);
    // Every attempt is on the record as a failure, and no ladder message was ever claimed sent.
    const ladderActions = events.events.filter((e) => e.kind === "action" && e.evidence.anomalyKey !== undefined);
    expect(ladderActions.filter((e) => e.evidence.failed === true)).toHaveLength(messenger.attempts);
    expect(ladderActions.some((e) => e.evidence.failed !== true)).toBe(false);
    // Once the dispatcher has it, the dead gateway is left alone.
    const attemptsAtEscalation = messenger.attempts;
    await drive(121, 180, () => 62);
    expect(messenger.attempts).toBe(attemptsAtEscalation);
    expect(mailer.sent).toHaveLength(1);
    expect(Object.values(agent.state.ladders).every((l) => l.stopped && l.stoppedReason === "escalated")).toBe(true);
  });

  it("a ladder the driver already answered keeps its own reason when a sibling's budget trips", async () => {
    // Gateway alive: the stop question goes out at 77 and Jake answers it.
    messenger.dead = false;
    await drive(0, 61, (m) => m);
    await drive(62, 78, () => 62);
    expect(agent.state.openQuestionKey).not.toBeNull();
    clock.set(t(79));
    await agent.onReply({ atMs: t(79), channel: "chat", rawText: "bathroom" });
    const stopKey = Object.keys(agent.state.ladders)[0];
    expect(agent.state.ladders[stopKey].stoppedReason).toBe("replied");
    // Then the gateway dies. Still parked, the delay ladder starts at 93 and burns its budget.
    messenger.dead = true;
    await drive(80, 130, () => 62);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].subject).toMatch(/could not reach/i);
    expect(agent.state.ladders[stopKey].stoppedReason).toBe("replied");
    expect(agent.state.ladders["delay"].stoppedReason).toBe("escalated");
  });
});
