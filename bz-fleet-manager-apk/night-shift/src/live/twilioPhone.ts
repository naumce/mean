// The voice rung, per trip. Placing a call is the one thing that differs
// trip to trip (which number it comes from); everything that happens after
// — the TwiML the three webhooks serve — is shared state keyed by a call id,
// which lives in `PendingCalls` instead, so every trip's `TwilioPhone` can
// register into the one map the webhook router reads from.
import { randomBytes } from "node:crypto";
import type { CallOptions, CallOutcome, PhonePort } from "../ports/index.js";
import type { PendingCalls } from "./pendingCalls.js";

export interface VoiceClient {
  calls: { create(opts: { from: string; to: string; url: string; statusCallback: string; statusCallbackEvent: string[]; timeout: number }): Promise<{ sid: string }> };
}

/** Seconds Twilio lets it ring before giving up. */
const RING_SECONDS = 30;
/** How long we wait for any webhook before calling it unanswered. */
const OUTCOME_TIMEOUT_MS = 90_000;

export class TwilioPhone implements PhonePort {
  constructor(
    private readonly client: VoiceClient,
    private readonly from: string,
    private readonly publicUrl: string,
    private readonly pending: PendingCalls,
    private readonly opts: { ringSeconds?: number; outcomeTimeoutMs?: number } = {},
  ) {}

  call(phone: string, script: string, opts: CallOptions = {}): Promise<CallOutcome> {
    const id = "c_" + randomBytes(8).toString("base64url");
    const base = this.publicUrl + "/twilio/voice/" + id;
    const outcome = new Promise<CallOutcome>((resolve) => {
      const timer = setTimeout(() => this.pending.settle(id, { answered: false, transcript: null, confidence: null }), this.opts.outcomeTimeoutMs ?? OUTCOME_TIMEOUT_MS);
      this.pending.register(id, { script, listen: opts.listen ?? true, converse: opts.converse ?? null, heard: [], turns: 0, resolve, timer });
    });
    // Placing the call can fail (geo permissions, bad number). Then the
    // promise must not linger: reject to the caller and forget the id.
    const placed = this.client.calls.create({
      from: this.from, to: phone, url: base + "/answer", statusCallback: base + "/status",
      statusCallbackEvent: ["completed", "no-answer", "busy", "failed", "canceled"], timeout: this.opts.ringSeconds ?? RING_SECONDS,
    });
    return placed.then(() => outcome, (e) => { this.pending.forget(id); throw e; });
  }
}
