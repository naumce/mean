import { describe, expect, it } from "vitest";
import { newDriverToken, newTripId, signAction, verifyAction } from "../../src/live/tokens.js";

describe("tokens", () => {
  it("makes ids that do not collide and are URL-safe", () => {
    const a = newTripId(), b = newTripId();
    expect(a).not.toBe(b);
    expect(newDriverToken()).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  });

  it("signs an action link and verifies it back", () => {
    const s = signAction("secret", "trip1", "send_customer_email", 1_000_000);
    expect(verifyAction("secret", s, 999_999)).toEqual({ tripId: "trip1", action: "send_customer_email" });
  });

  it("refuses a link after it expires, and a link signed with another secret", () => {
    const s = signAction("secret", "trip1", "send_customer_email", 1_000_000);
    expect(verifyAction("secret", s, 1_000_001)).toBeNull();
    expect(verifyAction("other", s, 1)).toBeNull();
  });

  it("refuses a tampered link", () => {
    // A dispatcher's inbox is not a trusted network: changing the trip in the
    // URL must not send someone else's customer an email.
    const s = signAction("secret", "trip1", "send_customer_email", 1_000_000);
    const tampered = s.replace("trip1", "trip2");
    expect(verifyAction("secret", tampered, 1)).toBeNull();
  });
});
