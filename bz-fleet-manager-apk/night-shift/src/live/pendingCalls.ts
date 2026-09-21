// The pending-call map every placed call sits in between the moment it is
// placed and the moment Twilio tells us how it went. Shared across every
// trip's TwilioPhone — Twilio's three callbacks (answer/gather/status) name
// a call only by the id we minted when we placed it, never by which trip's
// number placed it — so there is exactly one of these per process, owned by
// the worker and handed to both every TwilioPhone (to register a call) and
// the voice webhook router (to resolve one).
import type { CallOptions, CallOutcome } from "../ports/index.js";

const VOICE = 'voice="Polly.Matthew" language="en-US"';
const SIGN_OFF = "Thanks, I'll let dispatch know.";
/** Slice 3: how many driver turns a conversation may take before the phone
 *  signs off on its own — a cap on cost and on a driver's patience, not a
 *  target. */
export const MAX_CONVERSATION_TURNS = 4;

const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);

export interface Pending {
  script: string;
  listen: boolean;
  converse: CallOptions["converse"] | null;
  /** Every driver utterance so far, for the transcript the outcome reports. */
  heard: string[];
  turns: number;
  resolve: (o: CallOutcome) => void;
  timer: NodeJS.Timeout;
}

export class PendingCalls {
  private pending: Record<string, Pending> = {};

  constructor(private readonly publicUrl: string) {}

  /** A `TwilioPhone` calls this right after placing a call, so the webhooks
   *  that follow have something to resolve against. */
  register(id: string, entry: Pending): void {
    this.pending = { ...this.pending, [id]: entry };
  }

  answerTwiml(id: string): string {
    const p = this.pending[id];
    const script = p ? p.script : "Hi, this is the dispatch assistant. Is everything OK?";
    if (p && !p.listen) return `<?xml version="1.0" encoding="UTF-8"?><Response><Say ${VOICE}>${esc(script)}</Say><Hangup/></Response>`;
    const gatherUrl = this.publicUrl + "/twilio/voice/" + id + "/gather";
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Say ${VOICE}>${esc(script)}</Say>` +
      `<Gather input="speech" language="en-US" speechTimeout="auto" action="${gatherUrl}" method="POST"><Say ${VOICE}>Go ahead.</Say></Gather>` +
      `<Say ${VOICE}>${SIGN_OFF}</Say></Response>`;
  }

  /** Twilio posts what the driver said. A one-question call (no
   *  `converse`) settles on the first utterance, as it always did. A
   *  conversation asks the caller for the next line and keeps listening
   *  until it says done, the turn cap is hit, or the outcome timer fires
   *  (which settles the call with whatever was heard so far — the webhook
   *  that arrives after that finds nothing pending and just hangs up). */
  async gather(id: string, speech: string, confidence: string): Promise<string> {
    const p = this.pending[id];
    const c = Number(confidence);
    const conf = Number.isFinite(c) ? c : null;
    const said = speech.trim();
    if (!p) return `<?xml version="1.0" encoding="UTF-8"?><Response><Say ${VOICE}>${SIGN_OFF}</Say><Hangup/></Response>`;
    const heard = said ? [...p.heard, said] : p.heard;
    const turns = p.turns + 1;
    this.pending = { ...this.pending, [id]: { ...p, heard, turns } };
    if (!p.converse) {
      this.settle(id, { answered: true, transcript: said || null, confidence: conf });
      return `<?xml version="1.0" encoding="UTF-8"?><Response><Say ${VOICE}>${SIGN_OFF}</Say><Hangup/></Response>`;
    }
    const step = await p.converse(said, conf);
    const done = step.done || turns >= MAX_CONVERSATION_TURNS;
    if (done) {
      this.settle(id, { answered: true, transcript: heard.length ? heard.join(" / ") : null, confidence: conf });
      return `<?xml version="1.0" encoding="UTF-8"?><Response><Say ${VOICE}>${esc(step.say)}</Say><Hangup/></Response>`;
    }
    const gatherUrl = this.publicUrl + "/twilio/voice/" + id + "/gather";
    return `<?xml version="1.0" encoding="UTF-8"?><Response>` +
      `<Gather input="speech" language="en-US" speechTimeout="auto" action="${gatherUrl}" method="POST"><Say ${VOICE}>${esc(step.say)}</Say></Gather>` +
      `<Say ${VOICE}>${SIGN_OFF}</Say><Hangup/></Response>`;
  }

  status(id: string, callStatus: string): void {
    if (["no-answer", "busy", "failed", "canceled"].includes(callStatus)) this.settle(id, { answered: false, transcript: null, confidence: null });
    else if (callStatus === "completed") {
      const heard = this.pending[id]?.heard ?? [];
      this.settle(id, { answered: true, transcript: heard.length ? heard.join(" / ") : null, confidence: null });
    }
  }

  settle(id: string, outcome: CallOutcome): void {
    const p = this.pending[id];
    if (!p) return;
    this.forget(id);
    p.resolve(outcome);
  }

  /** Also used by `TwilioPhone` when placing the call itself fails — the
   *  promise rejects instead of settling, but the pending entry (and its
   *  timeout) must not linger either. */
  forget(id: string): void {
    const p = this.pending[id];
    if (p) clearTimeout(p.timer);
    const { [id]: _gone, ...rest } = this.pending;
    void _gone;
    this.pending = rest;
  }
}
