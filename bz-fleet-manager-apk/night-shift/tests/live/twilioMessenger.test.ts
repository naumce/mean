import { describe, expect, it, vi } from "vitest";
import { ChatBus } from "../../src/live/chatBus.js";
import { TwilioMessenger } from "../../src/live/twilioMessenger.js";

const client = () => ({ messages: { create: vi.fn(async () => ({ sid: "SM123" })) } });
const trip = { tripId: "t1", driverToken: "tok_abc" };

describe("TwilioMessenger", () => {
  it("delivers chat to the driver's page, not to Twilio", async () => {
    const c = client(); const bus = new ChatBus();
    const m = new TwilioMessenger(c, "+15550001", bus, trip, "https://x.example", () => 7_000);
    await m.sendChat("+38970000000", "Everything OK?");
    expect(bus.since("t1", 0).map((x) => x.text)).toEqual(["Everything OK?"]);
    expect(c.messages.create).not.toHaveBeenCalled();
  });

  it("sends SMS through Twilio with the driver link appended", async () => {
    const c = client();
    const m = new TwilioMessenger(c, "+15550001", new ChatBus(), trip, "https://x.example", () => 7_000);
    await m.sendSms("+38970000000", "Load T-01: … Tap Accept to share your location for this run.");
    expect(c.messages.create).toHaveBeenCalledWith({
      from: "+15550001", to: "+38970000000",
      body: "Load T-01: … Tap Accept to share your location for this run.\nhttps://x.example/d/tok_abc",
    });
  });

  it("lets a Twilio failure propagate — the core records a failed delivery, not a sent one", async () => {
    const c = client(); c.messages.create.mockRejectedValueOnce(new Error("21610 unsubscribed"));
    const m = new TwilioMessenger(c, "+15550001", new ChatBus(), trip, "https://x.example", () => 7_000);
    await expect(m.sendSms("+38970000000", "hi")).rejects.toThrow(/21610/);
  });
});
