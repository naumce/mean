// Slice 3 (2026-09-19): a driver call is a conversation when a conversation
// port is configured — the phone loops on the port's next line, the call
// event carries the exchange, and the reply arrives with the port's verdict
// instead of a keyword guess. Without a port nothing changes.
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/core/agent.js";
import { pointAlongRoute } from "../src/core/geo.js";
import { STANDARD } from "../src/core/policy.js";
import { FakeClock, KeywordClassifier, MemoryEvents, MemoryMailer, MemoryMessenger, MemoryPhone, MemorySheet, ScriptedConversation, StraightRouter } from "../src/fakes/index.js";
import { MAX_CONVERSATION_TURNS, PendingCalls } from "../src/live/pendingCalls.js";
import { TwilioPhone, type VoiceClient } from "../src/live/twilioPhone.js";
import { ClaudeConversation, systemPrompt } from "../src/live/claudeConversation.js";
import type { Brief, LngLat } from "../src/core/types.js";
import type { ConversationPort } from "../src/ports/index.js";

const POLICY = { ...STANDARD, shadow: false };
const KC = { lat: 39.1, lng: -94.58 }, DSM = { lat: 41.59, lng: -93.62 };
const T0 = Date.UTC(2026, 8, 6, 11, 10), MIN = 60_000, t = (m: number) => T0 + m * MIN;
const brief: Brief = {
  loadRef: "W-19", origin: { name: "Kansas City, MO", ...KC }, destination: { name: "Des Moines, IA", ...DSM }, equipment: "DryVan",
  departAtMs: T0, deadlineAtMs: t(245), driverName: "Jake", driverPhone: "+15550001", customerEmail: null, minutesSinceBreakAtDepart: 0,
  context: { driverId: "d1", stops: [], hazmatClass: null, commodity: "Frozen peas", customerName: "Kroger", brokerName: null, notes: "gate closes 22:00", apptText: null, updateText: null, hos: { driveRemainingMin: 540, windowRemainingMin: 700, cycleRemainingMin: 3000, minutesSinceBreak: 0 } },
};

/** Runs the stop rule up to its call rung with the given conversation port. */
async function stopUntilCall(conversation: ConversationPort | null, phone: MemoryPhone) {
  const clock = new FakeClock(T0), events = new MemoryEvents(), router = new StraightRouter(60), mailer = new MemoryMailer();
  const geometry: LngLat[] = (await router.route(KC, DSM, { equipment: "DryVan", departAtMs: T0 })).geometry;
  const agent = new Agent({ clock, router, sheet: new MemorySheet(), messenger: new MemoryMessenger(), phone, mailer, classifier: new KeywordClassifier(), conversation, events, restStops: [], landmarks: [], dispatcherEmail: "boss@x", tz: "America/Chicago", dispatcherPhone: null, policy: POLICY }, brief);
  await agent.start(); clock.set(T0); await agent.onAccept();
  const at = (mi: number) => pointAlongRoute(geometry, mi / 179.5);
  for (let m = 0; m <= 61; m++) { clock.set(t(m)); await agent.onPing({ atMs: t(m), ...at(m) }); }
  for (let m = 62; m <= 110 && phone.calls.length === 0; m++) { clock.set(t(m)); await agent.onPing({ atMs: t(m), ...at(62) }); }
  return { agent, events, mailer };
}

