// The escalation ladder (spec §7): what the agent does next about one
// anomaly, given what it has already done and when. Pure state machine; the
// agent executes the action through a port and records the new state.
import { LINK_UNOPENED_SMS_MIN, MIN_MS, RUNG1_COOLDOWN_MIN, RUNG2_COOLDOWN_MIN, TIME_SCALE } from "./constants.js";
import type { Policy } from "./policy.js";

export type Rung = 0 | 1 | 2 | 3 | 4;
export type ActionKind = "message" | "message_again" | "sms" | "call" | "call_retry" | "escalate";

export interface LadderAction {
  rung: Rung;
  kind: ActionKind;
}

export interface LadderState {
  rung: Rung;
  lastActionMs: number | null;
  callAttempts: number;
  failures: number;
  stopped: boolean;
  stoppedReason: "replied" | "escalated" | "resolved" | null;
}

export const initialLadder = (): LadderState => ({
  rung: 0,
  lastActionMs: null,
  callAttempts: 0,
  failures: 0,
  stopped: false,
  stoppedReason: null,
});

export function nextAction(state: LadderState, ctx: { nowMs: number; linkOpenedMs: number | null; policy: Policy }): LadderAction | null {
  if (state.stopped) return null;
  const sinceMin = state.lastActionMs === null ? Number.POSITIVE_INFINITY : (ctx.nowMs - state.lastActionMs) / MIN_MS;
  const { policy } = ctx;

  switch (state.rung) {
    case 0:
      // A rung 0 that already has a lastActionMs is a delivery that FAILED:
      // nothing reached the driver, so the rung did not advance, but the
      // cooldown applies before it is attempted again. A fresh anomaly has
      // no lastActionMs and is messaged at once.
      if (sinceMin < RUNG1_COOLDOWN_MIN) return null;
      return { rung: 1, kind: "message" };
    case 1: {
      if (sinceMin < RUNG1_COOLDOWN_MIN) return null;
      // A link that has never been opened is not a channel; fall back to SMS.
      const linkUnopened = ctx.linkOpenedMs === null || ctx.nowMs - ctx.linkOpenedMs > LINK_UNOPENED_SMS_MIN * MIN_MS;
      return { rung: 2, kind: linkUnopened ? "sms" : "message_again" };
    }
    case 2:
      if (sinceMin < RUNG2_COOLDOWN_MIN) return null;
      // policy.maxCalls 0 means the driver is never called: go straight from
      // the rung-2 message/SMS to escalating the dispatcher.
      if (policy.maxCalls <= 0) return { rung: 4, kind: "escalate" };
      return { rung: 3, kind: "call" };
    case 3:
      if (sinceMin < policy.rungGapMin * TIME_SCALE) return null;
      if (state.callAttempts < policy.maxCalls) return { rung: 3, kind: "call_retry" };
      return { rung: 4, kind: "escalate" };
    case 4:
      return null;
  }
}

export function applyAction(state: LadderState, action: LadderAction, nowMs: number): LadderState {
  const isCall = action.kind === "call" || action.kind === "call_retry";
  return {
    ...state,
    rung: action.rung,
    lastActionMs: nowMs,
    callAttempts: isCall ? state.callAttempts + 1 : state.callAttempts,
    failures: 0,
    // `state.stopped ||`: an action applied to a ladder that is already
    // stopped must never un-stop it.
    stopped: state.stopped || action.kind === "escalate",
    stoppedReason: action.kind === "escalate" ? "escalated" : state.stoppedReason,
  };
}

/** The action was decided but the port threw: nothing reached the driver.
 *  The rung does NOT advance — there is no message to follow up on — but the
 *  cooldown starts, so a dead gateway is retried on the ladder's clock
 *  instead of on every ping until it comes back. */
export function applyFailure(state: LadderState, nowMs: number): LadderState {
  return { ...state, lastActionMs: nowMs, failures: state.failures + 1 };
}

export function stopLadder(state: LadderState, reason: "replied" | "resolved"): LadderState {
  return { ...state, stopped: true, stoppedReason: reason };
}
