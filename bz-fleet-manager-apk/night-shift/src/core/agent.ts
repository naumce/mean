// The loop. Owns one trip's state and the event log; everything it does to
// the world goes through a port. Rules (detect.ts, ladder.ts, situations.ts)
// decide; this file sequences them and records evidence.
import { BREAK_DURATION_MIN, dwellSegments, haversineMi } from "../domain.js";
import type { AgentDeps } from "./agentDeps.js";
import { ACCEPT_GRACE_MIN, ARRIVAL_DWELL_MIN, ARRIVAL_RADIUS_MI, CLASSIFY_FLOOR, MAX_DELIVERY_FAILURES, MIN_MS, PLANNED_STOP_RADIUS_MI, SHEET_WRITE_EVERY_MIN, STALE_FIX_MIN } from "./constants.js";
import { detectAnomalies } from "./detect.js";
import { applyAction, applyFailure, initialLadder, nextAction, stopLadder, type LadderAction, type LadderState } from "./ladder.js";
import { callScriptFor, clockLabel, customerArrival, customerDraft, escalationBody, escalationCallScript, escalationSubject, inviteText, placeLabel, questionFor } from "./phrases.js";
import { remainingItinerary } from "./itinerary.js";
import { buildPlan, liveEtaMs, minutesBehindPlan } from "./plan.js";
import { situationFor, UNKNOWN_RESPONSE } from "./situations.js";
import type { AgentEvent, Anomaly, Brief, DriverReply, EventKind, Ping, Plan, RouteAnswer, TripStatus } from "./types.js";
import type { Attachment, CallOptions, CallOutcome, ConversationStep, ConversationTurn } from "../ports/index.js";

export interface TripState {
  brief: Brief;
  plan: Plan | null;
  status: TripStatus;
  attentionReason: string | null;
  pings: Ping[];
  linkOpenedMs: number | null;
  acceptedAt: number | null;
  departedAt: number | null;
  arrivedAt: number | null;
  breakTakenAt: number | null;
  ladders: Record<string, LadderState>;
  openQuestionKey: string | null;
  lastSheetWriteMs: number | null;
  acceptEscalated: boolean;
  /** Supervision (spec §17.3): "I've got it" — set by `takeover()`. Anomalies
   *  are still detected and recorded; the ladder just stops opening
   *  questions, calling, or escalating until `handback()`. */
  held: boolean;
  /** The customer note waiting on the dispatcher's word. `kind` records which
   *  note it is, so the sent-email event never labels an arrival note a delay
   *  update. */
  customerDraft: { kind: "customer_delay" | "customer_arrival"; subject: string; body: string } | null;
}

/** What a thrown value is called in an event record. `String(e)` on an Error
 *  yields "Error: gateway 503"; the message alone is what a human reads. */
const errorMessage = (e: unknown): string => (e instanceof Error ? String(e.message) : String(e));

const STATUS_LABEL: Record<TripStatus, string> = {
  assigned: "Assigned", invited: "Invited", accepted: "Accepted", tracking: "Tracking", arrived: "Arrived", closed: "Closed", attention: "Attention",
};

export class Agent {
  state: TripState;

  constructor(private readonly deps: AgentDeps, brief: Brief) {
    this.state = {
      brief, plan: null, status: "assigned", attentionReason: null, pings: [], linkOpenedMs: null, acceptedAt: null,
      departedAt: null, arrivedAt: null, breakTakenAt: null, ladders: {}, openQuestionKey: null, lastSheetWriteMs: null,
      acceptEscalated: false, customerDraft: null, held: false,
    };
  }

  private patch(p: Partial<TripState>): void {
    this.state = { ...this.state, ...p };
  }

  async start(): Promise<void> {
    const { brief } = this.state;
    let route: RouteAnswer;
    let plan: Plan;
    try {
      route = await this.deps.router.route(brief.origin, brief.destination, { equipment: brief.equipment, departAtMs: brief.departAtMs });
      plan = buildPlan(brief, route, this.deps.restStops);
    } catch (e) {
      // Without a plan there is nothing to measure the truck against, so the
      // driver is not invited onto a run the agent cannot watch. A human is
      // told, and the row says why.
      const message = errorMessage(e);
      this.patch({ status: "attention", attentionReason: "route unusable: " + message });
      await this.record("plan", { failed: true, error: message }, "route unusable — no plan built");
      await this.escalate("route unusable", null, null);
      return;
    }
    this.patch({ plan, status: "invited" });
    await this.record("plan", {
      distanceMi: Math.round(route.distanceMi), driveMin: Math.round(route.driveMin), etaAtMs: plan.etaAtMs,
      breakWindow: plan.breakWindow ? { startMs: plan.breakWindow.startMs, endMs: plan.breakWindow.endMs, recommended: plan.breakWindow.recommended?.name ?? null } : null,
      // Slice 2: the itinerary rides on the plan event so the drawer can
      // show it without the worker's memory (it is what the run WAS
      // planned as; `sheet_write` events carry the re-timed remainder).
      itinerary: plan.itinerary,
    });
    // A run the driver's own clock cannot carry is a fact worth a human
    // before the first mile, not after the first anomaly.
    if (plan.itinerary.hos && !plan.itinerary.hos.feasible) {
      await this.record("action", { kind: "hos_infeasible", reason: plan.itinerary.hos.reason }, "hours cannot carry this run: " + plan.itinerary.hos.reason);
      await this.escalate("hours cannot carry this run — " + plan.itinerary.hos.reason, null, null);
    }
    const text = inviteText(brief, this.deps.tz);
    await this.sendText("sms", brief.driverPhone, text);
    await this.record("action", { kind: "invite", channel: "sms", text }, "invite sent");
    await this.writeSheet(true);
  }