describe("a driver call as a conversation (agent)", () => {
  it("asks a follow-up, closes on the port's verdict, records the exchange, and the reply carries that verdict — not a keyword guess", async () => {
    const port = new ScriptedConversation([
      { say: "Got it — is the shipper loading you, or are you waiting on a door?", done: false, situationKey: null, confidence: 0, summary: null },
      { say: "Understood, thanks. I'll let dispatch know.", done: true, situationKey: "customer", confidence: 0.92, summary: "Held at the shipper, no door yet, driver expects ~40 min." },
    ]);
    const phone = new MemoryPhone();
    // "engine" would be a keyword hit for breakdown — the port's verdict must win.
    phone.driverSays = [["yeah I'm still here at the shipper, engine's fine, they're slow"], ["no door yet, they said forty minutes"]];
    phone.driverSays = [phone.driverSays.flat()];
    const { events } = await stopUntilCall(port, phone);

    expect(phone.calls).toHaveLength(1);
    expect(phone.calls[0].turns.map((x) => x.role)).toEqual(["agent", "driver", "agent", "driver", "agent"]);
    expect(port.asked).toHaveLength(2);
    expect(port.asked[1].turns).toHaveLength(4);
    expect(port.asked[0].reason).toMatch(/unplanned stop/);
    expect(port.asked[0].brief.context?.notes).toBe("gate closes 22:00");

    const call = events.events.find((e) => e.kind === "call")!;
    expect((call.evidence.turns as unknown[]).length).toBe(5);
    expect(call.evidence.summary).toMatch(/Held at the shipper/);
    const reply = events.events.find((e) => e.kind === "reply")!;
    expect(reply.evidence.situationKey).toBe("customer");
    expect(reply.evidence.confidence).toBe(0.92);
  });

  it("a port that throws mid-call ends the call politely; the transcript is still classified the old way", async () => {
    const port: ConversationPort = { converse: async () => { throw new Error("model down"); } };
    const phone = new MemoryPhone();
    phone.driverSays = [["truck broke down on the shoulder"]];
    const { events } = await stopUntilCall(port, phone);
    const call = events.events.find((e) => e.kind === "call")!;
    expect(call.evidence.conversationError).toBe("model down");
    expect(phone.calls[0].turns.at(-1)?.text).toMatch(/let dispatch know/);
    expect(events.events.find((e) => e.kind === "reply")?.evidence.situationKey).toBe("breakdown");
  });

  it("a low-confidence hearing is asked to repeat, not sent to the port", async () => {
    const port = new ScriptedConversation([{ say: "Thanks.", done: true, situationKey: "traffic", confidence: 0.9, summary: "traffic" }]);
    const phone = new MemoryPhone();
    phone.driverSays = [["mumble"]];
    // MemoryPhone reports 0.95; drive the callback directly for the low case.
    const clock = new FakeClock(T0), events = new MemoryEvents();
    const agent = new Agent({ clock, router: new StraightRouter(60), sheet: new MemorySheet(), messenger: new MemoryMessenger(), phone, mailer: new MemoryMailer(), classifier: new KeywordClassifier(), conversation: port, events, restStops: [], landmarks: [], dispatcherEmail: "boss@x", tz: "America/Chicago", dispatcherPhone: null, policy: POLICY }, brief);
    const convo = (agent as unknown as { conversationFor: (r: string, s: string) => { options: { converse: (a: string, b: number | null) => Promise<{ say: string; done: boolean }> } } }).conversationFor("test", "Hi");
    const step = await convo.options.converse("mumble", 0.3);
    expect(step.done).toBe(false);
    expect(step.say).toMatch(/say it again/);
    expect(port.asked).toHaveLength(0);
  });

  it("without a conversation port, the call is the one-question call it always was", async () => {
    const phone = new MemoryPhone();
    phone.outcomes = [{ answered: true, transcript: "truck broke down", confidence: 0.9 }];
    const { events } = await stopUntilCall(null, phone);
    const call = events.events.find((e) => e.kind === "call")!;
    expect(call.evidence.turns).toBeUndefined();
    expect(events.events.find((e) => e.kind === "reply")?.evidence.situationKey).toBe("breakdown");
  });
});

