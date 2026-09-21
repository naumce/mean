// In-memory adapters. Each records what it was asked so a test can assert
// on the agent's behaviour through the ports, exactly as production would
// observe it. Nothing here is mocked with a library; they are small classes.
import { haversineMi, interpolate } from "../domain.js";
import { matchByKeywords } from "../core/situations.js";
import type { AgentEvent, GeoPoint, LngLat, RouteAnswer } from "../core/types.js";
import type { CallOptions, CallOutcome, Clock, ClassifierPort, ConversationContext, ConversationPort, ConversationStep, EventStore, MailerPort, MessengerPort, PhonePort, RouteOptions, RouterPort, SheetPort, Attachment } from "../ports/index.js";

export class FakeClock implements Clock {
  constructor(private t: number) {}
  nowMs(): number { return this.t; }
  set(ms: number): void { this.t = ms; }
  advanceMin(min: number): void { this.t += min * 60_000; }
}

/** A straight line densified to ~2 mi vertices, at a flat speed. Stands in
 *  for Mapbox in tests; the vertex spacing keeps projection meaningful.
 *  `_opts` is ignored on purpose: a straight line has no truck profile and
 *  no traffic. */
export class StraightRouter implements RouterPort {
  constructor(private mph: number = 60) {}
  async route(from: GeoPoint, to: GeoPoint, _opts?: RouteOptions): Promise<RouteAnswer> {
    const distanceMi = haversineMi(from, to);
    const n = Math.max(1, Math.ceil(distanceMi / 2));
    const geometry: LngLat[] = Array.from({ length: n + 1 }, (_, i) => {
      const p = interpolate(from, to, i / n);
      return [p.lng, p.lat];
    });
    return { geometry, distanceMi, driveMin: (distanceMi / this.mph) * 60 };
  }
}

export class MemorySheet implements SheetPort {
  cells: Record<string, Record<string, string>> = {};
  log: Array<{ loadRef: string; event: AgentEvent }> = [];
  async writeStatus(loadRef: string, cells: Record<string, string>): Promise<void> {
    this.cells = { ...this.cells, [loadRef]: { ...(this.cells[loadRef] ?? {}), ...cells } };
  }
  async appendLog(loadRef: string, event: AgentEvent): Promise<void> {
    this.log = [...this.log, { loadRef, event }];
  }
}

export class MemoryMessenger implements MessengerPort {
  sent: Array<{ phone: string; channel: "chat" | "sms"; text: string }> = [];
  async sendChat(phone: string, text: string): Promise<void> { this.sent = [...this.sent, { phone, channel: "chat", text }]; }
  async sendSms(phone: string, text: string): Promise<void> { this.sent = [...this.sent, { phone, channel: "sms", text }]; }
}

/** Every call goes unanswered unless a test queues an outcome. */
/** Answers each call with the next queued outcome. A queued `driverSays`
 *  list plays a conversation: each line is fed to the call's `converse`
 *  callback (when the agent gave one) until it says done or the lines run
 *  out, and the outcome's transcript is the exchange, as the real phone
 *  would report it. */
export class MemoryPhone implements PhonePort {
  calls: Array<{ phone: string; script: string; turns: Array<{ role: "agent" | "driver"; text: string }> }> = [];
  outcomes: CallOutcome[] = [];
  driverSays: string[][] = [];
  async call(phone: string, script: string, opts: CallOptions = {}): Promise<CallOutcome> {
    const [lines, ...restLines] = this.driverSays;
    this.driverSays = restLines;
    const turns: Array<{ role: "agent" | "driver"; text: string }> = [{ role: "agent", text: script }];
    if (lines && opts.converse) {
      for (const line of lines) {
        turns.push({ role: "driver", text: line });
        const step = await opts.converse(line, 0.95);
        turns.push({ role: "agent", text: step.say });
        if (step.done) break;
      }
      this.calls = [...this.calls, { phone, script, turns }];
      return { answered: true, transcript: turns.filter((t) => t.role === "driver").map((t) => t.text).join(" / "), confidence: 0.95 };
    }
    this.calls = [...this.calls, { phone, script, turns }];
    const [next, ...rest] = this.outcomes;
    this.outcomes = rest;
    return next ?? { answered: false, transcript: null, confidence: null };
  }
}

/** A conversation port that follows a script: one step per driver turn,
 *  in order; past the script it closes with an unclassified sign-off. */
export class ScriptedConversation implements ConversationPort {
  asked: ConversationContext[] = [];
  constructor(private steps: ConversationStep[]) {}
  async converse(ctx: ConversationContext): Promise<ConversationStep> {
    this.asked = [...this.asked, ctx];
    const [next, ...rest] = this.steps;
    this.steps = rest;
    return next ?? { say: "Thanks, I'll let dispatch know.", done: true, situationKey: null, confidence: 0, summary: null };
  }
}

/** Hands back a monotonic id per send, the way a real provider does, so a
 *  test can assert what the agent recorded against what was sent. */
export class MemoryMailer implements MailerPort {
  sent: Array<{ to: string; subject: string; body: string; attachments: Attachment[]; messageId: string }> = [];
  async send(to: string, subject: string, body: string, attachments: Attachment[] = []): Promise<{ messageId: string }> {
    const messageId = "m" + (this.sent.length + 1);
    this.sent = [...this.sent, { to, subject, body, attachments, messageId }];
    return { messageId };
  }
}

export class KeywordClassifier implements ClassifierPort {
  async classify(text: string): Promise<{ key: string | null; confidence: number }> { return matchByKeywords(text); }
}

export class MemoryEvents implements EventStore {
  events: AgentEvent[] = [];
  async append(event: AgentEvent): Promise<void> { this.events = [...this.events, event]; }
  async all(): Promise<AgentEvent[]> { return this.events; }
}