  async onAccept(): Promise<void> {
    const now = this.deps.clock.nowMs();
    // A reloaded page taps Accept again. Accepting is a one-way step: once
    // it has happened, a second accept must not move a tracking truck back
    // and re-stamp its departure. A late accept from Attention still counts.
    if (this.state.acceptedAt !== null) {
      this.patch({ linkOpenedMs: now });
      return;
    }
    this.patch({ status: "accepted", acceptedAt: now, linkOpenedMs: now });
    await this.record("action", { kind: "accepted" }, "driver accepted");
    await this.writeSheet(true);
  }

  /** A backgrounded browser tab flushes a queue, so fixes arrive out of the
   *  order they were taken. A stale fix must never move the truck backwards,
   *  end a stop, or "resolve" an anomaly the agent did not observe resolving:
   *  it is recorded as refused and changes nothing. */
  async onPing(ping: Ping): Promise<void> {
    try {
      const previous = this.state.pings[this.state.pings.length - 1];
      if (previous && ping.atMs <= previous.atMs) {
        await this.record("ping", { atMs: ping.atMs, lat: ping.lat, lng: ping.lng, ignored: true, reason: "out of order" });
        return;
      }
      const s = this.state;
      if (s.status === "invited") await this.onAccept(); // a ping is only possible from an opened link
      const first = this.state.status === "accepted";
      this.patch({ pings: [...this.state.pings, ping], linkOpenedMs: ping.atMs, ...(first ? { status: "tracking", departedAt: ping.atMs } : {}) });
      await this.record("ping", { atMs: ping.atMs, lat: ping.lat, lng: ping.lng });
      if (first) {
        // A state change writes the sheet now, not on the next cadence tick —
        // otherwise the row reads "Accepted" for up to fifteen minutes of
        // driving. Logged as an action so the briefing can say when he left.
        await this.record("action", { kind: "departed", atMs: ping.atMs }, "first ping — tracking");
        await this.writeSheet(true, ping.atMs);
      }
      await this.evaluate(ping.atMs);
    } catch (e) {
      await this.noteLoopError(e);
    }
  }

  async tick(): Promise<void> {
    try {
      await this.evaluate(this.deps.clock.nowMs());
    } catch (e) {
      await this.noteLoopError(e);
    }
  }

  /** A port that throws where nothing else caught it must not take the loop
   *  down with it: the next ping still has to be evaluated. The failure is
   *  recorded so the morning briefing knows the tick was incomplete. */
  private async noteLoopError(e: unknown): Promise<void> {
    try {
      await this.record("action", { kind: "loop_error", error: errorMessage(e) }, "the loop survived a port failure");
    } catch {
      // The event store itself is down. There is nowhere left to write the
      // fact, and throwing from here would defeat the whole guard.
    }
  }

  async onReply(reply: DriverReply): Promise<void> {
    try {
      await this.handleReply(reply);
    } catch (e) {
      await this.noteLoopError(e);
    }
  }

  private async handleReply(reply: DriverReply): Promise<void> {
    // A transcript the speech engine is unsure of is not evidence. Running
    // the classifier over it anyway would stack a confident guess on top of
    // an unconfident hearing, and the load would carry a breakdown the
    // driver never reported. Below the floor the reply is simply unknown,
    // and the dispatcher gets the words themselves.
    const sttBelowFloor = reply.confidence != null && reply.confidence < CLASSIFY_FLOOR;
    // Slice 3: a call the conversation port already settled arrives with
    // its verdict. Re-running the keyword classifier over the transcript
    // would let a stray word overrule an exchange that asked follow-ups.
    const { key, confidence } = sttBelowFloor
      ? { key: null, confidence: reply.confidence as number }
      : reply.verdict
        ? reply.verdict
        : await this.deps.classifier.classify(reply.rawText);
    const situationKey = !sttBelowFloor && key !== null && confidence >= CLASSIFY_FLOOR ? key : null;
    const situation = situationKey ? situationFor(situationKey) : null;
    const answersKey = this.state.openQuestionKey;
    await this.record("reply", {
      channel: reply.channel, rawText: reply.rawText, situationKey, confidence, answersKey,
      ...(sttBelowFloor ? { sttBelowFloor: true } : {}),
    });

    const response = situation ? situation.response : UNKNOWN_RESPONSE;
    await this.sendText("chat", this.state.brief.driverPhone, response);
    await this.record("action", { kind: "respond", channel: "chat", text: response, situationKey }, "responded");

    if (answersKey && this.state.ladders[answersKey]) {
      this.patch({ ladders: { ...this.state.ladders, [answersKey]: stopLadder(this.state.ladders[answersKey], "replied") }, openQuestionKey: null });
    }
    if (!situation) await this.escalate("driver reply not understood", reply, null);
    else if (situation.level >= 2) await this.escalate("driver reports: " + situation.dispatcherNote, reply, null);
  }

