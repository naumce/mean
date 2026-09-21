import { beforeAll, describe, expect, it } from "vitest";
import { kcDesMoines } from "../src/replay/kcDesMoines.js";
import { runReplay, type ReplayResult } from "../src/replay/run.js";
import { clockLabel } from "../src/core/phrases.js";

// The whole story, asserted event by event. If this passes, the agent did
// what the spec says on the spec's clock, with nothing invented.
const TZ = "America/Chicago";
let r: ReplayResult;
const at = (kind: string, pred: (ev: Record<string, unknown>) => boolean = () => true) =>
  r.events.filter((e) => e.kind === kind && pred(e.evidence)).map((e) => clockLabel(e.atMs, TZ));

beforeAll(async () => {
  r = await runReplay(kcDesMoines());
});

describe("Kansas City → Des Moines replay", () => {
  it("invites by SMS at 06:10 and the driver accepts", () => {
    expect(r.messenger.sent[0].channel).toBe("sms");
    expect(at("action", (e) => e.kind === "accepted")).toEqual(["06:10"]);
  });

  it("asks about the Bethany stop at 07:27 — 15 minutes in, not sooner", () => {
    const questions = r.messenger.sent.filter((m) => m.channel === "chat" && /Bethany/.test(m.text));
    expect(questions).toHaveLength(1);
    expect(at("action", (e) => e.kind === "message" && /Bethany/.test(String(e.text)))).toEqual(["07:27"]);
  });

  it("records the reply verbatim at 07:31 as rest, answers, and tells nobody", () => {
    const reply = r.events.find((e) => e.kind === "reply");
    expect(clockLabel(reply!.atMs, TZ)).toBe("07:31");
    expect(reply!.evidence.rawText).toBe("had to use the bathroom, rolling now");
    expect(reply!.evidence.situationKey).toBe("rest");
    expect(r.mailer.sent.filter((m) => m.to === "boss@dispatch.example" && /rest/i.test(m.subject))).toHaveLength(0);
  });

  it("treats the mandatory break at Love's Osceola as compliance and sends nothing", () => {
    const compliance = r.events.filter((e) => e.kind === "plan" && e.evidence.breakTakenAtMs);
    expect(compliance).toHaveLength(1);
    expect(clockLabel(compliance[0].evidence.breakTakenAtMs as number, TZ)).toBe("08:00");
    expect(compliance[0].evidence.at).toBe("Love's Osceola");
    const between = r.events.filter((e) => e.kind === "action" && clockLabel(e.atMs, TZ) > "07:32" && clockLabel(e.atMs, TZ) < "08:44" && ["message", "message_again", "sms"].includes(String(e.evidence.kind)));
    expect(between).toHaveLength(0);
  });

  it("runs the delay ladder on the rules' clock: 08:44 · 08:54 · 09:09 · 09:14 · 09:19", () => {
    expect(at("anomaly", (e) => e.kind === "delay")).toEqual(["08:44"]);
    expect(at("action", (e) => e.anomalyKey === "delay" && e.kind === "message")).toEqual(["08:44"]);
    expect(at("action", (e) => e.anomalyKey === "delay" && e.kind === "message_again")).toEqual(["08:54"]);
    expect(at("call")).toEqual(["09:09", "09:14"]);
    expect(r.phone.calls.every((c) => /behind/.test(c.script))).toBe(true);
    expect(at("escalation")).toEqual(["09:19"]);
  });

  it("escalates with the whole ladder, the quote, the silence, and the customer draft attached", () => {
    const esc = r.mailer.sent.find((m) => m.to === "boss@dispatch.example" && /delay/i.test(m.subject));
    expect(esc).toBeDefined();
    expect(esc!.body).toContain("07:27");
    expect(esc!.body).toContain("\"had to use the bathroom, rolling now\"");
    expect(esc!.body).toMatch(/08:44 — chat: .* — no reply/);
    expect(esc!.body).toMatch(/09:09 — called: no answer/);
    expect(esc!.attachments[0].name).toBe("customer-draft.txt");
    expect(esc!.attachments[0].body).toMatch(/ETA 10:3\d/);
    const escEvent = r.events.find((e) => e.kind === "escalation");
    expect(escEvent!.evidence.deadlineAtRisk).toBe(true);
  });

  it("sends the customer email only on the dispatcher's word, at 09:22", () => {
    const toCustomer = r.mailer.sent.filter((m) => m.to === "ops@customer.example");
    expect(toCustomer[0].subject).toBe("Update on load W-19");
    expect(at("email", (e) => e.kind === "customer_delay")).toEqual(["09:22"]);
  });

  it("arrives at 10:36, 21 minutes late — the note is DRAFTED for the dispatcher, not sent", () => {
    expect(r.agent.state.status).toBe("arrived");
    expect(clockLabel(r.agent.state.arrivedAt!, TZ)).toBe("10:36");
    // The customer heard from us exactly once all night: the 09:22 update the
    // dispatcher approved. A late arrival is bad news, and bad news waits.
    expect(r.mailer.sent.filter((m) => m.to === "ops@customer.example")).toHaveLength(1);
    const drafted = r.mailer.sent.find((m) => m.to === "boss@dispatch.example" && /customer note drafted/.test(m.subject));
    expect(drafted!.subject).toBe("[W-19] arrived 21 min late — customer note drafted");
    expect(drafted!.attachments[0].name).toBe("customer-arrival.txt");
    expect(drafted!.attachments[0].body).toMatch(/21 minutes after the 10:15 deadline/);
    expect(r.sheet.cells["W-19"]["Agent Status"]).toBe("Arrived");
    expect(r.sheet.cells["W-19"]["On Time"]).toBe("arrived 21 min late");
  });

  it("said exactly four things to the driver in chat, and never during his break", () => {
    const chats = r.messenger.sent.filter((m) => m.channel === "chat").map((m) => m.text);
    expect(chats).toHaveLength(4); // Bethany question, "Got it, thanks.", delay question, delay again
    expect(chats[1]).toBe("Got it, thanks.");
  });

  it("wrote the sheet on the 15-minute cadence and on every escalation, never a full-sheet overwrite", () => {
    const writes = at("sheet_write");
    expect(writes.length).toBeGreaterThan(15);
    expect(writes).toContain("09:19");
    expect(Object.keys(r.sheet.cells["W-19"]).sort()).toEqual(["Agent Status", "ETA", "Last Position", "Last Update", "On Time"]);
  });
});
