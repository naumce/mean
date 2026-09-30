// Night Shift's persisted facts → one plain-language summary. Shared by the
// per-load timeline (GET /loads/:id/agent) and the AI Agents overview so the
// drawer and the overview can never disagree. The worker's in-memory ladder
// timers and open-question key are NOT persisted, so anything about "when"
// is marked inferred/unknown rather than invented.
export type AgentActivity = "off" | "watching" | "waiting_reply" | "escalated" | "held" | "attention" | "delivered";
export type AgentMode = "off" | "shadow" | "live";
export interface AgentSummaryEvent { atMs: number; kind: string; evidence: unknown; actionTaken: string | null }
export interface AgentSummaryInput {
  enabled: boolean; pill: string; policyShadow: boolean | null; attentionLine: string | null;
  events: AgentSummaryEvent[]; nowMs: number;
}
export interface AgentSummary {
  mode: AgentMode; activity: AgentActivity; noticed: string | null; recommends: string | null;
  done: string[]; next: string; nextConfidence: "known" | "inferred" | "unknown"; lastEventAt: number | null;
}

const SILENCE_MS = 3 * 60_000;
const QUESTION_KINDS = new Set(["message", "message_again", "sms"]);
const DONE_ACTION_KINDS = new Set(["message", "message_again", "sms", "respond"]);
const ANOMALY_WORDS: Record<string, string> = {
  unplanned_stop: "Unplanned stop", delay: "Running late", gone_dark: "No GPS for a while", off_route: "Off the planned route",
};

const rec = (e: unknown): Record<string, unknown> => (e && typeof e === "object" ? (e as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

export function deriveAgentSummary(input: AgentSummaryInput): AgentSummary {
  const events = [...input.events].sort((a, b) => b.atMs - a.atMs); // newest first; ties keep the caller's input order (stable sort)
  const lastEventAt = events.length ? events[0].atMs : null;
  const done = doneLines(events);
  const noticed = noticedLine(events);
  const off = !input.enabled || input.pill === "off";
  const mode: AgentMode = off ? "off" : input.policyShadow === false ? "live" : "shadow";
  const policyPrefix = !off && input.policyShadow === null ? "Policy unknown — " : "";

  if (off) return { mode, activity: "off", noticed, recommends: null, done, next: "Night Shift is switched off for this load.", nextConfidence: "known", lastEventAt };

  const newestAction = (kinds: Set<string>) => events.find((e) => e.kind === "action" && kinds.has(String(rec(e.evidence).kind)));
  if (input.pill === "delivered" || newestAction(new Set(["arrived"]))) {
    return { mode, activity: "delivered", noticed, recommends: null, done, next: policyPrefix + "Delivered. Night Shift recorded the arrival; nothing more will be sent.", nextConfidence: "known", lastEventAt };
  }
  const supervision = newestAction(new Set(["takeover", "handback"]));
  if (input.pill === "held" || (supervision && rec(supervision.evidence).kind === "takeover")) {
    return { mode, activity: "held", noticed, recommends: null, done, next: policyPrefix + "You have taken over. Night Shift keeps recording but sends nothing until you hand back.", nextConfidence: "known", lastEventAt };
  }
  const escalation = events.find((e) => e.kind === "escalation");
  if (escalation && !events.some((e) => e.atMs >= escalation.atMs && (e.kind === "reply" || (e.kind === "anomaly" && rec(e.evidence).resolved === true)))) {
    const ev = rec(escalation.evidence);
    const recommends = (str(ev.reason) ?? "Escalated to dispatch.") + (ev.draftAttached === true ? " A customer note is drafted." : "");
    return { mode, activity: "escalated", noticed, recommends, done, next: policyPrefix + "Escalated to dispatch. It is your decision now; Night Shift will not re-ask the driver about this.", nextConfidence: "known", lastEventAt };
  }
  const question = events.find((e) => (e.kind === "action" && QUESTION_KINDS.has(String(rec(e.evidence).kind))) || e.kind === "call");
  if (question && !events.some((e) => e.kind === "reply" && e.atMs >= question.atMs)) {
    return { mode, activity: "waiting_reply", noticed, recommends: null, done, next: policyPrefix + "Waiting for the driver's reply. Night Shift re-asks after its cooldown; the exact time is not recorded here.", nextConfidence: "inferred", lastEventAt };
  }
  if (input.pill === "attention") {
    return { mode, activity: "attention", noticed, recommends: null, done, next: policyPrefix + (input.attentionLine ?? "Night Shift could not start or continue; see the timeline."), nextConfidence: input.attentionLine ? "known" : "inferred", lastEventAt };
  }
  if (lastEventAt === null || input.nowMs - lastEventAt > SILENCE_MS) {
    const minutes = lastEventAt === null ? null : Math.round((input.nowMs - lastEventAt) / 60_000);
    const gap = minutes === null ? "since it was switched on" : `in the last ${minutes} minutes`;
    return { mode, activity: "watching", noticed, recommends: null, done, next: policyPrefix + `Watching. No report from Night Shift ${gap} — it checks once a minute, so it may be down.`, nextConfidence: "unknown", lastEventAt };
  }
  return { mode, activity: "watching", noticed, recommends: null, done, next: policyPrefix + "Watching. Next check within a minute.", nextConfidence: "known", lastEventAt };
}

function noticedLine(events: AgentSummaryEvent[]): string | null {
  // A key (e.g. "delay") can be static and recur, so a resolution only closes the
  // occurrence(s) at or before its own atMs — a later, real recurrence of the same
  // key must still be noticed. Check per-candidate rather than with one global set.
  const closesKey = (key: string, atMs: number) =>
    events.some((r) => r.kind === "anomaly" && rec(r.evidence).resolved === true && String(rec(r.evidence).key) === key && r.atMs >= atMs);
  const open = events.find((e) => e.kind === "anomaly" && rec(e.evidence).resolved !== true && !closesKey(String(rec(e.evidence).key), e.atMs));
  if (!open) return null;
  const kind = String(rec(open.evidence).kind ?? "");
  return open.actionTaken ?? ANOMALY_WORDS[kind] ?? kind;
}

function doneLines(events: AgentSummaryEvent[]): string[] {
  const lines: string[] = [];
  for (const e of events) {
    const ev = rec(e.evidence);
    if (e.kind === "would_say") lines.push(`Would have sent ${String(ev.channel ?? "message")}: ${String(ev.text ?? "")}`);
    else if (e.kind === "action" && DONE_ACTION_KINDS.has(String(ev.kind))) lines.push(`Sent ${String(ev.channel ?? "message")}: ${String(ev.text ?? "")}`);
    else if (e.kind === "call") lines.push(ev.answered === true ? "Called the driver (answered)" : "Called the driver");
    else if (e.kind === "email") lines.push(`Emailed ${String(ev.to ?? "")}: ${String(ev.subject ?? ev.kind ?? "")}`);
    if (lines.length === 5) break;
  }
  return lines;
}
