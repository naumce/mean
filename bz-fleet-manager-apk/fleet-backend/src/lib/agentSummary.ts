// Night Shift's persisted facts → one plain-language summary. Shared by the
// per-load timeline (GET /loads/:id/agent) and the AI Agents overview so the
// drawer and the overview can never disagree. The worker's in-memory ladder
// timers and open-question key are NOT persisted, so anything about "when"
// is marked inferred/unknown rather than invented.
// Activity precedence (first match wins): off → delivered → held →
// attention (pill === "attention") → escalated → waiting_reply → invited →
// watching. The pill is the worker's CURRENT verdict; "attention" means it
// could not start or continue running the load at all right now, which
// outranks what it did earlier (e.g. an old escalation from before the load
// went stale).
//
// "invited" is the state between the worker inviting a driver (action
// { kind: "invite" }) and the first evidence it accepted — a later
// `accepted` action, or `departed` (which alone covers the first ping: the
// worker never records a separate "accepted via ping" event). An invite
// that is superseded this way is no different from any other closed
// question, so it reads as "watching" like the rest of them. An escalation,
// anomaly or open question from BEFORE the invite is the previous run's
// history, not news about this one — it must not reach past a fresh invite
// to outrank "invited", so escalated/waiting_reply are only considered
// using events at or after the invite's own timestamp while an
// (un-superseded) invite is the newest thing on record.
export type AgentActivity = "off" | "watching" | "waiting_reply" | "escalated" | "held" | "attention" | "delivered" | "invited";
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
// Mirrors night-shift/src/core/constants.ts's ACCEPT_GRACE_MIN (~line 52:
// "No accept by departure + this is the first escalation", value 30) — the
// deadline night-shift/src/core/agent.ts's evaluateNow (~lines 356-358)
// escalates at when a load is still unaccepted at departure + this many
// minutes. fleet-backend does not import the worker package, so the value
// is named here and cited in the `next` sentence; a change to the worker's
// constant must be mirrored here by hand.
const ACCEPT_GRACE_MIN = 30;
const QUESTION_KINDS = new Set(["message", "message_again", "sms"]);
const DONE_ACTION_KINDS = new Set(["message", "message_again", "sms", "respond"]);
const ANOMALY_WORDS: Record<string, string> = {
  unplanned_stop: "Unplanned stop", delay: "Running late", gone_dark: "No GPS for a while", off_route: "Off the planned route",
};