  /** The dispatcher's reply-command vocabulary (spec §8). Anything else is
   *  echoed back, never acted on. */
  async onDispatcherReply(text: string): Promise<void> {
    try {
      await this.handleDispatcherReply(text);
    } catch (e) {
      await this.noteLoopError(e);
    }
  }

  private async handleDispatcherReply(text: string): Promise<void> {
    const cmd = text.trim().toLowerCase();
    const { brief, customerDraft: draft } = this.state;
    if (cmd === "send the customer email") {
      if (draft && brief.customerEmail) {
        const { messageId } = await this.sendMail(brief.customerEmail, draft.subject, draft.body);
        this.patch({ customerDraft: null });
        await this.record("email", { to: brief.customerEmail, kind: draft.kind, subject: draft.subject, messageId }, "customer email sent on instruction");
        return;
      }
      // A command the agent understands, with nothing to act on. Echoing
      // "I didn't understand that" would be a false claim about the
      // dispatcher's words, and would leave him believing the note went.
      const { messageId } = await this.sendMail(this.deps.dispatcherEmail, "[" + brief.loadRef + "] Nothing to send", "No customer note is pending for this load.");
      await this.record("email", { to: this.deps.dispatcherEmail, kind: "nothing_to_send", messageId }, "no customer note pending");
      return;
    }
    const echo = await this.sendMail(this.deps.dispatcherEmail, "[" + brief.loadRef + "] I didn't understand that", "You wrote: \"" + text + "\"\n\nI can act on: send the customer email.");
    await this.record("email", { to: this.deps.dispatcherEmail, kind: "echo", text, messageId: echo.messageId }, "unrecognized command echoed");
  }

  // --------------------------------------------------------- supervision

  /** "I've got it" (spec §17.3): the platform worker calls this from an
   *  `AgentCommand` of kind `takeover`. Anomalies are still detected and
   *  recorded — see the `held` guard in `evaluateNow` — only the ladder's
   *  own actions (message, call, escalate) stop. */
  async takeover(): Promise<void> {
    this.patch({ held: true });
    await this.record("action", { kind: "takeover" }, "dispatcher took over — ladder muted");
  }

  /** The other half of `takeover()`: the ladder resumes acting on whatever
   *  it next detects. Nothing held while muted is retroactively acted on. */
  async handback(): Promise<void> {
    this.patch({ held: false });
    await this.record("action", { kind: "handback" }, "handed back — ladder resumed");
  }

  /** The drawer's reply box (spec §6.4): the dispatcher's own words. This
   *  method does not deliver them — the platform adapter posts the text to
   *  the driver's page directly, as the dispatcher, so a human's sentence is
   *  never run through the classifier or answered with a canned response.
   *  What this DOES do is what a driver's own reply would: close whatever
   *  question is open, so the ladder does not ask again. */
  async onDispatcherPost(text: string): Promise<void> {
    const key = this.state.openQuestionKey;
    if (key && this.state.ladders[key]) {
      this.patch({ ladders: { ...this.state.ladders, [key]: stopLadder(this.state.ladders[key], "replied") }, openQuestionKey: null });
    }
    await this.record("action", { kind: "dispatcher_post", text }, "dispatcher replied to the driver directly");
  }

  /** "Call the driver now" (spec §6.4): a call outside the ladder's own
   *  cooldown, on the dispatcher's word (rung 3 on demand). Same shadow
   *  behaviour as every other call; an answered call is classified exactly
   *  like a ladder call. */
  async callDriverNow(): Promise<void> {
    const script = "Hi, this is a check-in call about load " + this.state.brief.loadRef + " — dispatch asked me to call. Is everything all right?";
    const convo = this.conversationFor("dispatch asked for a check-in call", script);
    let outcome: CallOutcome;
    try {
      outcome = await this.placeCall(this.state.brief.driverPhone, script, convo.options);
    } catch (e) {
      await this.record("call", { manual: true, failed: true, error: errorMessage(e) }, "manual call failed");
      return;
    }
    await this.record("call", { manual: true, script, answered: outcome.answered, transcript: outcome.transcript, ...convo.evidence() }, "manual call (dispatcher requested)");
    if (outcome.answered && outcome.transcript) {
      await this.onReply({ atMs: this.deps.clock.nowMs(), channel: "call", rawText: outcome.transcript, confidence: outcome.confidence, verdict: convo.verdict() });
    }
  }

