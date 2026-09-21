// Every sentence the agent says or writes, in American English, assembled
// from evidence. No template here may state something its inputs do not
// carry (spec §11): a place is a landmark only if one is within range, a
// reply is quoted, and silence is written as silence.
import { haversineMi } from "../domain.js";
import { LANDMARK_RADIUS_MI, MIN_MS, STALE_FIX_MIN } from "./constants.js";
import { projectOntoRoute } from "./geo.js";
import type { AgentEvent, Anomaly, Brief, DriverReply, GeoPoint, Place, Plan } from "./types.js";

export function clockLabel(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(new Date(ms));
}

/** "Bethany, MO" if a landmark is within LANDMARK_RADIUS_MI, else the mile
 *  along the route — a coordinate is never read out to a human. */
export function placeLabel(at: GeoPoint, landmarks: Place[], plan: Plan, originName: string): string {
  let best: { name: string; mi: number } | null = null;
  for (const l of landmarks) {
    const mi = haversineMi(at, l);
    if (mi <= LANDMARK_RADIUS_MI && (!best || mi < best.mi)) best = { name: l.name, mi };
  }
  if (best) return best.name;
  const { alongMi } = projectOntoRoute(plan.route.geometry, at);
  return Math.round(alongMi) + " mi out of " + originName;
}

export function inviteText(brief: Brief, tz: string): string {
  return (
    "Load " + brief.loadRef + ": " + brief.origin.name + " to " + brief.destination.name +
    ", departing " + clockLabel(brief.departAtMs, tz) + ", deliver by " + clockLabel(brief.deadlineAtMs, tz) +
    ". Tap Accept to share your location for this run."
  );
}

export interface PhraseContext {
  brief: Brief;
  plan: Plan;
  landmarks: Place[];
  tz: string;
}

/** One sentence of situation, one question. */
export function questionFor(a: Anomaly, ctx: PhraseContext): string {
  const ev = a.evidence as Record<string, number | { lat: number; lng: number }>;
  switch (a.kind) {
    case "unplanned_stop": {
      const where = placeLabel(ev.at as GeoPoint, ctx.landmarks, ctx.plan, ctx.brief.origin.name);
      return "You've been stopped " + Math.round(Number(ev.observedMin)) + " min near " + where + ", everything OK?";
    }
    case "delay": {
      // A delay computed from an hour-old fix is a claim about an hour ago.
      // Saying it flat invites "I'm moving, what are you talking about" —
      // and the driver would be right.
      const asOf = (ev.fixAgeMin as number) > STALE_FIX_MIN ? " (as of your " + clockLabel(ev.asOfMs as number, ctx.tz) + " position)" : "";
      return "You're about " + ev.behindMin + " minutes behind for " + ctx.brief.destination.name + ". Is everything OK?" + asOf;
    }
    case "gone_dark":
      return "I haven't seen your location for " + ev.gapMin + " minutes. Everything OK?";
    case "off_route":
      return "You look to be off the planned route. Everything OK?";
  }
}

export function callScriptFor(a: Anomaly, ctx: PhraseContext): string {
  return "Hi, this is the dispatch assistant. " + questionFor(a, ctx);
}

/** What the dispatcher hears when the phone rings at escalation: the load,
 *  the driver, the reason in the email's own words, the last position, and
 *  whether the email actually went. Nothing the record does not say. */
export function escalationCallScript(brief: Brief, reason: string, where: string | null, atMs: number | null, tz: string, emailed: boolean): string {
  const said = reason.replace(/\s*—\s*/g, ": ");
  const position = where && atMs !== null ? " Last position: " + where + " at " + clockLabel(atMs, tz) + "." : " No position on file.";
  const mail = emailed ? " I've emailed you the full timeline." : " The email could not be sent; the details are in the trip log.";
  return "Hi, this is the dispatch assistant with an escalation on load " + brief.loadRef + ", driver " + brief.driverName + ". " +
    said.charAt(0).toUpperCase() + said.slice(1) + "." + position + mail + " Goodbye.";
}

export function escalationSubject(brief: Brief, reason: string): string {
  return "[" + brief.loadRef + "] " + brief.driverName + " — " + reason;
}

/** Set when the last position is too old to write a customer email from.
 *  The dispatcher is told the deadline is at risk AS OF that fix, and why no
 *  draft came with it — never handed a note built on an hour-old position. */
export interface StaleFixNote {
  fixAgeMin: number;
  asOfMs: number;
  deadlineAtRisk: boolean;
}

