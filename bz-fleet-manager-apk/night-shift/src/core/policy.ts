// The agent's tunable thresholds and behaviour toggles, as a policy the trip
// carries — not module constants. A dispatcher configures how the agent
// behaves (per trip, or as a fleet default) through this object instead of a
// code change. fleet-backend's Prisma `AgentPolicy` model mirrors this shape
// exactly — same names, same units, same defaults — so a policy row created
// there and a policy object read here never drift on what a field means.
export interface Policy {
  name: string;
  /** Stationary this long, away from any planned stop, is a question.
   *  Minutes; scaled by TIME_SCALE, same as STOP_MIN was. */
  stopMin: number;
  /** Behind the plan line by this much is a delay even if the deadline is
   *  still safe. Minutes; NOT scaled — a claim about the road, not about
   *  patience (same as DELAY_BEHIND_PLAN_MIN was). */
  delayMin: number;
  /** No ping for this long while tracking is "gone dark". Minutes; NOT
   *  scaled (same as DARK_MIN was). */
  darkMin: number;
  /** ...unless the last ping was at a stop, where a phone loses GPS indoors.
   *  Minutes; NOT scaled (same as DARK_AT_STOP_MIN was). */
  darkAtStopMin: number;
  /** Off the route line by this many miles before an excursion counts at
   *  all. Never scaled — a distance, not a duration. */
  offRouteMi: number;
  /** Off route this long before it is raised. Minutes; NOT scaled (same as
   *  OFF_ROUTE_MIN was). */
  offRouteMin: number;
  /** Minutes between a rung of the ladder and its retry at the same rung —
   *  what CALL_RETRY_MIN did. Minutes; scaled by TIME_SCALE, same as
   *  CALL_RETRY_MIN was. */
  rungGapMin: number;
  /** One call plus this many retries before the dispatcher is woken. Zero
   *  skips calling the driver entirely: the ladder escalates straight from
   *  the rung-2 message/SMS. Never scaled — a count, not a duration. */
  maxCalls: number;
  dispatcherEmail: string;
  dispatcherPhone: string | null;
  /** Whether the agent may draft/send customer-facing status emails at all. */
  customerEmailOn: boolean;
  /** When true, the agent plans, detects and climbs the ladder exactly as it
   *  would live, but every messenger/phone/mailer send is replaced by a
   *  sheet log line of what it would have said — nothing reaches a driver, a
   *  dispatcher or a customer. For trying the agent on a real load without
   *  risking a real phone. */
  shadow: boolean;
  /** Whether an unresolved escalation also rings the dispatcher's phone with
   *  a spoken briefing, in addition to the email. */
  bossCallOn: boolean;
  /** "HH:MM" wall-clock window, in the trip's tz, the agent does not call or
   *  text a human. Null on either means no quiet hours configured. */
  quietFrom: string | null;
  quietTo: string | null;
}

/** The default every trip gets unless a dispatcher configures otherwise, and
 *  the values fleet-backend's Prisma `AgentPolicy` model defaults a new row
 *  to. The thresholds are exactly the old module constants' values, so a
 *  trip on STANDARD behaves exactly as the agent always has. `shadow: true`
 *  is the one deliberate difference from "just the old constants": a policy
 *  nobody has reviewed yet must not be the first thing to text a driver, so
 *  a brand-new STANDARD policy runs the whole night as a rehearsal — plan,
 *  detect, climb the ladder, log every line it would have sent — until a
 *  dispatcher reads the log and turns shadow off. */
export const STANDARD: Policy = {
  name: "Standard",
  stopMin: 15,
  delayMin: 30,
  darkMin: 20,
  darkAtStopMin: 60,
  offRouteMi: 3.1,
  offRouteMin: 10,
  rungGapMin: 5,
  maxCalls: 2,
  // A template value: the real address belongs to the fleet/dispatcher that
  // owns the policy, not to the agent's default. Task 2 does not yet read
  // this field for dispatcher contact — AgentDeps.dispatcherEmail still is —
  // it exists here for field parity with fleet-backend's model.
  dispatcherEmail: "",
  dispatcherPhone: null,
  customerEmailOn: false,
  shadow: true,
  bossCallOn: true,
  quietFrom: null,
  quietTo: null,
};