  /** Slice 3: wraps one driver call in a conversation, when a conversation
   *  port is configured. The phone calls `converse` after each thing the
   *  driver says; the port decides the next line and whether to hang up.
   *  Everything said, both ways, and the port's final verdict are kept here
   *  so the call event can carry the exchange verbatim and the reply can
   *  arrive pre-classified. Without a port, `options` is empty and the call
   *  is the one-question call it always was. A port that throws mid-call
   *  ends the call politely rather than leaving the driver on a dead line. */
  private conversationFor(reason: string, script: string): { options: CallOptions; evidence: () => Record<string, unknown>; verdict: () => { key: string | null; confidence: number } | undefined } {
    const port = this.deps.conversation ?? null;
    let turns: ConversationTurn[] = [{ role: "agent", text: script }];
    let last: ConversationStep | null = null;
    let failed: string | null = null;
    const options: CallOptions = port
      ? {
          converse: async (driverSaid, confidence) => {
            turns = [...turns, { role: "driver", text: driverSaid }];
            if (confidence != null && confidence < CLASSIFY_FLOOR) {
              const say = "Sorry, I didn't catch that. Could you say it again?";
              turns = [...turns, { role: "agent", text: say }];
              return { say, done: false };
            }
            try {
              const step = await port.converse({ brief: this.state.brief, reason, turns });
              last = step;
              turns = [...turns, { role: "agent", text: step.say }];
              return { say: step.say, done: step.done };
            } catch (e) {
              failed = errorMessage(e);
              const say = "Thanks, I'll let dispatch know.";
              turns = [...turns, { role: "agent", text: say }];
              return { say, done: true };
            }
          },
        }
      : {};
    return {
      options,
      evidence: () => (port ? { turns, summary: last?.summary ?? null, ...(failed ? { conversationError: failed } : {}) } : {}),
      verdict: () => (last && last.situationKey ? { key: last.situationKey, confidence: last.confidence } : undefined),
    };
  }

  // ---------------------------------------------------------------- loop

  /** One evaluation at a time. A live call holds execute() for up to 90 s;
   *  a ping or a tick landing meanwhile would re-detect the same anomaly on
   *  a ladder that has not advanced yet and ring the driver again. The
   *  skipped evaluation costs nothing: the ping is already recorded, and the
   *  next ping or tick evaluates. */
  private evaluating = false;