/** The whole ladder for this load, from the event log, on the dispatcher's
 *  clock. Silence is written as "no reply" / "no answer", never omitted. */
export function escalationBody(
  brief: Brief, reason: string, events: AgentEvent[], reply: DriverReply | null, draftAttached: boolean, tz: string,
  hosKnown: boolean, staleFix: StaleFixNote | null = null,
): string {
  const lines: string[] = [];
  lines.push(brief.loadRef + " · " + brief.origin.name + " → " + brief.destination.name + " · " + brief.driverName);
  lines.push("");
  lines.push("Reason: " + reason);
  lines.push("");
  lines.push("What I did:");
  for (const e of events) {
    const at = clockLabel(e.atMs, tz);
    const ev = e.evidence as Record<string, unknown>;
    if (e.kind === "anomaly" && !ev.resolved) lines.push(at + " — noticed: " + String(ev.kind) + (ev.observedMin != null ? " (" + ev.observedMin + " min)" : "") + (ev.behindMin != null ? " (" + ev.behindMin + " min behind)" : ""));
    if (e.kind === "action" && (ev.kind === "message" || ev.kind === "message_again" || ev.kind === "sms")) {
      // "No reply" is a claim about silence, made only when nothing answered
      // this question. A reply is matched by the key it answered, not by
      // time alone, so a later answer to a different question does not
      // count. When it was answered, the line says when.
      const isAskWithSameKey = (m: AgentEvent): boolean =>
        m.kind === "action" &&
        (m.evidence as Record<string, unknown>).anomalyKey === ev.anomalyKey &&
        ["message", "message_again", "sms"].includes(String((m.evidence as Record<string, unknown>).kind));
      const answered = events.find(
        (r) =>
          r.kind === "reply" &&
          r.atMs >= e.atMs &&
          (r.evidence as Record<string, unknown>).answersKey === ev.anomalyKey &&
          // A reply answers the MOST RECENT ask with its key, not every ask
          // that shares the key. "delay" keeps one key across recurrences, so
          // without this an answer to the second delay would be credited to
          // the first, unanswered one.
          !events.some((m) => isAskWithSameKey(m) && m.atMs > e.atMs && m.atMs <= r.atMs),
      );
      lines.push(
        at + " — " + String(ev.channel) + ": \"" + String(ev.text) + "\"" +
          (answered ? " — answered " + clockLabel(answered.atMs, tz) : " — no reply"),
      );
    }
    if (e.kind === "call") lines.push(at + " — called: " + (ev.answered ? "answered" : "no answer"));
    if (e.kind === "reply") lines.push(at + " — driver replied: \"" + String(ev.rawText) + "\"");
  }
  if (reply) {
    lines.push("");
    lines.push("The driver's words, verbatim: \"" + reply.rawText + "\"");
  }
  if (draftAttached) {
    lines.push("");
    lines.push("The deadline is at risk. A customer email is attached as a draft. Reply \"send the customer email\" to send it as-is.");
  }
  if (staleFix) {
    lines.push("");
    if (staleFix.deadlineAtRisk) lines.push("The deadline is at risk as of " + clockLabel(staleFix.asOfMs, tz) + ".");
    lines.push("No customer draft: the last position is " + staleFix.fixAgeMin + " min old.");
  }
  if (!hosKnown) {
    lines.push("");
    lines.push("Driver hours are not on file; every ETA above excludes a mandatory break.");
  }
  return lines.join("\n");
}

export function customerDraft(brief: Brief, etaMs: number, tz: string, hosKnown: boolean): { subject: string; body: string } {
  const body = "Load " + brief.loadRef + " (" + brief.origin.name + " to " + brief.destination.name + "): current ETA " + clockLabel(etaMs, tz) + ".";
  return {
    subject: "Update on load " + brief.loadRef,
    // A customer reading an ETA is entitled to know it is a drive-only one.
    body: hosKnown ? body : body + " This ETA does not include a mandatory rest break.",
  };
}

export function customerArrival(brief: Brief, arrivedMs: number, tz: string): { subject: string; body: string } {
  const lateMin = Math.round((arrivedMs - brief.deadlineAtMs) / MIN_MS);
  const verdict = lateMin > 0 ? lateMin + " minutes after the " + clockLabel(brief.deadlineAtMs, tz) + " deadline" : "on time";
  return {
    subject: "Load " + brief.loadRef + " arrived",
    body: "Load " + brief.loadRef + " arrived " + brief.destination.name + " at " + clockLabel(arrivedMs, tz) + ", " + verdict + ".",
  };
}
