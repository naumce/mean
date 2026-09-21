import { describe, expect, it } from "vitest";
import * as C from "../src/core/constants.js";

// Thresholds are product decisions from the spec. Pinning them here means a
// "tune" is a deliberate edit to two files, not a drive-by.
//
// STOP_MIN, DELAY_BEHIND_PLAN_MIN, DARK_MIN, DARK_AT_STOP_MIN, OFF_ROUTE_MI,
// OFF_ROUTE_MIN, MAX_CALLS and CALL_RETRY_MIN moved to core/policy.ts's
// STANDARD — pinned in tests/core/policy.test.ts instead, for the same
// reason: a tune is a deliberate edit, not a drive-by.
describe("constants", () => {
  it("match the spec's detection thresholds", () => {
    expect(C.PLANNED_STOP_RADIUS_MI).toBe(0.5);
    expect(C.BREAK_WINDOW_SLACK_MIN).toBe(45);
    expect(C.STALE_FIX_MIN).toBe(5);
  });
  it("match the spec's ladder cooldowns", () => {
    expect(C.RUNG1_COOLDOWN_MIN).toBe(10);
    expect(C.RUNG2_COOLDOWN_MIN).toBe(15);
    expect(C.LINK_UNOPENED_SMS_MIN).toBe(30);
  });
});
