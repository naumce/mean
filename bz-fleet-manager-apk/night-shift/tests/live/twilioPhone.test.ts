import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { PendingCalls } from "../../src/live/pendingCalls.js";
import { TwilioPhone, type VoiceClient } from "../../src/live/twilioPhone.js";
import { twilioVoiceRouter } from "../../src/live/twilioWebhooks.js";

const client = () => ({ calls: { create: vi.fn<VoiceClient["calls"]["create"]>(async () => ({ sid: "CA1" })) } });

describe("TwilioPhone", () => {
  it("places the call with our webhook URLs and resolves from the gather", async () => {
    const c = client();
    const pending = new PendingCalls("https://x.example");
    const phone = new TwilioPhone(c, "+15550001", "https://x.example", pending);
    const outcome = phone.call("+38970000000", "You're about 45 minutes behind. Is everything OK?");
    const create = c.calls.create.mock.calls[0][0];
    expect(create.to).toBe("+38970000000");
    const id = create.url.match(/\/twilio\/voice\/([^/]+)\/answer$/)![1];
    expect(create.statusCallback).toBe("https://x.example/twilio/voice/" + id + "/status");
    expect(pending.answerTwiml(id)).toContain("45 minutes behind");
    expect(pending.answerTwiml(id)).toContain('input="speech"');
    pending.gather(id, "truck broke down", "0.87");
    await expect(outcome).resolves.toEqual({ answered: true, transcript: "truck broke down", confidence: 0.87 });
  });

  it("a briefing call says its piece and hangs up — it does not listen", async () => {
    const c = client();
    const pending = new PendingCalls("https://x.example");
    const phone = new TwilioPhone(c, "+15550001", "https://x.example", pending);
    const outcome = phone.call("+38978000000", "Escalation on load W-19, driver Jake.", { listen: false });
    const id = c.calls.create.mock.calls[0][0].url.match(/\/twilio\/voice\/([^/]+)\/answer$/)![1];
    const xml = pending.answerTwiml(id);
    expect(xml).toContain("Escalation on load W-19, driver Jake.");
    expect(xml).not.toContain("<Gather");
    expect(xml).not.toContain("let dispatch know");
    expect(xml).toContain("<Hangup/>");
    pending.status(id, "completed");
    await expect(outcome).resolves.toEqual({ answered: true, transcript: null, confidence: null });
  });

  it("resolves unanswered from a no-answer status, and never invents a transcript", async () => {
    const c = client();
    const pending = new PendingCalls("https://x.example");
    const phone = new TwilioPhone(c, "+15550001", "https://x.example", pending);
    const outcome = phone.call("+38970000000", "hello");
    const id = c.calls.create.mock.calls[0][0].url.match(/voice\/([^/]+)\//)![1];
    pending.status(id, "no-answer");
    await expect(outcome).resolves.toEqual({ answered: false, transcript: null, confidence: null });
  });

  it("times out as unanswered when Twilio never reports back", async () => {
    const pending = new PendingCalls("https://x.example");
    const phone = new TwilioPhone(client(), "+15550001", "https://x.example", pending, { outcomeTimeoutMs: 20 });
    await expect(phone.call("+38970000000", "hello")).resolves.toEqual({ answered: false, transcript: null, confidence: null });
  });

  it("throws when the call cannot be placed — a failed delivery, not a no-answer", async () => {
    vi.useFakeTimers();
    try {
      const c = client(); c.calls.create.mockRejectedValueOnce(new Error("21215 geo permission"));
      const pending = new PendingCalls("https://x.example");
      await expect(new TwilioPhone(c, "+15550001", "https://x.example", pending).call("+38970000000", "hi")).rejects.toThrow(/21215/);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves TwiML over the verified webhook routes", async () => {
    const c = client();
    const pending = new PendingCalls("https://x.example");
    const phone = new TwilioPhone(c, "+15550001", "https://x.example", pending);
    const outcome = phone.call("+38970000000", "Is everything OK?");
    const id = c.calls.create.mock.calls[0][0].url.match(/voice\/([^/]+)\//)![1];
    const app = express().use(twilioVoiceRouter(pending, () => true, "https://x.example"));
    const answer = await request(app).post(`/twilio/voice/${id}/answer`).set("X-Twilio-Signature", "s").type("form").send({ CallSid: "CA1" });
    expect(answer.status).toBe(200);
    expect(answer.text).toContain("<Gather");
    const gather = await request(app).post(`/twilio/voice/${id}/gather`).set("X-Twilio-Signature", "s").type("form").send({ SpeechResult: "all good", Confidence: "0.91" });
    expect(gather.text).toContain("<Hangup");
    await expect(outcome).resolves.toEqual({ answered: true, transcript: "all good", confidence: 0.91 });
    const bad = await request(express().use(twilioVoiceRouter(pending, () => false, "https://x.example"))).post(`/twilio/voice/${id}/answer`).type("form").send({});
    expect(bad.status).toBe(403);
  });
});
