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
  it("done lines cover calls, emails and respond actions, newest first", () => {
    const s = deriveAgentSummary(base({ events: [
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
});
