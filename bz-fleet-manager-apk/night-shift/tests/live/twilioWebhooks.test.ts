import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { Registry } from "../../src/live/registry.js";
import { twilioSmsRouter } from "../../src/live/twilioWebhooks.js";
import type { Brief } from "../../src/core/types.js";

const brief: Brief = {
  loadRef: "T-01", origin: { name: "A", lat: 41.99, lng: 21.43 }, destination: { name: "B", lat: 42.0, lng: 21.5 },
  equipment: "DryVan", departAtMs: 1, deadlineAtMs: 2, driverName: "Trajce", driverPhone: "+38970000000",
  customerEmail: null, minutesSinceBreakAtDepart: null,
};

const ORG_A_SENDER = "+15559990001";

async function setup(valid = true) {
  const agent = { start: vi.fn(async () => {}), onReply: vi.fn(async () => {}), tick: vi.fn(async () => {}), state: { status: "tracking" } };
  const reg = new Registry(() => agent as never);
  await reg.start(brief, {}, { orgId: "org-a", sender: ORG_A_SENDER, callerId: ORG_A_SENDER });
  const validate = vi.fn(() => valid);
  const app = express().use(twilioSmsRouter(reg, validate, "https://x.example", () => 9_000));
  return { app, agent, validate, reg };
}

describe("POST /twilio/sms", () => {
  it("verifies the signature against the public URL and hands the text to the driver's agent", async () => {
    const { app, agent, validate } = await setup();
    const res = await request(app).post("/twilio/sms").set("X-Twilio-Signature", "sig").type("form").send({ From: "+38970000000", To: ORG_A_SENDER, Body: "had to pee" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Response");
    expect(validate).toHaveBeenCalledWith("sig", "https://x.example/twilio/sms", expect.objectContaining({ From: "+38970000000", Body: "had to pee" }));
    expect(agent.onReply).toHaveBeenCalledWith({ atMs: 9_000, channel: "sms", rawText: "had to pee" });
  });

  it("refuses an unsigned request with 403 and never calls the agent", async () => {
    const { app, agent } = await setup(false);
    const res = await request(app).post("/twilio/sms").type("form").send({ From: "+38970000000", To: ORG_A_SENDER, Body: "hi" });
    expect(res.status).toBe(403);
    expect(agent.onReply).not.toHaveBeenCalled();
  });

  it("404s a text from a phone that is not a live driver", async () => {
    const { app, agent } = await setup();
    const res = await request(app).post("/twilio/sms").set("X-Twilio-Signature", "sig").type("form").send({ From: "+15550009", To: ORG_A_SENDER, Body: "hi" });
    expect(res.status).toBe(404);
    expect(agent.onReply).not.toHaveBeenCalled();
  });

  it("403s a bad signature even from an unregistered number, before the registry lookup", async () => {
    const { app, agent } = await setup(false);
    const res = await request(app).post("/twilio/sms").set("X-Twilio-Signature", "sig").type("form").send({ From: "+15550009", To: ORG_A_SENDER, Body: "hi" });
    expect(res.status).toBe(403);
    expect(agent.onReply).not.toHaveBeenCalled();
  });

  it("matches by driver phone AND by that trip's own org sender — the same From with a different org's To is a 404", async () => {
    const { app, agent } = await setup();
    // The driver phone matches this trip, but `To` is org B's sender, not
    // org A's — `byPhone` must not cross-match across orgs sharing a driver
    // phone (a driver can only be live under the trip that started for them).
    const res = await request(app).post("/twilio/sms").set("X-Twilio-Signature", "sig").type("form").send({ From: "+38970000000", To: "+15559990002", Body: "hi" });
    expect(res.status).toBe(404);
    expect(agent.onReply).not.toHaveBeenCalled();
    // The same driver phone WITH org A's own sender as `To` still reaches the trip.
    const ok = await request(app).post("/twilio/sms").set("X-Twilio-Signature", "sig").type("form").send({ From: "+38970000000", To: ORG_A_SENDER, Body: "hi again" });
    expect(ok.status).toBe(200);
    expect(agent.onReply).toHaveBeenCalledWith({ atMs: 9_000, channel: "sms", rawText: "hi again" });
  });
});