const rec = (e: unknown): Record<string, unknown> => (e && typeof e === "object" ? (e as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const isFailed = (e: AgentSummaryEvent): boolean => rec(e.evidence).failed === true;

// A "done" line reports one record; a shadow email's `would_say` text can be
// a whole multi-paragraph escalation draft (night-shift/src/core/agent.ts's
// `would_say` for an email channel carries the full body). Clamped here,
// once, for every line this module ever produces — not just email — so no
// single record can dominate the drawer or the overview row.
const MAX_DONE_LINE = 140;
const clampLine = (line: string): string => (line.length > MAX_DONE_LINE ? line.slice(0, MAX_DONE_LINE) + "…" : line);

export function deriveAgentSummary(input: AgentSummaryInput): AgentSummary {
  const events = [...input.events].sort((a, b) => b.atMs - a.atMs); // newest first; ties keep the caller's input order (stable sort)
  const lastEventAt = events.length ? events[0].atMs : null;
  const off = !input.enabled || input.pill === "off";
  const mode: AgentMode = off ? "off" : input.policyShadow === false ? "live" : "shadow";
  const policyPrefix = !off && input.policyShadow === null ? "Policy unknown — " : "";
  // Shadow (or an unresolved policy) means every send was a would_say row, even after the load was
  // switched off — key the "done" wording on the policy, not on the off/shadow/live mode.
  const done = doneLines(events, input.policyShadow === false ? "live" : "shadow");
  const noticed = noticedLine(events);

  if (off) return { mode, activity: "off", noticed, recommends: null, done, next: "Night Shift is switched off for this load.", nextConfidence: "known", lastEventAt };

  const newestAction = (kinds: Set<string>) => events.find((e) => e.kind === "action" && kinds.has(String(rec(e.evidence).kind)));
  if (input.pill === "delivered" || newestAction(new Set(["arrived"]))) {
    return { mode, activity: "delivered", noticed, recommends: null, done, next: policyPrefix + "Delivered. Night Shift recorded the arrival; nothing more will be sent.", nextConfidence: "known", lastEventAt };
  }
  const supervision = newestAction(new Set(["takeover", "handback"]));
  if (input.pill === "held" || (supervision && rec(supervision.evidence).kind === "takeover")) {
    return { mode, activity: "held", noticed, recommends: null, done, next: policyPrefix + "You have taken over. Night Shift keeps recording but sends nothing until you hand back.", nextConfidence: "known", lastEventAt };
  }
  // An un-superseded invite: the newest non-failed `action`/{kind:"invite"}
  // with no later `accepted` or `departed` action. `departed` alone covers
  // acceptance-via-first-ping — the worker never writes a separate event for
  // that (core/agent.ts's evaluateNow only ever checks `s.status === "invited"`).
  const newestInvite = events.find((e) => e.kind === "action" && String(rec(e.evidence).kind) === "invite" && !isFailed(e));
  const inviteSuperseded = Boolean(
    newestInvite && events.some((e) => e.kind === "action" && ["accepted", "departed"].includes(String(rec(e.evidence).kind)) && e.atMs >= newestInvite.atMs),
  );
  const invited = Boolean(newestInvite) && !inviteSuperseded;
  // While an un-superseded invite is on record, only events at or after its
  // own timestamp can still mark an escalation or question "active" — an
  // older one is the previous run's history (see the AgentActivity comment
  // above), and must not outrank the fresh invite.
  const relevant = (e: AgentSummaryEvent) => !invited || e.atMs >= newestInvite!.atMs;

  const escalation = events.find((e) => e.kind === "escalation" && relevant(e));
  const escalationActive = Boolean(escalation && !events.some((e) => relevant(e) && e.atMs >= escalation.atMs && (e.kind === "reply" || (e.kind === "anomaly" && rec(e.evidence).resolved === true))));
  const recommends = escalationActive && escalation
    ? (str(rec(escalation.evidence).reason) ?? "Escalated to dispatch.") + (rec(escalation.evidence).draftAttached === true ? " A customer note is drafted." : "")
    : null;
  if (input.pill === "attention") {
    return { mode, activity: "attention", noticed, recommends, done, next: policyPrefix + (input.attentionLine ?? "Night Shift could not start or continue; see the timeline."), nextConfidence: input.attentionLine ? "known" : "inferred", lastEventAt };
  }
  if (escalationActive) {
    return { mode, activity: "escalated", noticed, recommends, done, next: policyPrefix + "Escalated to dispatch. It is your decision now; Night Shift will not re-ask the driver about this.", nextConfidence: "known", lastEventAt };
  }
  // A failed send/call never opens a question — Night Shift's own core
  // refuses to climb the ladder on a delivery that threw (agent.ts's
  // noteDeliveryFailure comment), and the summary must not do what the core
  // refused to: a message the driver was never sent cannot be "waiting for
  // a reply".
  const question = events.find((e) => relevant(e) && !isFailed(e) && ((e.kind === "action" && QUESTION_KINDS.has(String(rec(e.evidence).kind))) || e.kind === "call"));
  if (question && !events.some((e) => relevant(e) && e.kind === "reply" && e.atMs >= question.atMs)) {
    return { mode, activity: "waiting_reply", noticed, recommends: null, done, next: policyPrefix + "Waiting for the driver's reply. Night Shift re-asks after its cooldown; the exact time is not recorded here.", nextConfidence: "inferred", lastEventAt };
  }
  if (invited) {
    return {
      mode, activity: "invited", noticed, recommends: null, done,
      next: policyPrefix + `Invited — waiting for the driver to accept the tracking link. If nothing arrives within ${ACCEPT_GRACE_MIN} minutes of departure, Night Shift escalates on its own.`,
      nextConfidence: "known", lastEventAt,
    };
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

// In shadow mode, `would_say` rows already cover every channel (chat, sms, email) for
// what Night Shift *would* have sent, and the paired `action`/`email` rows that record
// the same drafts are not real sends — showing both would duplicate the line and claim
// a send that never happened. Live mode has no `would_say` rows, so it reads the real
// send records instead.
function doneLines(events: AgentSummaryEvent[], mode: AgentMode): string[] {
  const lines: string[] = [];
  const push = (line: string) => lines.push(clampLine(line));
  for (const e of events) {
    const ev = rec(e.evidence);
    const failed = ev.failed === true;
    if (mode === "shadow") {
      if (e.kind === "would_say") push(`Would have sent ${String(ev.channel ?? "message")}: ${String(ev.text ?? "")}`);
    } else {
      // A failed record is never "Sent"/"Called"/"Emailed" — Night Shift's
      // own core writes `failed: true` precisely so this layer can tell a
      // real send from an attempt that threw; reporting the latter as a
      // success would be the exact dishonesty rule 6 above also guards
      // against for the open-question read of the same records.
      if (e.kind === "action" && DONE_ACTION_KINDS.has(String(ev.kind))) {
        const text = String(ev.text ?? e.actionTaken ?? "");
        push(failed ? `Could not send ${String(ev.channel ?? "message")}: ${text}` : `Sent ${String(ev.channel ?? "message")}: ${text}`);
      } else if (e.kind === "call") {
        push(failed ? "Could not reach the driver by phone" : ev.answered === true ? "Called the driver (answered)" : "Called the driver");
      } else if (e.kind === "email") {
        // Prefer the human `actionTaken` over the raw evidence when there is
        // no subject — most `record("email", …)` call sites never set one,
        // and the fallback used to be the internal `kind` enum
        // ("customer_arrival") rather than plain language.
        const label = String(ev.subject ?? e.actionTaken ?? "");
        push(failed ? `Could not email ${String(ev.to ?? "")}: ${label}` : `Emailed ${String(ev.to ?? "")}: ${label}`);
      }
    }
    if (lines.length === 5) break;
  }
  return lines;
}
