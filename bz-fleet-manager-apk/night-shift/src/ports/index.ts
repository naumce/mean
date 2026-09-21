// Every way the agent touches the world, as an interface. The core never
// imports an adapter; tests use the fakes, production uses the real ones.
import type { AgentEvent, Brief, GeoPoint, RouteAnswer } from "../core/types.js";

export interface Clock {
  nowMs(): number;
}

/** What the road depends on besides the two points. The Mapbox adapter turns
 *  `equipment` into a truck profile — a reefer and a flatbed are not routed
 *  down the same streets — and `departAtMs` into a traffic-aware departure.
 *  A straight-line fake ignores both, which is exactly why they are on the
 *  port and not on the fake. */
export interface RouteOptions {
  equipment: string;
  departAtMs: number;
}

export interface RouterPort {
  route(from: GeoPoint, to: GeoPoint, opts: RouteOptions): Promise<RouteAnswer>;
}

export interface SheetPort {
  writeStatus(loadRef: string, cells: Record<string, string>): Promise<void>;
  appendLog(loadRef: string, event: AgentEvent): Promise<void>;
}

export interface MessengerPort {
  sendChat(phone: string, text: string): Promise<void>;
  sendSms(phone: string, text: string): Promise<void>;
}

export interface CallOutcome {
  answered: boolean;
  transcript: string | null;
  /** The speech engine's confidence in `transcript`, 0..1, or null when the
   *  provider does not report one. Below CLASSIFY_FLOOR the words are not
   *  evidence and the reply is treated as unknown — a misheard transcript
   *  classified confidently is how a load gets a breakdown on its record
   *  that the driver never reported. */
  confidence: number | null;
}

/** `listen` (default true) gathers what the person says after the script.
 *  A briefing to the dispatcher says its piece and hangs up: their words are
 *  not a driver reply and must never be classified as one.
 *
 *  `converse` (slice 3, 2026-09-19) turns the call into an exchange: after
 *  each thing the driver says, the phone asks it what to say next and
 *  whether to keep listening. Absent, the call is the one-question call it
 *  always was. The phone adapter never knows what decides the next line. */
export interface CallOptions {
  listen?: boolean;
  converse?: (driverSaid: string, confidence: number | null) => Promise<{ say: string; done: boolean }>;
}

export interface PhonePort {
  call(phone: string, script: string, opts?: CallOptions): Promise<CallOutcome>;
}

export interface Attachment {
  name: string;
  body: string;
}

/** `messageId` is the provider's id for the sent message, so a follow-on
 *  adapter can thread the dispatcher's reply back to the mail it answers.
 *  Null when the provider does not return one. */
export interface MailerPort {
  send(to: string, subject: string, body: string, attachments?: Attachment[]): Promise<{ messageId: string | null }>;
}

export interface ClassifierPort {
  classify(text: string): Promise<{ key: string | null; confidence: number }>;
}

/** One turn of a driver call, as the conversation port sees it. */
export interface ConversationTurn {
  role: "agent" | "driver";
  text: string;
}

/** What the conversation port is asked with after every driver utterance:
 *  the run (brief, with its context), why the agent is calling, and every
 *  turn so far — the opening script first. */
export interface ConversationContext {
  brief: Brief;
  reason: string;
  turns: ConversationTurn[];
}

/** The port's answer. `done: false` means say `say` and listen again;
 *  `done: true` means say `say` (a sign-off) and hang up, with the verdict
 *  in `situationKey`/`confidence` (a key from the situation library, or
 *  null when the exchange did not settle it) and a one-line `summary` a
 *  dispatcher can read. The port only ever talks and classifies — it holds
 *  no authority to change the plan, promise the driver anything, or reach
 *  anyone else; every action still belongs to the ladder. */
export interface ConversationStep {
  say: string;
  done: boolean;
  situationKey: string | null;
  confidence: number;
  summary: string | null;
}

export interface ConversationPort {
  converse(ctx: ConversationContext): Promise<ConversationStep>;
}

/** One store per trip. An adapter is constructed with the trip id and scopes
 *  every call to it; `all()` returns that trip's events in order. */
export interface EventStore {
  append(event: AgentEvent): Promise<void>;
  all(): Promise<AgentEvent[]>;
}
