import { describe, expect, it } from "vitest";
import { applyAction, applyFailure, initialLadder, nextAction, stopLadder } from "../src/core/ladder.js";
import { STANDARD } from "../src/core/policy.js";

const MIN = 60_000;
const T0 = 1_000_000;
const ctx = (min: number, linkOpenedMs: number | null = T0, policy = STANDARD) => ({ nowMs: T0 + min * MIN, linkOpenedMs, policy });

/** Walk the ladder, taking every action the moment it is offered. */
function walk(minutes: number[], linkOpenedMs: number | null = T0) {
  let s = initialLadder();
  const taken: string[] = [];
  for (const m of minutes) {
    const a = nextAction(s, ctx(m, linkOpenedMs));
    if (a) {
      s = applyAction(s, a, T0 + m * MIN);
      taken.push(m + ":" + a.kind);
    }
  }
  return { s, taken };
}

describe("ladder", () => {
  it("messages immediately on a fresh anomaly", () => {
    expect(nextAction(initialLadder(), ctx(0))).toEqual({ rung: 1, kind: "message" });
  });

  it("honors the cooldown between rungs — no machine-gunning the driver", () => {
    const { taken } = walk([0, 5, 9, 10]);
    expect(taken).toEqual(["0:message", "10:message_again"]);
  });

  it("runs the whole replay: message, again, call, retry, escalate on the spec's clock", () => {
    // 08:40 message · 08:50 again · 09:05 call · 09:10 retry · 09:15 escalate
    const { taken, s } = walk([0, 10, 25, 30, 35, 40]);
    expect(taken).toEqual(["0:message", "10:message_again", "25:call", "30:call_retry", "35:escalate"]);
    expect(s.stopped).toBe(true);
    expect(s.stoppedReason).toBe("escalated");
    expect(nextAction(s, ctx(60))).toBeNull();
  });

  it("sends an SMS at rung 2 when the link has never been opened", () => {
    const { taken } = walk([0, 10], null);
    expect(taken[1]).toBe("10:sms");
  });

  it("stops for a reply and never resumes", () => {
    let s = applyAction(initialLadder(), { rung: 1, kind: "message" }, T0);
    s = stopLadder(s, "replied");
    expect(nextAction(s, ctx(60))).toBeNull();
    expect(s.stoppedReason).toBe("replied");
  });

  it("does not climb on a delivery that failed, and holds the cooldown before retrying", () => {
    // Nothing reached the driver, so there is nothing to follow up on. But a
    // dead gateway must not be hammered on every ping either.
    const failed = applyFailure(initialLadder(), T0);
    expect(failed.rung).toBe(0);
    expect(failed.lastActionMs).toBe(T0);
    expect(nextAction(failed, ctx(9))).toBeNull();
    expect(nextAction(failed, ctx(10))).toEqual({ rung: 1, kind: "message" });
  });

  it("never un-stops a ladder that has already stopped", () => {
    const stopped = stopLadder(initialLadder(), "replied");
    expect(applyAction(stopped, { rung: 1, kind: "message" }, T0).stopped).toBe(true);
  });

  it("never mutates a state it was given", () => {
    const before = initialLadder();
    const frozen = JSON.stringify(before);
    applyAction(before, { rung: 1, kind: "message" }, T0);
    stopLadder(before, "resolved");
    expect(JSON.stringify(before)).toBe(frozen);
  });
});