  private async evaluate(nowMs: number): Promise<void> {
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      await this.evaluateNow(nowMs);
    } finally {
      this.evaluating = false;
    }
  }

  private async evaluateNow(nowMs: number): Promise<void> {
    const s = this.state;
    if (!s.plan) return;

    if (s.status === "invited" && !s.acceptEscalated && nowMs >= s.brief.departAtMs + ACCEPT_GRACE_MIN * MIN_MS) {
      this.patch({ status: "attention", attentionReason: "not accepted by departure + " + ACCEPT_GRACE_MIN + " min", acceptEscalated: true });
      await this.escalate("load not accepted by " + clockLabel(s.brief.departAtMs + ACCEPT_GRACE_MIN * MIN_MS, this.deps.tz), null, null);
      return;
    }
    if (s.status !== "tracking") return;

    const last = s.pings[s.pings.length - 1];
    if (!last) return;

    if (haversineMi(last, s.brief.destination) <= ARRIVAL_RADIUS_MI) {
      const seg = dwellSegments(s.pings, s.brief.destination, ARRIVAL_RADIUS_MI).find((x) => !x.departureObserved && x.lastSeenMs === last.atMs);
      if (seg && seg.observedMin >= ARRIVAL_DWELL_MIN) {
        // Arrival is when the truck GOT there (the first ping in the fence),
        // not the minute we became sure of it five minutes later.
        await this.arrive(seg.firstSeenMs, nowMs);
        return;
      }
    }

    await this.noteBreakCompliance(last);

    const anomalies = detectAnomalies(s.plan, this.deps.policy, s.pings, this.deps.restStops, nowMs, this.state.breakTakenAt !== null, this.breakCreditMin());
    const current = new Set(anomalies.map((a) => a.key));

    for (const key of Object.keys(this.state.ladders)) {
      if (current.has(key)) continue;
      // The anomaly is gone. DROP its ladder rather than mark it: a delay
      // that clears and comes back is a new situation and must climb a fresh
      // ladder — a kept "resolved" entry would silence it for the rest of the
      // trip. The record says it resolved; the state forgets it.
      const ladders = Object.fromEntries(Object.entries(this.state.ladders).filter(([k]) => k !== key)) as Record<string, LadderState>;
      this.patch({ ladders, openQuestionKey: this.state.openQuestionKey === key ? null : this.state.openQuestionKey });
      await this.record("anomaly", { key, resolved: true }, "resolved on its own");
    }

    for (const a of anomalies) {
      let ladder = this.state.ladders[a.key];
      if (!ladder) {
        ladder = initialLadder();
        this.patch({ ladders: { ...this.state.ladders, [a.key]: ladder } });
        await this.record("anomaly", { ...a.evidence, kind: a.kind, key: a.key });
      }
      if (ladder.stopped) continue;
      if (this.state.held) continue; // takeover (spec §17.3): detected and logged above, ladder muted
      if (this.state.openQuestionKey && this.state.openQuestionKey !== a.key) continue; // one open question at a time
      const action = nextAction(ladder, { nowMs, linkOpenedMs: this.state.linkOpenedMs, policy: this.deps.policy });
      if (action) await this.execute(a, ladder, action, nowMs);
    }

    await this.writeSheet(false, nowMs);
  }

  /** The mandatory break, taken in its window at a registered stop, is
   *  compliance. Recorded once so the briefing can say so; never messaged.
   *  With no hours on file there is no window to be inside of, so a full
   *  thirty at a registered stop is recorded as an OBSERVED break — the plan
   *  line has to hold for it either way, and the record says which it was. */
  private async noteBreakCompliance(last: Ping): Promise<void> {
    const s = this.state;
    const plan = s.plan;
    if (!plan || s.breakTakenAt !== null) return;
    const w = plan.breakWindow;
    // Hours known and no break due on this run: nothing to observe.
    if (!w && plan.hosKnown) return;
    if (w && (last.atMs < w.startMs || last.atMs > w.endMs)) return;
    const stop = this.deps.restStops.find((r) => haversineMi(r, last) <= PLANNED_STOP_RADIUS_MI);
    if (!stop) return;
    const seg = dwellSegments(s.pings, last).find((x) => !x.departureObserved && x.lastSeenMs === last.atMs);
    if (!seg || seg.observedMin < BREAK_DURATION_MIN) return;
    this.patch({ breakTakenAt: seg.firstSeenMs });
    if (w) {
      await this.record("plan", { breakTakenAtMs: seg.firstSeenMs, at: stop.name, observedMin: seg.observedMin, recommended: w.recommended?.name === stop.name }, "mandatory break taken — compliance, no action");
    } else {
      await this.record("plan", { breakTakenAtMs: seg.firstSeenMs, at: stop.name, observedMin: seg.observedMin, hosKnown: false }, "break observed at a registered stop — hours not on file, no action");
    }
  }

  /** Minutes of a mandatory break the truck is observed taking — parked at a
   *  registered stop, inside the window when there is one. Owed break time
   *  shrinks as it is taken, so the ETA cannot project past the deadline in
   *  the middle of the one stop the plan itself required; and the plan line
   *  holds for the break he ACTUALLY took, not only the one that was drawn
   *  for him. A completed break is worth the whole thirty for the rest of
   *  the run: the line must not snap back the minute he pulls out. */
  private breakCreditMin(): number {
    const s = this.state;
    if (s.breakTakenAt !== null) return BREAK_DURATION_MIN;
    const plan = s.plan;
    const last = s.pings[s.pings.length - 1];
    if (!plan || !last) return 0;
    const w = plan.breakWindow;
    // Hours KNOWN and no window: no break is due on this run, so a dwell at a
    // registered stop is fueling or rest, not a break — it earns no credit.
    // Hours UNKNOWN: there was nothing to plan a window from, and a dwell at
    // a registered stop is the best evidence of a break the agent will get.
    if (!w && plan.hosKnown) return 0;
    if (w && (last.atMs < w.startMs || last.atMs > w.endMs)) return 0;
    if (!this.deps.restStops.some((r) => haversineMi(r, last) <= PLANNED_STOP_RADIUS_MI)) return 0;
    const seg = dwellSegments(s.pings, last).find((x) => !x.departureObserved && x.lastSeenMs === last.atMs);
    return seg ? Math.min(BREAK_DURATION_MIN, seg.observedMin) : 0;
  }

  private async execute(a: Anomaly, ladder: LadderState, action: LadderAction, nowMs: number): Promise<void> {
    const s = this.state;
    const ctx = { brief: s.brief, plan: s.plan!, landmarks: this.deps.landmarks, tz: this.deps.tz };
    const phone = s.brief.driverPhone;

    if (action.kind === "escalate") {
      this.patch({ ladders: { ...s.ladders, [a.key]: applyAction(ladder, action, nowMs) }, openQuestionKey: null });
      await this.escalate(a.kind.replace("_", " ") + " unresolved after " + ladder.callAttempts + " calls", null, a);
      return;
    }

    if (action.kind === "call" || action.kind === "call_retry") {
      const script = callScriptFor(a, ctx);
      const convo = this.conversationFor(a.kind.replace("_", " ") + " — " + (a.evidence.summary ? String(a.evidence.summary) : a.key), script);
      let outcome: CallOutcome;
      try {
        outcome = await this.placeCall(phone, script, convo.options);
      } catch (e) {
        await this.noteDeliveryFailure(a, ladder, action, "call", nowMs, e);
        return;
      }
      this.patch({ ladders: { ...s.ladders, [a.key]: applyAction(ladder, action, nowMs) } });
      await this.record("call", { anomalyKey: a.key, rung: action.rung, kind: action.kind, script, answered: outcome.answered, transcript: outcome.transcript, ...convo.evidence() }, action.kind);
      if (outcome.answered && outcome.transcript) await this.onReply({ atMs: nowMs, channel: "call", rawText: outcome.transcript, confidence: outcome.confidence, verdict: convo.verdict() });
      return;
    }

    const text = questionFor(a, ctx);
    const channel = action.kind === "sms" ? "sms" : "chat";
    try {
      await this.sendText(channel, phone, text);
    } catch (e) {
      await this.noteDeliveryFailure(a, ladder, action, channel, nowMs, e);
      return;
    }
    // Only a delivery that actually happened climbs the ladder and opens a
    // question. Climbing on a send that threw would have the agent calling a
    // driver about a message he was never sent.
    this.patch({ ladders: { ...s.ladders, [a.key]: applyAction(ladder, action, nowMs) }, openQuestionKey: a.key });
    await this.record("action", { anomalyKey: a.key, rung: action.rung, kind: action.kind, channel, text }, action.kind);
  }

  private async noteDeliveryFailure(a: Anomaly, ladder: LadderState, action: LadderAction, channel: string, nowMs: number, e: unknown): Promise<void> {
    this.patch({ ladders: { ...this.state.ladders, [a.key]: applyFailure(ladder, nowMs) } });
    await this.record(
      "action",
      { anomalyKey: a.key, rung: action.rung, kind: action.kind, channel, failed: true, error: errorMessage(e) },
      "delivery failed — will retry after cooldown",
    );
    const after = this.state.ladders[a.key];
    if (after.failures >= MAX_DELIVERY_FAILURES) {
      // A gateway that failed three times in a row will fail the next ladder
      // too: every active ladder stops, and the dispatcher hears it once. A
      // later anomaly with a new key starts a fresh ladder — new news.
      const ladders = Object.fromEntries(
        Object.entries(this.state.ladders).map(([k, l]) => [k, l.stopped ? l : { ...l, stopped: true, stoppedReason: "escalated" as const }]),
      );
      this.patch({ ladders, openQuestionKey: null });
      await this.escalate(`could not reach the driver — ${after.failures} delivery failures at rung ${action.rung}`, null, a);
    }
  }

  private async escalate(reason: string, reply: DriverReply | null, anomaly: Anomaly | null): Promise<void> {
    const s = this.state;
    const nowMs = this.deps.clock.nowMs();
    const last = s.pings[s.pings.length - 1];
    // A delivered load has no ETA to state. Once arrived, nothing here may
    // build a delay draft — it would supersede the arrival note the
    // dispatcher was shown, and "send the customer email" would then send a
    // future ETA for a truck already at the dock.
    const arrived = s.status === "arrived";
    const eta = !arrived && s.plan && last ? liveEtaMs(s.plan, last, nowMs, s.breakTakenAt !== null, this.breakCreditMin()) : null;
    const deadlineAtRisk = eta !== null && s.plan !== null && eta > s.plan.deadlineAtMs;
    // With no plan there is no claim to make about hours either way; the
    // line is only printed when the plan positively says the hours are gone.
    const hosKnown = s.plan?.hosKnown ?? true;
    // A customer email is a statement about where the truck is NOW. Built
    // from a fix an hour old it is a guess with a letterhead, so it is not
    // built at all — the dispatcher is told why, and what the old fix implies.
    const fixAgeMin = last ? Math.round((nowMs - last.atMs) / MIN_MS) : null;
    const staleFix = fixAgeMin !== null && fixAgeMin > STALE_FIX_MIN;
    const wouldDraft = deadlineAtRisk && s.brief.customerEmail !== null && eta !== null;
    const draft = wouldDraft && !staleFix && eta !== null
      ? { kind: "customer_delay" as const, ...customerDraft(s.brief, eta, this.deps.tz, hosKnown) }
      : null;
    // A draft lives until it is sent. A fresh at-risk draft supersedes the
    // one before it; an escalation that carries no draft of its own — not at
    // risk, no customer, a fix too old to write from — leaves the pending one
    // alone. Clearing it here is how "send the customer email" ends up doing
    // nothing at all, minutes after the dispatcher was invited to say it.
    // ...and a draft never supersedes a pending draft of a different kind:
    // an arrival note outranks any ETA, and an ETA can never replace it.
    const pending = this.state.customerDraft;
    const keepPending = pending !== null && draft !== null && pending.kind !== draft.kind;
    this.patch({ customerDraft: keepPending ? pending : (draft ?? pending) });
    const withheld = wouldDraft && staleFix && last ? { fixAgeMin: fixAgeMin!, asOfMs: last.atMs, deadlineAtRisk } : null;
    const events = await this.deps.events.all();
    const body = escalationBody(s.brief, reason, events, reply, draft !== null, this.deps.tz, hosKnown, withheld);
    let messageId: string | null = null;
    try {
      messageId = (await this.sendMail(this.deps.dispatcherEmail, escalationSubject(s.brief, reason), body, draft ? [{ name: "customer-draft.txt", body: draft.body }] : undefined)).messageId;
    } catch (e) {
      // A dead mailer must not lose the escalation itself: the record is
      // what the morning briefing is built from, and it says the mail
      // never went out.
      await this.record("email", { to: this.deps.dispatcherEmail, failed: true, error: errorMessage(e) }, "escalation email failed to send");
    }
    await this.record("escalation", {
      reason, deadlineAtRisk, draftAttached: draft !== null, anomalyKey: anomaly?.key ?? null, messageId,
      ...(withheld ? { draftWithheld: "stale fix", fixAgeMin } : {}),
    });
    await this.writeSheet(true, nowMs);
    await this.callDispatcher(reason, last, messageId !== null);
  }

  /** The escalation, spoken. Placed after the email so "I've emailed you" is
   *  true when it is said; a call that fails is recorded, never retried —
   *  the email is the escalation, the ring is the nudge. */
  private async callDispatcher(reason: string, last: Ping | undefined, emailed: boolean): Promise<void> {
    const to = this.deps.dispatcherPhone;
    if (!to) return;
    const s = this.state;
    const where = last && s.plan ? placeLabel(last, this.deps.landmarks, s.plan, s.brief.origin.name) : null;
    const script = escalationCallScript(s.brief, reason, where, last?.atMs ?? null, this.deps.tz, emailed);
    try {
      const outcome = await this.placeCall(to, script, { listen: false });
      await this.record("dispatcher_call", { to, script, answered: outcome.answered }, outcome.answered ? "dispatcher answered the briefing" : "dispatcher did not answer the briefing");
    } catch (e) {
      await this.record("dispatcher_call", { to, script, failed: true, error: errorMessage(e) }, "dispatcher call failed");
    }
  }

  /** On time, the arrival is routine status and goes straight to the
   *  customer. Late, it is bad news — and the agent does not deliver bad news
   *  to a customer on its own authority. The note is written, attached, and
   *  handed to the dispatcher, who decides whether and when it goes. */
  private async arrive(arrivedAtMs: number, nowMs: number): Promise<void> {
    this.patch({ status: "arrived", arrivedAt: arrivedAtMs });
    const lateMin = Math.round((arrivedAtMs - this.state.brief.deadlineAtMs) / MIN_MS);
    await this.record("action", { kind: "arrived", arrivedAtMs, lateMin }, "arrived");
    await this.writeSheet(true, nowMs);
    const { brief } = this.state;
    if (!brief.customerEmail) return;
    const note = customerArrival(brief, arrivedAtMs, this.deps.tz);
    if (lateMin <= 0) {
      let sent: { messageId: string | null };
      try {
        sent = await this.sendMail(brief.customerEmail, note.subject, note.body);
      } catch (e) {
        await this.record("email", { to: brief.customerEmail, failed: true, error: errorMessage(e) }, "arrival email failed to send");
        return;
      }
      await this.record("email", { to: brief.customerEmail, kind: "customer_arrival", messageId: sent.messageId }, "customer told of arrival");
      return;
    }
    this.patch({ customerDraft: { kind: "customer_arrival", ...note } });
    let drafted: { messageId: string | null };
    try {
      drafted = await this.sendMail(
        this.deps.dispatcherEmail,
        "[" + brief.loadRef + "] arrived " + lateMin + " min late — customer note drafted",
        note.body + "\n\nReply \"send the customer email\" to send the attached note.",
        [{ name: "customer-arrival.txt", body: note.body }],
      );
    } catch (e) {
      // The draft stays pending either way; the dispatcher can still send it.
      await this.record("email", { to: this.deps.dispatcherEmail, failed: true, error: errorMessage(e) }, "late-arrival draft failed to send");
      return;
    }
    await this.record("email", { to: this.deps.dispatcherEmail, kind: "arrival_late_draft", lateMin, messageId: drafted.messageId }, "late arrival drafted for the dispatcher");
  }

  // ------------------------------------------------------------- output

  private statusCells(nowMs: number): Record<string, string> {
    const s = this.state;
    const tz = this.deps.tz;
    const last = s.pings[s.pings.length - 1];
    const cells: Record<string, string> = { "Agent Status": STATUS_LABEL[s.status], "Last Update": clockLabel(nowMs, tz) };
    if (s.attentionReason) cells["Agent Status"] = STATUS_LABEL.attention + " — " + s.attentionReason;
    if (s.plan && last) {
      cells["Last Position"] = placeLabel(last, this.deps.landmarks, s.plan, s.brief.origin.name) + " · " + clockLabel(last.atMs, tz);
      const credit = this.breakCreditMin();
      const eta = liveEtaMs(s.plan, last, nowMs, s.breakTakenAt !== null, credit);
      // An ETA computed from a plan with no break in it is a drive-only
      // figure. The cell that shows it says so, every time it is read.
      cells["ETA"] = clockLabel(eta, tz) + (s.plan.hosKnown ? "" : " (no break planned — hours unknown)");
      const behind = Math.round(minutesBehindPlan(s.plan, last, nowMs, credit));
      cells["On Time"] =
        (behind <= 0 ? "+" + -behind + " min" : "−" + behind + " min") +
        (eta > s.plan.deadlineAtMs ? ", deadline at risk" : "") +
        (s.plan.hosKnown ? "" : ", hours unknown");
    }
    if (s.status === "arrived" && s.arrivedAt !== null) {
      const late = Math.round((s.arrivedAt - s.brief.deadlineAtMs) / MIN_MS);
      cells["On Time"] = late > 0 ? "arrived " + late + " min late" : "arrived on time";
    }
    return cells;
  }

  /** The row IS the product: a dispatcher reading a stale row believes it.
   *  So the first write that fails puts the trip in Attention and wakes him;
   *  every failure after that is recorded and nothing more, which also stops
   *  escalate()'s own write from recursing back into here. */
  private async writeSheet(force: boolean, nowMs: number = this.deps.clock.nowMs()): Promise<void> {
    const s = this.state;
    if (!force && s.lastSheetWriteMs !== null && nowMs - s.lastSheetWriteMs < SHEET_WRITE_EVERY_MIN * MIN_MS) return;
    const cells = this.statusCells(nowMs);
    try {
      await this.deps.sheet.writeStatus(s.brief.loadRef, cells);
    } catch (e) {
      const message = errorMessage(e);
      await this.record("sheet_write", { failed: true, error: message }, "sheet write failed");
      if (this.state.attentionReason === null) {
        this.patch({ status: "attention", attentionReason: "sheet write failed: " + message });
        await this.escalate("sheet write failed", null, null);
      }
      return;
    }
    this.patch({ lastSheetWriteMs: nowMs });
    // Slice 2: alongside the cells, the itinerary re-timed from the truck's
    // last fix — what is still ahead, when, and the slack that leaves.
    const last = s.pings[s.pings.length - 1];
    const remaining = s.plan && last ? remainingItinerary(s.plan.itinerary, s.plan.route, last, nowMs, s.breakTakenAt !== null) : null;
    await this.record("sheet_write", remaining ? { cells, remaining: { legs: remaining.legs, etaAtMs: remaining.etaAtMs, slackMin: Math.round(remaining.slackMin) } } : { cells });
  }

  // ------------------------------------------------------------- shadow

  /** In shadow mode, every send below is replaced by this: nobody hears
   *  anything, but the sheet's log carries the line that would have gone
   *  out, so the timeline reads exactly as live mode would have written it. */
  private async wouldSay(channel: string, to: string, text: string): Promise<void> {
    await this.record("would_say", { channel, to, text }, "would say: " + text);
  }

  /** Every driver-facing chat/SMS goes through here so shadow mode has one
   *  place to intercept it. */
  private async sendText(channel: "chat" | "sms", to: string, text: string): Promise<void> {
    if (this.deps.policy.shadow) {
      await this.wouldSay(channel, to, text);
      return;
    }
    if (channel === "sms") await this.deps.messenger.sendSms(to, text);
    else await this.deps.messenger.sendChat(to, text);
  }

  /** Every call — driver or dispatcher — goes through here. Shadow mode
   *  never dials: the outcome it hands back is exactly what an unanswered
   *  call looks like, so the ladder and the reply path behave as if nobody
   *  picked up. */
  private async placeCall(to: string, script: string, opts?: CallOptions): Promise<CallOutcome> {
    if (this.deps.policy.shadow) {
      await this.wouldSay("call", to, script);
      return { answered: false, transcript: null, confidence: null };
    }
    return this.deps.phone.call(to, script, opts);
  }

  /** Every email — dispatcher or customer — goes through here. */
  private async sendMail(to: string, subject: string, body: string, attachments?: Attachment[]): Promise<{ messageId: string | null }> {
    if (this.deps.policy.shadow) {
      await this.wouldSay("email", to, subject + "\n\n" + body);
      return { messageId: null };
    }
    return this.deps.mailer.send(to, subject, body, attachments);
  }

  private async record(kind: EventKind, evidence: Record<string, unknown>, actionTaken?: string): Promise<void> {
    const event: AgentEvent = { atMs: this.deps.clock.nowMs(), kind, evidence, ...(actionTaken ? { actionTaken } : {}) };
    await this.deps.events.append(event);
    if (kind !== "ping") await this.deps.sheet.appendLog(this.state.brief.loadRef, event);
  }
}
