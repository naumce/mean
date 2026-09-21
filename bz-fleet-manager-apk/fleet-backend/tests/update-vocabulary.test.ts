import { describe, expect, it } from "vitest";
import { DEFAULT_UPDATE_RULES, matchRule, statusFor } from "../src/lib/updateVocabulary.js";

// Spec §6.1–§6.2: their words, matched at the start of the cell; everything
// after the verb is a note; unknown text changes nothing.
describe("matchRule", () => {
  it("matches at the start of the cell, case-insensitively, with the rest as a note", () => {
    expect(matchRule("DELIVERED 07/17/2026", DEFAULT_UPDATE_RULES)?.status).toBe("delivered");
    expect(matchRule("delivered - POD sent", DEFAULT_UPDATE_RULES)?.status).toBe("delivered");
    expect(matchRule("  In Transit - ETA 09:30", DEFAULT_UPDATE_RULES)?.status).toBe("in_progress");
    expect(matchRule("PICKED UP 07/15/2026", DEFAULT_UPDATE_RULES)?.status).toBe("in_progress");
    expect(matchRule("PENDING RATE CONFIRMATION", DEFAULT_UPDATE_RULES)?.status).toBe("open");
  });

  it("needs a word boundary after the prefix — DELIVEREDX is not DELIVERED", () => {
    expect(matchRule("DELIVEREDX", DEFAULT_UPDATE_RULES)).toBeNull();
    expect(matchRule("DELIVERED", DEFAULT_UPDATE_RULES)?.status).toBe("delivered");
    expect(matchRule("DELIVERED.", DEFAULT_UPDATE_RULES)?.status).toBe("delivered");
  });

  it("prefers the longest prefix when two match", () => {
    const rules = [{ prefix: "IN", status: "open" as const }, { prefix: "IN TRANSIT", status: "in_progress" as const }];
    expect(matchRule("IN TRANSIT - ON TIME", rules)?.prefix).toBe("IN TRANSIT");
  });

  it("returns null for free notes, blanks and disabled rules", () => {
    expect(matchRule("call John about the pallets", DEFAULT_UPDATE_RULES)).toBeNull();
    expect(matchRule("", DEFAULT_UPDATE_RULES)).toBeNull();
    expect(matchRule(null, DEFAULT_UPDATE_RULES)).toBeNull();
    expect(matchRule("DELIVERED", [{ prefix: "DELIVERED", status: "delivered", enabled: false }])).toBeNull();
  });
});

describe("statusFor", () => {
  it("maps their five verbs", () => {
    const ctx = { carrierBooked: true };
    expect(statusFor("PENDING PU CONFIRMATION", DEFAULT_UPDATE_RULES, ctx)).toBe("open");
    expect(statusFor("SCHEDULED", DEFAULT_UPDATE_RULES, ctx)).toBe("assigned");
    expect(statusFor("IN TRANSIT - CHECK CALL 14:00", DEFAULT_UPDATE_RULES, ctx)).toBe("in_progress");
    expect(statusFor("DELIVERED 07/16/2026", DEFAULT_UPDATE_RULES, ctx)).toBe("delivered");
    expect(statusFor("TONU", DEFAULT_UPDATE_RULES, ctx)).toBe("canceled");
    expect(statusFor("CANCELED", DEFAULT_UPDATE_RULES, ctx)).toBe("canceled");
  });

  it("never calls a load covered without a carrier: SCHEDULED with no carrier is open", () => {
    expect(statusFor("SCHEDULED", DEFAULT_UPDATE_RULES, { carrierBooked: false })).toBe("open");
    expect(statusFor("SCHEDULED", DEFAULT_UPDATE_RULES, { carrierBooked: true })).toBe("assigned");
  });

  it("says nothing for text that matches no rule", () => {
    expect(statusFor("waiting on POD", DEFAULT_UPDATE_RULES, { carrierBooked: true })).toBeNull();
  });
});
