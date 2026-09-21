// Twilio calling us. Every request is verified against the public URL and
// the auth token before anything reaches an agent — an unsigned POST from
// the open internet is a 403 and a log line, never a driver's reply.
import { Router, urlencoded, type Request, type Response } from "express";
import { log } from "./log.js";
import type { PendingCalls } from "./pendingCalls.js";
import type { Registry } from "./registry.js";

export type Validate = (signature: string, url: string, params: Record<string, string>) => boolean;

export function twilioSmsRouter(registry: Registry, validate: Validate, publicUrl: string, clock: () => number): Router {
  const r = Router();
  r.use(urlencoded({ extended: false }));

  r.post("/twilio/sms", async (req: Request, res: Response) => {
    const params = req.body as Record<string, string>;
    if (!validate(String(req.header("X-Twilio-Signature") ?? ""), publicUrl + "/twilio/sms", params)) {
      log("warn", "twilio sms webhook: bad signature", { from: params.From ?? null });
      res.status(403).type("text/plain").send("forbidden");
      return;
    }
    const trip = registry.byPhone(String(params.From ?? ""), String(params.To ?? ""));
    if (!trip) {
      log("warn", "twilio sms webhook: no live trip for sender", { from: params.From ?? null });
      res.status(404).type("text/plain").send("no live trip for this number");
      return;
    }
    try {
      await trip.agent.onReply({ atMs: clock(), channel: "sms", rawText: String(params.Body ?? "") });
    } catch (e) {
      log("error", "twilio sms webhook: agent failed", { tripId: trip.tripId, error: e instanceof Error ? e.message : String(e) });
    }
    // Empty TwiML: the agent answers through its own port, never by auto-reply.
    res.type("text/xml").send("<Response></Response>");
  });

  return r;
}

export function twilioVoiceRouter(pending: PendingCalls, validate: Validate, publicUrl: string): Router {
  const r = Router();
  r.use(urlencoded({ extended: false }));
  const guarded = (path: string, handle: (id: string, params: Record<string, string>) => string | void | Promise<string>) =>
    r.post(`/twilio/voice/:id/${path}`, async (req: Request, res: Response) => {
      const params = req.body as Record<string, string>;
      const url = publicUrl + "/twilio/voice/" + req.params.id + "/" + path;
      if (!validate(String(req.header("X-Twilio-Signature") ?? ""), url, params)) {
        log("warn", "twilio voice webhook: bad signature", { path, id: req.params.id });
        res.status(403).type("text/plain").send("forbidden");
        return;
      }
      // Slice 3: a conversation turn awaits the model. If that throws, the
      // driver still gets a goodbye, never a dead line or a Twilio error tone.
      try {
        const twiml = await handle(String(req.params.id), params);
        res.type("text/xml").send(twiml ?? "<Response></Response>");
      } catch (e) {
        log("error", "twilio voice webhook: handler failed", { path, id: req.params.id, error: e instanceof Error ? e.message : String(e) });
        res.type("text/xml").send(`<Response><Say voice="Polly.Matthew" language="en-US">Thanks, I'll let dispatch know.</Say><Hangup/></Response>`);
      }
    });
  guarded("answer", (id) => pending.answerTwiml(id));
  guarded("gather", (id, p) => pending.gather(id, String(p.SpeechResult ?? ""), String(p.Confidence ?? "")));
  guarded("status", (id, p) => { pending.status(id, String(p.CallStatus ?? "")); });
  return r;
}
