import { beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/core/agent.js";
import { STANDARD } from "../src/core/policy.js";
import type { Policy } from "../src/core/policy.js";
import { UNKNOWN_RESPONSE } from "../src/core/situations.js";
import type { Brief, LngLat, RouteAnswer } from "../src/core/types.js";
import type { RouterPort } from "../src/ports/index.js";
import { pointAlongRoute } from "../src/core/geo.js";
import {
  FakeClock, KeywordClassifier, MemoryEvents, MemoryMailer, MemoryMessenger, MemoryPhone, MemorySheet, StraightRouter,
} from "../src/fakes/index.js";

// These tests predate policy: they assert on real sends through the fakes,
// so every Agent here gets STANDARD's thresholds with shadow forced off.
// STANDARD.shadow defaults true (a fresh policy is a rehearsal until a
// dispatcher reviews it) — shadow itself is exercised in policy.test.ts.
const POLICY: Policy = { ...STANDARD, shadow: false };

const KC = { lat: 39.1, lng: -94.58 };
const DSM = { lat: 41.59, lng: -93.62 };
const T0 = Date.UTC(2026, 8, 6, 11, 10); // 06:10 America/Chicago
const MIN = 60_000;
const t = (min: number) => T0 + min * MIN;

const brief: Brief = {
  loadRef: "W-19", origin: { name: "Kansas City, MO", ...KC }, destination: { name: "Des Moines, IA", ...DSM },
  equipment: "DryVan", departAtMs: T0, deadlineAtMs: t(245), driverName: "Jake Morrow", driverPhone: "+15550001",
  customerEmail: "ops@customer.example", minutesSinceBreakAtDepart: 370,
};

let clock: FakeClock, sheet: MemorySheet, messenger: MemoryMessenger, phone: MemoryPhone, mailer: MemoryMailer, events: MemoryEvents;
let geometry: LngLat[];
let agent: Agent;
const at = (mi: number) => pointAlongRoute(geometry, mi / 179.5);

beforeEach(async () => {
  clock = new FakeClock(T0);
  sheet = new MemorySheet(); messenger = new MemoryMessenger(); phone = new MemoryPhone(); mailer = new MemoryMailer(); events = new MemoryEvents();
  const router = new StraightRouter(60);
  geometry = (await router.route(KC, DSM)).geometry;
  const restStop = { name: "Love's Osceola", ...pointAlongRoute(geometry, 90 / 179.5) };
  agent = new Agent(
    { clock, router, sheet, messenger, phone, mailer, classifier: new KeywordClassifier(), events,
      restStops: [restStop], landmarks: [{ name: "Bethany, MO", ...pointAlongRoute(geometry, 62 / 179.5) }],
      dispatcherEmail: "boss@dispatch.example", tz: "America/Chicago", policy: POLICY },
    brief,
  );
});

/** Drive the truck: one ping per minute from `fromMin` to `toMin`, at `mi(min)`. */
async function drive(fromMin: number, toMin: number, mi: (min: number) => number): Promise<void> {
  for (let m = fromMin; m <= toMin; m += 1) {
    clock.set(t(m));
    await agent.onPing({ atMs: t(m), ...at(mi(m)) });
  }
}
const accepted = async () => { await agent.start(); clock.set(t(0)); await agent.onAccept(); };

/** A chat gateway that is down for its first `failures` sends. */
class FlakyMessenger extends MemoryMessenger {
  constructor(private failures: number) { super(); }
  override async sendChat(phone: string, text: string): Promise<void> {
    if (this.failures > 0) { this.failures -= 1; throw new Error("gateway 503"); }
    await super.sendChat(phone, text);
  }
}

/** A sheet whose status writes always fail. `appendLog` still works: the
 *  event log is the agent's own memory, and a test that broke it would be
 *  testing a different outage. */
class BrokenSheet extends MemorySheet {
  override async writeStatus(): Promise<void> {
    throw new Error("quota exceeded");
  }
}

/** A provider that answers 200 with a route nothing can be computed from. */
class UnusableRouter implements RouterPort {
  async route(): Promise<RouteAnswer> {
    return { geometry: [[-94.58, 39.1], [-93.62, 41.59]], distanceMi: 179.5, driveMin: 0 };
  }
}

describe("Agent", () => {
  it("plans on start and invites the driver by SMS with the load's details", async () => {
    await agent.start();
    expect(agent.state.status).toBe("invited");
    expect(agent.state.plan?.breakWindow?.recommended?.name).toBe("Love's Osceola");
    const sms = messenger.sent.find((m) => m.channel === "sms");
    expect(sms?.text).toContain("W-19");
    expect(sms?.text).toContain("Des Moines");
    expect(sms?.text).toMatch(/accept/i);
    expect(events.events.map((e) => e.kind)).toEqual(["plan", "action", "sheet_write"]);
    expect(sheet.cells["W-19"]["Agent Status"]).toBe("Invited");
  });

  it("goes to Attention on an unusable route, and never invites the driver onto it", async () => {
    agent = new Agent(
      { clock, router: new UnusableRouter(), sheet, messenger, phone, mailer, classifier: new KeywordClassifier(), events,
        restStops: [], landmarks: [], dispatcherEmail: "boss@dispatch.example", tz: "America/Chicago", policy: POLICY },
      brief,
    );
    await agent.start();
    expect(agent.state.status).toBe("attention");
    expect(agent.state.attentionReason).toMatch(/^route unusable: /);
    expect(agent.state.plan).toBeNull();
    expect(messenger.sent).toHaveLength(0); // no invite onto a route we cannot plan
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe("boss@dispatch.example");
    expect(mailer.sent[0].subject).toMatch(/route unusable/);
    const failed = events.events.find((e) => e.kind === "plan" && e.evidence.failed === true);
    expect(String(failed?.evidence.error)).toMatch(/no length or drive time/);
  });

  it("goes to Attention and emails the dispatcher when the driver has not accepted by departure + 30", async () => {
    await agent.start();
    clock.set(t(29)); await agent.tick();
    expect(mailer.sent).toHaveLength(0);
    clock.set(t(31)); await agent.tick();
    expect(agent.state.status).toBe("attention");
    expect(mailer.sent[0].to).toBe("boss@dispatch.example");
    expect(mailer.sent[0].body).toMatch(/not accepted/i);
    // The cell carries the reason after a dash — "Attention — not accepted…".
    expect(sheet.cells["W-19"]["Agent Status"]).toMatch(/^Attention/);
  });

  it("asks ONE question about an unplanned stop, naming the place, and respects the cooldown", async () => {
    await accepted();
    await drive(0, 61, (m) => m);
    await drive(62, 78, () => 62); // parked at Bethany
    const chats = messenger.sent.filter((m) => m.channel === "chat");
    expect(chats).toHaveLength(1);
    expect(chats[0].text).toMatch(/stopped 15 min/i);
    expect(chats[0].text).toContain("Bethany, MO");
    expect(agent.state.openQuestionKey).toBe("unplanned_stop@" + t(62));
    const anomaly = events.events.find((e) => e.kind === "anomaly");
    expect(anomaly?.evidence.observedMin).toBe(15);
  });

  it("refuses a ping that arrives OUT OF ORDER — a stale fix never resolves a live anomaly", async () => {
    // A backgrounded tab flushes its queue and a fix from forty minutes ago
    // lands last. Applied, it moves the truck back to mile 40, closes the
    // Bethany stop the agent is still waiting on, and logs it "resolved".
    await accepted();
    await drive(0, 61, (m) => m);
    await drive(62, 78, () => 62);
    expect(messenger.sent.filter((m) => m.channel === "chat")).toHaveLength(1);
    const pingsBefore = agent.state.pings.length;

    clock.set(t(79));
    await agent.onPing({ atMs: t(40), ...at(40) });

    expect(agent.state.pings).toHaveLength(pingsBefore);
    expect(agent.state.pings.at(-1)?.atMs).toBe(t(78));
    expect(messenger.sent.filter((m) => m.channel === "chat")).toHaveLength(1);
    expect(events.events.some((e) => e.kind === "anomaly" && e.evidence.resolved === true)).toBe(false);
    const ignored = events.events.find((e) => e.kind === "ping" && e.evidence.ignored === true);
    expect(ignored?.evidence.reason).toBe("out of order");
    expect(ignored?.evidence.atMs).toBe(t(40));
  });

  it("records the driver's words verbatim, answers from the library, and stops the ladder", async () => {
    await accepted();
    await drive(0, 61, (m) => m);
    await drive(62, 77, () => 62);
    clock.set(t(81));
    await agent.onReply({ atMs: t(81), channel: "chat", rawText: "had to use the bathroom, rolling now" });
    const reply = events.events.find((e) => e.kind === "reply");
    expect(reply?.evidence.rawText).toBe("had to use the bathroom, rolling now");
    expect(reply?.evidence.situationKey).toBe("rest");
    expect(messenger.sent.at(-1)?.text).toBe("Got it, thanks.");
    expect(agent.state.openQuestionKey).toBeNull();
    expect(mailer.sent).toHaveLength(0); // level 0: the dispatcher hears in the morning
    await drive(82, 95, (m) => 62 + (m - 82));
    expect(messenger.sent.filter((m) => m.channel === "chat")).toHaveLength(2); // question + answer, nothing more
  });

  it("hands an unrecognized reply to the dispatcher with the words intact, never a guess", async () => {
    await accepted();
    await drive(0, 61, (m) => m);
    await drive(62, 77, () => 62);
    clock.set(t(80));
    await agent.onReply({ atMs: t(80), channel: "chat", rawText: "asdf qwer" });
    expect(messenger.sent.at(-1)?.text).toBe(UNKNOWN_RESPONSE);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].body).toContain("asdf qwer");
    expect(mailer.sent[0].body).toMatch(/didn't understand|not understood/i);
  });

  it("escalates a level-3 reply immediately", async () => {
    await accepted();
    await drive(0, 61, (m) => m);
    await drive(62, 77, () => 62);
    clock.set(t(80));
    await agent.onReply({ atMs: t(80), channel: "chat", rawText: "truck broke down, engine light" });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].subject).toMatch(/breakdown/i);
    expect(mailer.sent[0].body).toContain("truck broke down, engine light");
    // The 07:27 question WAS answered. Calling it silence in the same email
    // that quotes the answer is the kind of contradiction a dispatcher never
    // forgives.
    expect(mailer.sent[0].body).toMatch(/07:27 — chat: .* — answered 07:30/);
    expect(mailer.sent[0].body).not.toMatch(/— no reply/);
  });

  it("writes the sheet the moment tracking starts, not on the next cadence tick", async () => {
    await accepted();
    expect(sheet.cells["W-19"]["Agent Status"]).toBe("Accepted");
    await drive(0, 0, (m) => m);
    expect(sheet.cells["W-19"]["Agent Status"]).toBe("Tracking");
    expect(events.events.some((e) => e.kind === "action" && e.evidence.kind === "departed")).toBe(true);
  });

  it("treats the mandatory break at the recommended stop as compliance: no message, one plan event", async () => {
    await accepted();
    await drive(0, 89, (m) => m);
    await drive(90, 140, () => 90); // 50 min at Love's Osceola, window is 65..155
    expect(messenger.sent.filter((m) => m.channel === "chat")).toHaveLength(0);
    const compliance = events.events.filter((e) => e.kind === "plan" && e.evidence.breakTakenAtMs);
    expect(compliance).toHaveLength(1);
    expect(compliance[0].evidence.at).toBe("Love's Osceola");
    expect(agent.state.breakTakenAt).toBe(t(90));
  });

  it("holds the plan line for a break taken EARLY in its window, and says nothing", async () => {
    // The window is 65..155; he takes his thirty at its very start, at a
    // registered stop of his own choosing. Measured against a line that only
    // pauses at the planned minute, he ends the break thirty behind — and is
    // messaged for it the moment he is legal again.
    agent = new Agent(
      { clock, router: new StraightRouter(60), sheet, messenger, phone, mailer, classifier: new KeywordClassifier(), events,
        restStops: [{ name: "Pilot Cameron", ...pointAlongRoute(geometry, 65 / 179.5) }], landmarks: [],
        dispatcherEmail: "boss@dispatch.example", tz: "America/Chicago", policy: POLICY },
      brief,
    );
    await accepted();
    await drive(0, 64, (m) => m);
    await drive(65, 95, () => 65); // the legal 30, at the START of the window
    expect(messenger.sent.filter((m) => m.channel === "chat")).toHaveLength(0);
    const compliance = events.events.filter((e) => e.kind === "plan" && e.evidence.breakTakenAtMs);
    expect(compliance).toHaveLength(1);
    expect(compliance[0].evidence.at).toBe("Pilot Cameron");
    expect(events.events.some((e) => e.kind === "anomaly" && e.evidence.kind === "delay")).toBe(false);
  });

  it("with hours UNKNOWN, credits an observed break and says 'hours unknown' on the row", async () => {
    // No hours on file means no window, so nothing is "inside" it — and the
    // plan carries no break, so every ETA it produces is a drive-only figure.
    agent = new Agent(
      { clock, router: new StraightRouter(60), sheet, messenger, phone, mailer, classifier: new KeywordClassifier(), events,
        restStops: [{ name: "Love's Osceola", ...pointAlongRoute(geometry, 90 / 179.5) }], landmarks: [],
        dispatcherEmail: "boss@dispatch.example", tz: "America/Chicago", policy: POLICY },
      { ...brief, minutesSinceBreakAtDepart: null },
    );
    await accepted();
    expect(agent.state.plan?.hosKnown).toBe(false);
    expect(agent.state.plan?.breakWindow).toBeNull();
    await drive(0, 89, (m) => m);
    await drive(90, 130, () => 90); // forty minutes at a registered stop
    expect(messenger.sent.filter((m) => m.channel === "chat")).toHaveLength(0);
    expect(agent.state.breakTakenAt).toBe(t(90));
    const observed = events.events.filter((e) => e.kind === "plan" && e.evidence.breakTakenAtMs);
    expect(observed).toHaveLength(1);
    expect(observed[0].evidence.hosKnown).toBe(false);
    expect(observed[0].actionTaken).toMatch(/hours not on file/);
    expect(sheet.cells["W-19"]["On Time"]).toMatch(/hours unknown/);
    expect(sheet.cells["W-19"]["ETA"]).toMatch(/no break planned — hours unknown/);
  });

  it("keeps ONE open question even when a second anomaly fires", async () => {
    await accepted();
    await drive(0, 61, (m) => m);
    await drive(62, 100, () => 62); // parked long enough for the delay rule too
    const chats = messenger.sent.filter((m) => m.channel === "chat");
    expect(chats.every((c) => !/behind/i.test(c.text))).toBe(true); // no delay question while the stop is open
    expect(events.events.filter((e) => e.kind === "anomaly").map((e) => e.evidence.kind)).toContain("delay");
  });

  it("calls when messages go unanswered, and escalates with the whole ladder after the retry", async () => {
    await accepted();
    await drive(0, 61, (m) => m);
    await drive(62, 100, () => 62);
    // 77 message · 87 again · 102 call · 107 retry · 112 escalate
    expect(phone.calls).toHaveLength(0);
    await drive(101, 107, () => 62);
    expect(phone.calls).toHaveLength(2);
    expect(phone.calls[0].script).toContain("Bethany, MO");
    expect(mailer.sent).toHaveLength(0);
    await drive(108, 112, () => 62);
    expect(mailer.sent).toHaveLength(1);
    const body = mailer.sent[0].body;
    expect(body).toMatch(/no reply/i);
    expect(body).toMatch(/no answer/i);
    expect(body).toMatch(/07:27/); // the first question, on the dispatcher's clock
  });

  it("does not raise a delay during the mandatory break, even on a tight deadline", async () => {
    // Replay finding: the whole thirty was charged until the break was
    // complete, so sixteen minutes in the ETA passed the deadline and the
    // agent messaged him — during the one stop the plan itself required.
    agent = new Agent(
      { clock, router: new StraightRouter(60), sheet, messenger, phone, mailer, classifier: new KeywordClassifier(), events,
        restStops: [{ name: "Love's Osceola", ...pointAlongRoute(geometry, 90 / 179.5) }], landmarks: [],
        dispatcherEmail: "boss@dispatch.example", tz: "America/Chicago", policy: POLICY },
      { ...brief, deadlineAtMs: t(230) },
    );
    await accepted();
    await drive(0, 89, (m) => m);
    await drive(90, 125, () => 90); // at Love's, inside the window
    expect(messenger.sent.filter((m) => m.channel === "chat" && /behind/i.test(m.text))).toHaveLength(0);
    expect(events.events.some((e) => e.kind === "anomaly" && e.evidence.kind === "delay")).toBe(false);
  });

  it("a delay that clears and comes back climbs a FRESH ladder", async () => {
    // Replay finding: a resolved delay was kept as a stopped ladder, so the
    // real traffic delay later could never re-raise — no call, no escalation.
    await accepted();
    await drive(0, 76, (m) => m * 0.6); // slow: 30.4 behind at 76 -> delay, one question
    await drive(77, 90, (m) => 45.6 + (m - 76) * 3); // catches up: the delay clears
    await drive(91, 140, (m) => 87.6 + (m - 90) * 0.25); // slow again: ETA passes the deadline
    const delayChats = messenger.sent.filter((m) => m.channel === "chat" && /behind/i.test(m.text));
    expect(delayChats).toHaveLength(2);
    expect(events.events.filter((e) => e.kind === "anomaly" && e.evidence.key === "delay" && e.evidence.resolved === true)).toHaveLength(1);
  });

  it("credits a reply to the ask it answered, not to an earlier ask that shares the key", async () => {
    // Two delays in one trip share the key "delay". The first question was
    // never answered; the second was. The escalation email must say exactly
    // that — not credit the second answer to the first question.
    await accepted();
    await drive(0, 76, (m) => m * 0.6); // delay #1 -> question at 07:25, never answered
    await drive(77, 90, (m) => 45.6 + (m - 76) * 3); // clears
    await drive(91, 140, (m) => 87.6 + (m - 90) * 0.25); // delay #2 -> question at 08:25
    clock.set(t(141));
    await agent.onReply({ atMs: t(141), channel: "chat", rawText: "truck broke down" }); // answers #2, level 3 -> escalation
    const body = mailer.sent.at(-1)!.body;
    expect(body).toMatch(/07:25 — chat: .* — no reply/);
    expect(body).toMatch(/08:25 — chat: .* — answered 08:31/);
  });

  it("does not classify a transcript the speech engine is unsure of", async () => {
    // 0.3 confidence on "truck broke down" could as easily be "truck broke
    // down" as "truck's not down". A guess at that confidence is how a load
    // gets a breakdown on its record that the driver never reported.
    phone.outcomes = [{ answered: true, transcript: "truck broke down", confidence: 0.3 }];
    await accepted();
    await drive(0, 61, (m) => m);
    await drive(62, 102, () => 62); // 77 message · 87 again · 102 call — answered

    expect(phone.calls).toHaveLength(1);
    const reply = events.events.find((e) => e.kind === "reply");
    expect(reply?.evidence.rawText).toBe("truck broke down");
    expect(reply?.evidence.situationKey).toBeNull();
    expect(reply?.evidence.confidence).toBe(0.3);
    expect(reply?.evidence.sttBelowFloor).toBe(true);
    const respond = events.events.find((e) => e.kind === "action" && e.evidence.kind === "respond");
    expect(respond?.evidence.text).toBe(UNKNOWN_RESPONSE);
    expect(respond?.evidence.situationKey).toBeNull();
    const esc = mailer.sent.find((m) => /not understood/i.test(m.subject))!;
    expect(esc.body).toContain("truck broke down"); // the words survive intact

    // A sent email carries the provider's id, so a follow-on adapter can
    // thread the dispatcher's reply back to it.
    await agent.onDispatcherReply("send the customer email");
    const emailEvent = events.events.filter((e) => e.kind === "email").at(-1);
    expect(emailEvent?.evidence.messageId).toBe(mailer.sent.at(-1)!.messageId);
    expect(String(emailEvent?.evidence.messageId)).toMatch(/^m\d+$/);
  });

  it("survives a dead chat gateway: the rung does not advance, and the retry comes after the cooldown", async () => {
    // A 503 from the messenger used to throw straight out of onPing and kill
    // the tick. Worse, had it been swallowed, the ladder would have climbed
    // on a message the driver never received.
    const flaky = new FlakyMessenger(1);
    agent = new Agent(
      { clock, router: new StraightRouter(60), sheet, messenger: flaky, phone, mailer, classifier: new KeywordClassifier(), events,
        restStops: [], landmarks: [{ name: "Bethany, MO", ...pointAlongRoute(geometry, 62 / 179.5) }],
        dispatcherEmail: "boss@dispatch.example", tz: "America/Chicago", policy: POLICY },
      brief,
    );
    await agent.start(); clock.set(t(0)); await agent.onAccept();
    for (let m = 0; m <= 61; m += 1) { clock.set(t(m)); await agent.onPing({ atMs: t(m), ...at(m) }); }
    for (let m = 62; m <= 77; m += 1) { clock.set(t(m)); await agent.onPing({ atMs: t(m), ...at(62) }); }

    const key = "unplanned_stop@" + t(62);
    expect(agent.state.ladders[key].rung).toBe(0); // nothing reached him: no climb
    expect(agent.state.ladders[key].lastActionMs).toBe(t(77));
    expect(agent.state.openQuestionKey).toBeNull(); // there is no open question
    expect(flaky.sent.filter((m) => m.channel === "chat")).toHaveLength(0);
    const failed = events.events.find((e) => e.kind === "action" && e.evidence.failed === true);
    expect(failed?.evidence.error).toBe("gateway 503");
    expect(failed?.actionTaken).toBe("delivery failed — will retry after cooldown");

    for (let m = 78; m <= 86; m += 1) { clock.set(t(m)); await agent.onPing({ atMs: t(m), ...at(62) }); }
    expect(flaky.sent.filter((m) => m.channel === "chat")).toHaveLength(0); // cooldown holds
    clock.set(t(87)); await agent.onPing({ atMs: t(87), ...at(62) });
    expect(flaky.sent.filter((m) => m.channel === "chat")).toHaveLength(1);
    expect(agent.state.ladders[key].rung).toBe(1);
    expect(agent.state.openQuestionKey).toBe(key);
  });

  it("survives a sheet that cannot be written: Attention, one email, then silence", async () => {
    agent = new Agent(
      { clock, router: new StraightRouter(60), sheet: new BrokenSheet(), messenger, phone, mailer,
        classifier: new KeywordClassifier(), events, restStops: [], landmarks: [],
        dispatcherEmail: "boss@dispatch.example", tz: "America/Chicago", policy: POLICY },
      brief,
    );
    await agent.start();
    expect(agent.state.status).toBe("attention");
    expect(agent.state.attentionReason).toMatch(/^sheet write failed: quota exceeded$/);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe("boss@dispatch.example");
    expect(mailer.sent[0].subject).toMatch(/sheet write failed/);
    const first = events.events.filter((e) => e.kind === "sheet_write" && e.evidence.failed === true).length;
    expect(first).toBeGreaterThanOrEqual(1);

    clock.set(t(1));
    await agent.onAccept(); // writes the sheet again, and fails again
    expect(mailer.sent).toHaveLength(1); // recorded, not re-escalated
    const second = events.events.filter((e) => e.kind === "sheet_write" && e.evidence.failed === true).length;
    expect(second).toBeGreaterThan(first);
    expect(events.events.at(-1)?.evidence.error).toBe("quota exceeded");
  });

  it("keeps the customer draft until it is SENT, and says so when there is nothing to send", async () => {
    // A second escalation that happens not to be at risk used to overwrite
    // the pending draft with null, so the dispatcher's "send the customer
    // email" — arriving minutes later — silently did nothing.
    await accepted();
    await drive(0, 61, (m) => m);
    await drive(62, 112, () => 62); // the stop ladder runs all the way to escalation A
    const escA = mailer.sent.find((m) => m.to === "boss@dispatch.example");
    expect(escA!.attachments[0].name).toBe("customer-draft.txt");
    const draftBody = agent.state.customerDraft!.body;

    await drive(113, 150, (m) => 62 + (m - 112) * 2.5); // catches up: no longer at risk
    clock.set(t(151));
    await agent.onReply({ atMs: t(151), channel: "chat", rawText: "police pulled me over" }); // level 2 → escalation B
    const escB = mailer.sent.filter((m) => m.to === "boss@dispatch.example").at(-1)!;
    expect(escB.attachments).toHaveLength(0);
    expect(agent.state.customerDraft?.body).toBe(draftBody); // B did not clear A's draft

    await agent.onDispatcherReply("send the customer email");
    const toCustomer = mailer.sent.filter((m) => m.to === "ops@customer.example");
    expect(toCustomer).toHaveLength(1);
    expect(toCustomer[0].body).toBe(draftBody);
    expect(agent.state.customerDraft).toBeNull();

    await agent.onDispatcherReply("send the customer email");
    const nothing = mailer.sent.at(-1)!;
    expect(nothing.to).toBe("boss@dispatch.example");
    expect(nothing.subject).toBe("[W-19] Nothing to send");
    expect(nothing.body).toBe("No customer note is pending for this load.");
    expect(events.events.at(-1)?.evidence.kind).toBe("nothing_to_send");
  });

  it("speaks a STALE fix as 'as of', and withholds the customer draft while the position is old", async () => {
    // The truck stops reporting at 07:50. Everything the agent says after
    // that is about a position an hour old, and it has to say so — and it
    // must not hand the dispatcher a customer draft built on it.
    await accepted();
    await drive(0, 100, (m) => m);
    for (let m = 101; m <= 160; m += 1) { clock.set(t(m)); await agent.tick(); }

    const chats = messenger.sent.filter((c) => c.channel === "chat");
    expect(chats.some((c) => /haven't seen your location/.test(c.text))).toBe(true);
    const delayChats = chats.filter((c) => /behind/.test(c.text));
    expect(delayChats.length).toBeGreaterThan(0);
    for (const c of delayChats) expect(c.text).toContain("as of your 07:50 position");

    const esc = mailer.sent.find((m) => /gone dark/.test(m.subject));
    expect(esc).toBeDefined();
    expect(esc!.body).toContain("No customer draft");
    expect(esc!.body).toMatch(/as of 07:50/);
    expect(esc!.attachments).toHaveLength(0);
    const escEvent = events.events.find((e) => e.kind === "escalation");
    expect(escEvent!.evidence.deadlineAtRisk).toBe(true);
    expect(escEvent!.evidence.draftWithheld).toBe("stale fix");
    expect(agent.state.customerDraft).toBeNull();
  });

  it("marks an ON-TIME arrival, writes the sheet, and sends the customer the arrival status", async () => {
    await accepted();
    await drive(0, 179, (m) => m);
    await drive(180, 186, () => 179.5);
    expect(agent.state.status).toBe("arrived");
    expect(sheet.cells["W-19"]["Agent Status"]).toBe("Arrived");
    const toCustomer = mailer.sent.find((m) => m.to === "ops@customer.example");
    expect(toCustomer?.body).toMatch(/arrived/i);
    expect(toCustomer?.body).toMatch(/on time|ahead/i);
  });

  it("a LATE arrival is drafted for the dispatcher, not sent to the customer", async () => {
    // Good news is routine status. Bad news is a decision, and the machine
    // does not get to make it: the customer hears "we're late" from a human.
    agent = new Agent(
      { clock, router: new StraightRouter(60), sheet, messenger, phone, mailer, classifier: new KeywordClassifier(), events,
        restStops: [], landmarks: [], dispatcherEmail: "boss@dispatch.example", tz: "America/Chicago", policy: POLICY },
      { ...brief, deadlineAtMs: t(100) },
    );
    await accepted();
    await drive(0, 179, (m) => m);
    await drive(180, 186, () => 179.5);
    expect(agent.state.status).toBe("arrived");
    expect(mailer.sent.filter((m) => m.to === "ops@customer.example")).toHaveLength(0);

    const toDispatcher = mailer.sent.find((m) => /min late — customer note drafted/.test(m.subject));
    expect(toDispatcher).toBeDefined();
    expect(toDispatcher!.subject).toMatch(/^\[W-19\] arrived \d+ min late — customer note drafted$/);
    expect(toDispatcher!.body).toMatch(/Reply "send the customer email" to send the attached note\./);
    expect(toDispatcher!.attachments[0].name).toBe("customer-arrival.txt");
    const draftEvent = events.events.find((e) => e.kind === "email" && e.evidence.kind === "arrival_late_draft");
    expect(draftEvent?.evidence.to).toBe("boss@dispatch.example");

    await agent.onDispatcherReply("send the customer email");
    const toCustomer = mailer.sent.filter((m) => m.to === "ops@customer.example");
    expect(toCustomer).toHaveLength(1);
    expect(toCustomer[0].subject).toBe("Load W-19 arrived");
    expect(toCustomer[0].body).toMatch(/minutes after the .* deadline/);
  });

  it("with hours KNOWN and no break due, a long stop at a fuel stop is time lost, not a break", async () => {
    // The credit exists for a break the driver is owed. On a fresh clock no
    // break is due, so forty minutes at a registered stop is honestly forty
    // minutes behind the plan — the delay rule may ask about it, the stop
    // rule stays silent about the stop itself, and nothing is "taken".
    agent = new Agent(
      { clock, router: new StraightRouter(60), sheet, messenger, phone, mailer, classifier: new KeywordClassifier(), events,
        restStops: [{ name: "Pilot", ...pointAlongRoute(geometry, 60 / 179.5) }], landmarks: [],
        dispatcherEmail: "boss@dispatch.example", tz: "America/Chicago", policy: POLICY },
      { ...brief, minutesSinceBreakAtDepart: 0 },
    );
    await accepted();
    expect(agent.state.plan?.hosKnown).toBe(true);
    expect(agent.state.plan?.breakWindow).toBeNull();
    await drive(0, 59, (m) => m);
    await drive(60, 100, () => 60); // 40 min at the Pilot
    expect(agent.state.breakTakenAt).toBeNull();
    expect(events.events.some((e) => e.kind === "plan" && e.evidence.breakTakenAtMs)).toBe(false);
    const chats = messenger.sent.filter((m) => m.channel === "chat").map((m) => m.text);
    expect(chats.some((c) => /stopped/i.test(c))).toBe(false); // the stop rule exempts a registered stop
    expect(chats.some((c) => /behind/i.test(c))).toBe(true); // the delay rule tells the truth about the time
  });

  it("after a late arrival, a later escalation never replaces the arrival note with an ETA", async () => {
    // Regression from the fix wave: the arrival draft and the delay draft
    // share one slot, and a post-arrival escalation built a delay draft for
    // a truck already at the dock — approving "the note you were shown"
    // then sent the customer a future ETA for a delivered load.
    agent = new Agent(
      { clock, router: new StraightRouter(60), sheet, messenger, phone, mailer, classifier: new KeywordClassifier(), events,
        restStops: [], landmarks: [], dispatcherEmail: "boss@dispatch.example", tz: "America/Chicago", policy: POLICY },
      { ...brief, deadlineAtMs: t(100) },
    );
    await accepted();
    await drive(0, 179, (m) => m);
    await drive(180, 186, () => 179.5); // arrived ~80 min late -> note drafted for the dispatcher
    expect(agent.state.status).toBe("arrived");
    expect(agent.state.customerDraft?.kind).toBe("customer_arrival");
    clock.set(t(190));
    await agent.onReply({ atMs: t(190), channel: "chat", rawText: "police pulled me over" }); // level 2 -> escalation, after arrival
    expect(agent.state.customerDraft?.kind).toBe("customer_arrival");
    await agent.onDispatcherReply("send the customer email");
    const toCustomer = mailer.sent.filter((m) => m.to === "ops@customer.example");
    expect(toCustomer).toHaveLength(1);
    expect(toCustomer[0].subject).toMatch(/arrived/i);
    expect(toCustomer[0].body).not.toMatch(/ETA/);
  });
});
