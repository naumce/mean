import { describe, expect, it } from "vitest";
import { deriveAgentSummary, type AgentSummaryInput } from "../src/lib/agentSummary.js";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const base = (over: Partial<AgentSummaryInput> = {}): AgentSummaryInput => ({
  enabled: true, pill: "watching", policyShadow: true, attentionLine: null, events: [], nowMs: NOW, ...over,
});
const ev = (atMs: number, kind: string, evidence: unknown, actionTaken: string | null = null) => ({ atMs, kind, evidence, actionTaken });

describe("deriveAgentSummary", () => {
  it("switched off", () => {
    const s = deriveAgentSummary(base({ enabled: false, pill: "off" }));
    expect(s).toMatchObject({ mode: "off", activity: "off", nextConfidence: "known" });
    expect(s.next).toBe("Night Shift is switched off for this load.");
  });
  it("mode follows the policy, activity does not", () => {
    expect(deriveAgentSummary(base({ policyShadow: false })).mode).toBe("live");
    expect(deriveAgentSummary(base({ policyShadow: true })).mode).toBe("shadow");
    const unknown = deriveAgentSummary(base({ policyShadow: null }));
    expect(unknown.next.startsWith("Policy unknown — ")).toBe(true);
  });
  it("delivered wins over everything", () => {
    const s = deriveAgentSummary(base({ pill: "delivered", events: [ev(NOW - 60_000, "escalation", { reason: "x", draftAttached: false })] }));
    expect(s.activity).toBe("delivered");
    expect(s.nextConfidence).toBe("known");
  });
  it("taken over", () => {
    const s = deriveAgentSummary(base({ pill: "held", events: [ev(NOW - 30_000, "action", { kind: "takeover" }, "taken over")] }));
    expect(s.activity).toBe("held");
    expect(s.next).toContain("hand back");
  });
  it("escalated with a drafted customer note", () => {
    const s = deriveAgentSummary(base({ pill: "escalated", events: [
      ev(NOW - 300_000, "action", { kind: "message", channel: "chat", text: "Is everything OK?" }, "message"),
      ev(NOW - 120_000, "reply", { rawText: "Engine warning", situationKey: "breakdown" }),
      ev(NOW - 119_000, "escalation", { reason: "driver reports: Driver reports a breakdown.", draftAttached: true, deadlineAtRisk: true }),
    ] }));
    expect(s.activity).toBe("escalated");
    expect(s.recommends).toBe("driver reports: Driver reports a breakdown. A customer note is drafted.");
    expect(s.nextConfidence).toBe("known");
  });
  it("waiting for a reply is inferred, never timed", () => {
    const s = deriveAgentSummary(base({ pill: "asked", events: [
      ev(NOW - 90_000, "anomaly", { kind: "unplanned_stop", key: "unplanned_stop@1" }, "unplanned stop"),
      ev(NOW - 60_000, "action", { kind: "message", channel: "chat", text: "You've been stopped 2 min. Everything OK?" }, "message"),
    ] }));
    expect(s.activity).toBe("waiting_reply");
    expect(s.nextConfidence).toBe("inferred");
    expect(s.next).not.toMatch(/\d+ ?min/);
    expect(s.noticed).toBe("unplanned stop");
  });
  it("a reply closes the question; a resolved anomaly clears what it noticed", () => {
    const s = deriveAgentSummary(base({ events: [
      ev(NOW - 90_000, "anomaly", { kind: "delay", key: "delay" }),
      ev(NOW - 80_000, "action", { kind: "message", channel: "chat", text: "Late?" }, "message"),
      ev(NOW - 70_000, "reply", { rawText: "traffic", situationKey: "traffic" }),
      ev(NOW - 10_000, "anomaly", { key: "delay", resolved: true }, "resolved on its own"),
      ev(NOW - 5_000, "ping", {}),
    ] }));
    expect(s.activity).toBe("watching");
    expect(s.noticed).toBeNull();
    expect(s.next).toBe("Watching. Next check within a minute.");
  });
  it("attention uses the board line when there is one", () => {
    const s = deriveAgentSummary(base({ pill: "attention", attentionLine: "ATTENTION — no driver or carrier phone on file" }));
    expect(s.activity).toBe("attention");
    expect(s.next).toBe("ATTENTION — no driver or carrier phone on file");
    expect(s.nextConfidence).toBe("known");
  });
  it("silence is reported as uncertainty, not as watching", () => {
    const s = deriveAgentSummary(base({ events: [ev(NOW - 10 * 60_000, "ping", {})] }));
    expect(s.nextConfidence).toBe("unknown");
    expect(s.next).toContain("10 minutes");
  });
  it("done lists sends and would-have-sent lines, newest first, max five", () => {
    const events = Array.from({ length: 7 }, (_, i) => ev(NOW - (7 - i) * 1000, "would_say", { channel: "chat", to: "+1", text: `msg ${i}` }));
    const s = deriveAgentSummary(base({ events }));
    expect(s.done).toHaveLength(5);
    expect(s.done[0]).toBe("Would have sent chat: msg 6");
  });

  // --- Fix round 1 ---

  it("a static anomaly key that recurs after resolution is noticed again", () => {
    const s = deriveAgentSummary(base({ events: [
      ev(NOW - 10 * 60_000, "anomaly", { key: "delay", resolved: true }),
      ev(NOW - 60_000, "anomaly", { kind: "delay", key: "delay" }),
    ] }));
    expect(s.noticed).toBe("Running late");
  });
  it("the inverse order (open then resolved) still closes it", () => {
    const s = deriveAgentSummary(base({ events: [
      ev(NOW - 10 * 60_000, "anomaly", { kind: "delay", key: "delay" }),
      ev(NOW - 60_000, "anomaly", { key: "delay", resolved: true }),
    ] }));
    expect(s.noticed).toBeNull();
  });

  it("a reply at the same millisecond as the question closes it", () => {
    const s = deriveAgentSummary(base({ events: [
      ev(NOW - 60_000, "action", { kind: "message", channel: "chat", text: "You OK?" }, "message"),
      ev(NOW - 60_000, "reply", { rawText: "yes", situationKey: "ok" }),
    ] }));
    expect(s.activity).toBe("watching");
    expect(s.next).toBe("Watching. Next check within a minute.");
  });
  it("a reply at the same millisecond as the escalation closes it", () => {
    const s = deriveAgentSummary(base({ events: [
      ev(NOW - 119_000, "escalation", { reason: "x", draftAttached: false }),
      ev(NOW - 119_000, "reply", { rawText: "traffic", situationKey: "traffic" }),
    ] }));
    expect(s.activity).not.toBe("escalated");
  });
  it("a resolved anomaly at the same millisecond as the escalation closes it", () => {
    const s = deriveAgentSummary(base({ events: [
      ev(NOW - 119_000, "escalation", { reason: "x", draftAttached: false }),
      ev(NOW - 119_000, "anomaly", { key: "other", resolved: true }),
    ] }));
    expect(s.activity).not.toBe("escalated");
  });

  it("a call with no reply counts as the outbound question", () => {
    const s = deriveAgentSummary(base({ pill: "asked", events: [ev(NOW - 60_000, "call", {})] }));
    expect(s.activity).toBe("waiting_reply");
    expect(s.nextConfidence).toBe("inferred");
  });
  it("live done lines cover calls, emails and respond actions, newest first", () => {
    const s = deriveAgentSummary(base({ policyShadow: false, events: [
      ev(NOW - 30_000, "action", { kind: "respond", channel: "chat", text: "Sure, got it" }, "respond"),
      ev(NOW - 20_000, "call", { answered: true }),
      ev(NOW - 10_000, "email", { to: "dispatch@acme.com", subject: "Delay update" }),
    ] }));
    expect(s.done).toEqual([
      "Emailed dispatch@acme.com: Delay update",
      "Called the driver (answered)",
      "Sent chat: Sure, got it",
    ]);
  });
  it("attention with no board line is inferred", () => {
    const s = deriveAgentSummary(base({ pill: "attention", attentionLine: null }));
    expect(s.activity).toBe("attention");
    expect(s.nextConfidence).toBe("inferred");
    expect(s.next).toBe("Night Shift could not start or continue; see the timeline.");
  });
  it("delivered is reached via an arrived action even when the pill lags behind", () => {
    const s = deriveAgentSummary(base({ pill: "watching", events: [ev(NOW - 30_000, "action", { kind: "arrived" }, "arrived")] }));
    expect(s.activity).toBe("delivered");
  });
  it("held is reached via a takeover action even when the pill lags behind", () => {
    const s = deriveAgentSummary(base({ pill: "watching", events: [ev(NOW - 30_000, "action", { kind: "takeover" }, "taken over")] }));
    expect(s.activity).toBe("held");
  });
  it("a later reply clears an escalation", () => {
    const s = deriveAgentSummary(base({ pill: "watching", events: [
      ev(NOW - 119_000, "escalation", { reason: "x", draftAttached: false }),
      ev(NOW - 100_000, "reply", { rawText: "handled", situationKey: "ok" }),
    ] }));
    expect(s.activity).not.toBe("escalated");
    expect(s.activity).toBe("watching");
  });
  it("a later resolved anomaly clears an escalation", () => {
    const s = deriveAgentSummary(base({ pill: "watching", events: [
      ev(NOW - 119_000, "escalation", { reason: "x", draftAttached: false }),
      ev(NOW - 100_000, "anomaly", { key: "other", resolved: true }),
    ] }));
    expect(s.activity).not.toBe("escalated");
    expect(s.activity).toBe("watching");
  });

  // --- Fix round 2 ---

  it("the pill's current attention outranks an older unresolved escalation, but the escalation fact is still reported", () => {
    const s = deriveAgentSummary(base({ pill: "attention", attentionLine: "ATTENTION — no driver or carrier phone on file", events: [
      ev(NOW - 10 * 60_000, "escalation", { reason: "driver reports: Driver reports a breakdown.", draftAttached: false }),
    ] }));
    expect(s.activity).toBe("attention");
    expect(s.next).toBe("ATTENTION — no driver or carrier phone on file");
    expect(s.recommends).toBe("driver reports: Driver reports a breakdown.");
  });

  // --- Fix round 3 ---

  // --- Final-review fix round: B1/B2/B3 ---

  it("a failed outbound message is not an open question, and done says it could not send", () => {
    const s = deriveAgentSummary(base({ policyShadow: false, pill: "asked", events: [
      ev(NOW - 60_000, "action", { anomalyKey: "delay", rung: 1, kind: "message", channel: "chat", failed: true, error: "gateway timeout" }, "delivery failed — will retry after cooldown"),
    ] }));
    expect(s.activity).not.toBe("waiting_reply");
    expect(s.done).toEqual(["Could not send chat: delivery failed — will retry after cooldown"]);
  });

  it("a failed manual call is not an open question, and done says the driver could not be reached", () => {
    const s = deriveAgentSummary(base({ policyShadow: false, events: [
      ev(NOW - 60_000, "call", { manual: true, failed: true, error: "no answer path" }, "manual call failed"),
    ] }));
    expect(s.activity).not.toBe("waiting_reply");
    expect(s.done).toEqual(["Could not reach the driver by phone"]);
  });

  it("a failed email is reported as not sent, using actionTaken for the label", () => {
    const s = deriveAgentSummary(base({ policyShadow: false, events: [
      ev(NOW - 60_000, "email", { to: "ops@acme.com", failed: true, error: "smtp down" }, "escalation email failed to send"),
    ] }));
    expect(s.done).toEqual(["Could not email ops@acme.com: escalation email failed to send"]);
    expect(s.done.some((line) => line.startsWith("Emailed"))).toBe(false);
  });

  it("email done line uses actionTaken, not the raw evidence kind, when there is no subject", () => {
    const s = deriveAgentSummary(base({ policyShadow: false, events: [
      ev(NOW - 10_000, "email", { to: "demo-customer@example.invalid", kind: "customer_arrival", messageId: null }, "customer told of arrival"),
    ] }));
    expect(s.done).toEqual(["Emailed demo-customer@example.invalid: customer told of arrival"]);
  });

  it("a long done line is clamped to 140 characters with a trailing ellipsis", () => {
    const longText = "x".repeat(300);
    const s = deriveAgentSummary(base({ events: [
      ev(NOW - 10_000, "would_say", { channel: "email", to: "ops@acme.com", text: longText }),
    ] }));
    expect(s.done).toHaveLength(1);
    expect(s.done[0]!.length).toBeLessThanOrEqual(141);
    expect(s.done[0]!.endsWith("…")).toBe(true);
  });

  it("shadow done lines come from would_say only, never duplicating the paired action/email records", () => {
    const s = deriveAgentSummary(base({ policyShadow: true, events: [
      ev(NOW - 40_000, "action", { kind: "message", channel: "chat", text: "You've been stopped 2 min. Everything OK?" }, "message"),
      ev(NOW - 40_000, "would_say", { channel: "chat", to: "+1", text: "You've been stopped 2 min. Everything OK?" }),
      ev(NOW - 20_000, "email", { to: "dispatch@acme.com", subject: "Delay update", messageId: null }),
      ev(NOW - 20_000, "would_say", { channel: "email", to: "dispatch@acme.com", text: "Delay update" }),
    ] }));
    expect(s.done).toEqual([
      "Would have sent email: Delay update",
      "Would have sent chat: You've been stopped 2 min. Everything OK?",
    ]);
    expect(s.done.some((line) => line.startsWith("Sent") || line.startsWith("Emailed"))).toBe(false);
  });
});

describe("deriveAgentSummary — done wording after switch-off", () => {
  it("a switched-off load whose policy was shadow still lists would-have-sent lines, never 'Sent'", () => {
    const NOW2 = Date.parse("2026-09-30T12:00:00Z");
    const s = deriveAgentSummary({
      enabled: false, pill: "off", policyShadow: true, attentionLine: null, nowMs: NOW2,
      events: [
        { atMs: NOW2 - 60_000, kind: "action", evidence: { kind: "message", channel: "chat", text: "Everything OK?" }, actionTaken: "message" },
        { atMs: NOW2 - 60_000, kind: "would_say", evidence: { channel: "chat", to: "+1", text: "Everything OK?" }, actionTaken: null },
      ],
    });
    expect(s.mode).toBe("off");
    expect(s.done).toEqual(["Would have sent chat: Everything OK?"]);
  });
});