describe("TwilioPhone conversation loop", () => {
  const client = () => ({ calls: { create: vi.fn<VoiceClient["calls"]["create"]>(async () => ({ sid: "CA1" })) } });

  it("keeps gathering while converse says so, hangs up when it says done, and reports every utterance as the transcript", async () => {
    const c = client();
    const pendingCalls = new PendingCalls("https://x.example");
    const phone = new TwilioPhone(c, "+15550001", "https://x.example", pendingCalls);
    const lines = ["Is the shipper loading you yet?", "Thanks, I'll let dispatch know."];
    let n = 0;
    const outcome = phone.call("+15550002", "You've been stopped a while. Everything OK?", { converse: async () => ({ say: lines[n++], done: n === 2 }) });
    const id = c.calls.create.mock.calls[0][0].url.match(/\/twilio\/voice\/([^/]+)\/answer$/)![1];

    const first = await pendingCalls.gather(id, "still at the shipper", "0.9");
    expect(first).toContain("Is the shipper loading you yet?");
    expect(first).toContain('<Gather input="speech"');
    expect(first).toContain("/twilio/voice/" + id + "/gather");

    const second = await pendingCalls.gather(id, "no door yet, forty minutes", "0.85");
    expect(second).toContain("let dispatch know");
    expect(second).toContain("<Hangup/>");
    expect(second).not.toContain("<Gather");
    await expect(outcome).resolves.toEqual({ answered: true, transcript: "still at the shipper / no door yet, forty minutes", confidence: 0.85 });
  });

  it("signs off on its own at the turn cap even if converse never says done", async () => {
    const c = client();
    const pendingCalls = new PendingCalls("https://x.example");
    const phone = new TwilioPhone(c, "+15550001", "https://x.example", pendingCalls);
    const outcome = phone.call("+15550002", "Hi", { converse: async () => ({ say: "And?", done: false }) });
    const id = c.calls.create.mock.calls[0][0].url.match(/\/twilio\/voice\/([^/]+)\/answer$/)![1];
    let twiml = "";
    for (let i = 0; i < MAX_CONVERSATION_TURNS; i++) twiml = await pendingCalls.gather(id, "words " + i, "0.9");
    expect(twiml).toContain("<Hangup/>");
    await expect(outcome).resolves.toMatchObject({ answered: true, transcript: "words 0 / words 1 / words 2 / words 3" });
  });

  it("a gather for a call that already settled just hangs up", async () => {
    const pendingCalls = new PendingCalls("https://x.example");
    expect(await pendingCalls.gather("c_nobody", "hello", "0.9")).toContain("<Hangup/>");
  });
});

describe("ClaudeConversation", () => {
  const step = (input: Record<string, unknown>) => ({ content: [{ type: "tool_use", id: "tu1", name: "next_step", input }] });
  const fakeClient = (reply: Record<string, unknown>) => {
    const create = vi.fn(async (_req: unknown) => step(reply));
    return { client: { messages: { create } } as unknown as ConstructorParameters<typeof ClaudeConversation>[0], create };
  };

  it("sends the run facts and the situation library as system, the exchange as messages, and forces the next_step tool", async () => {
    const { client, create } = fakeClient({ say: "How long have they said?", done: false, situationKey: null, confidence: 0, summary: null });
    const port = new ClaudeConversation(client, "America/Chicago");
    const out = await port.converse({ brief, reason: "unplanned stop — 25 min stationary", turns: [{ role: "agent", text: "Everything OK?" }, { role: "driver", text: "at the shipper" }] });
    expect(out).toEqual({ say: "How long have they said?", done: false, situationKey: null, confidence: 0, summary: null });
    const req = create.mock.calls[0][0] as unknown as { system: string; messages: Array<{ role: string; content: string }>; tool_choice: { name: string } };
    expect(req.system).toContain("Frozen peas");
    expect(req.system).toContain("gate closes 22:00");
    expect(req.system).toContain("- breakdown:");
    expect(req.system).toContain('You opened the call with: "Everything OK?"');
    expect(req.messages).toEqual([{ role: "user", content: "at the shipper" }]);
    expect(req.tool_choice.name).toBe("next_step");
  });

  it("a verdict below the confidence floor comes back as null, and a summary only when done", async () => {
    const { client } = fakeClient({ say: "Thanks.", done: true, situationKey: "customer", confidence: 0.3, summary: "maybe the shipper" });
    const out = await new ClaudeConversation(client, "America/Chicago").converse({ brief, reason: "r", turns: [{ role: "driver", text: "eh" }] });
    expect(out.situationKey).toBeNull();
    expect(out.summary).toBe("maybe the shipper");
  });

  it("classify() reads a typed reply through the same tool, and a model failure is 'not understood', never a throw", async () => {
    const { client } = fakeClient({ say: "Got it.", done: true, situationKey: "traffic", confidence: 0.88, summary: "traffic" });
    expect(await new ClaudeConversation(client, "America/Chicago").classify("stuck on 35, wreck ahead")).toEqual({ key: "traffic", confidence: 0.88 });
    const broken = { messages: { create: async () => { throw new Error("529"); } } } as unknown as ConstructorParameters<typeof ClaudeConversation>[0];
    expect(await new ClaudeConversation(broken, "America/Chicago").classify("anything")).toEqual({ key: null, confidence: 0 });
  });

  it("the system prompt forbids action and names every library key", () => {
    const p = systemPrompt(brief, "test", "America/Chicago");
    expect(p).toMatch(/Do not promise anything/);
    for (const k of ["breakdown", "accident", "inspection", "customer", "traffic", "rest", "fuel", "all_good"]) expect(p).toContain("- " + k + ":");
  });
});
