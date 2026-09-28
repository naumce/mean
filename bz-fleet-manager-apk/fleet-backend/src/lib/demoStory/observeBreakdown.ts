import type { AgentEvent, DemoStory } from "@prisma/client";
import { prisma } from "../../db.js";
import { tick } from "../simulation/engine.js";
import { positionAlong } from "../simulation/movement.js";
import { haversineMi } from "../../domain/dispatch/distance.js";
import { DEMO_CUSTOMER_EMAIL } from "./fixtures.js";
import { evidenceOf, latest, tripsAndEvents } from "./observeEvents.js";
import { guardApproach } from "./observeDelivery.js";
import { freezeTruck, holdPing, planFraction, releaseTruck } from "./truck.js";
import type { Patch } from "./types.js";

// Demo Mode: the scripted breakdown, and the stages Night Shift walks the
// story through while the truck stands still.
//
// The clock rule: the moment the breakdown fires, the runner stops and the
// driver's sim mode goes to "stopped" (truck.ts). From then until the truck
// is released, every observe poll writes exactly one stopped ping through
// `tick(orgId, 0)` — the engine's own ping shape at the last known point, no
// clock advance — so Night Shift sees a stationary truck reporting in (its
// stop rule needs pings a minute apart) while the plan cannot run past the
// truck and deliver the load out from under the story. "Truck moving again"
// (the customer update, or the dispatcher's Resolve) puts the mode back to
// "auto" and restarts the runner.
//
// Every Night Shift event the story reacts to after the breakdown must be
// stamped after `breakdownTriggeredAt`: the trip-start invite and the canned
// reply are `would_say` rows too, and a trip-start escalation is an
// escalation too — none of them is the outreach the story is waiting for.

const DRIVER_MESSAGE_KINDS = new Set(["message", "message_again", "sms"]);
const DRIVER_MESSAGE_CHANNELS = new Set(["chat", "sms"]);
const RESOLVE_FALLBACK_MS = 3 * 60_000;

// A short, real set of waypoints on this exact Chicago -> Detroit lane
// (I-94), used only to name where the scripted breakdown happened — no
// geocoding service is contacted.
const ROUTE_WAYPOINTS: readonly { name: string; lat: number; lng: number }[] = [
  { name: "Chicago, IL", lat: 41.8781, lng: -87.6298 },
  { name: "Gary, IN", lat: 41.5934, lng: -87.3464 },
  { name: "Kalamazoo, MI", lat: 42.2917, lng: -85.5872 },
  { name: "Battle Creek, MI", lat: 42.3211, lng: -85.1797 },
  { name: "Jackson, MI", lat: 42.2459, lng: -84.4013 },
  { name: "Ann Arbor, MI", lat: 42.2808, lng: -83.743 },
  { name: "Detroit, MI", lat: 42.3314, lng: -83.0458 },
];

function nearestPlaceLabel(point: { lat: number; lng: number }): string {
  return ROUTE_WAYPOINTS.reduce((best, wp) => (haversineMi(point, wp) < haversineMi(point, best) ? wp : best)).name;
}

/** Exported for `waitingOn.ts` (finding F1a/M1): the trip-start invite, its
 *  canned reply and its own escalation are all real rows too, stamped before
 *  the scripted breakdown ever fired — none of them is the outreach/
 *  escalation the story is narrating or waiting on, so every selector that
 *  picks "the" event of a kind must agree on this same fence, not just the
 *  narration half of it. */
export function afterBreakdown(story: DemoStory, e: AgentEvent): boolean {
  const since = story.breakdownTriggeredAt?.getTime() ?? 0;
  return Number(e.atMs) > since;
}

function isUnplannedStopResolved(e: AgentEvent): boolean {
  const evidence = evidenceOf(e);
  return e.kind === "anomaly" && evidence.resolved === true && String(evidence.key ?? "").startsWith("unplanned_stop");
}

/** Night Shift's rung-1 outreach to the driver: a live `action` of a message
 *  kind, or its shadow-mode `would_say` on a driver channel. Emails and calls
 *  travel as `would_say` too and are not outreach to the driver. */
function isDriverOutreach(e: AgentEvent): boolean {
  const evidence = evidenceOf(e);
  if (e.kind === "action") return DRIVER_MESSAGE_KINDS.has(String(evidence.kind));
  if (e.kind === "would_say") return DRIVER_MESSAGE_CHANNELS.has(String(evidence.channel));
  return false;
}

/** The customer's own delay note, as distinct from the escalation's
 *  dispatcher-facing email — that one also travels as a shadow `would_say`
 *  with `channel: "email"` but a DIFFERENT `to`. Matching on `to` is what
 *  keeps this from firing the moment the escalation itself is recorded. */
function isCustomerUpdateEvent(e: AgentEvent): boolean {
  const evidence = evidenceOf(e);
  if (e.kind === "email" && evidence.kind === "customer_delay") return true;
  return e.kind === "would_say" && evidence.to === DEMO_CUSTOMER_EMAIL;
}

interface InTransitAssignment {
  driverId: string;
  plannedStart: Date;
  plannedEnd: Date;
}

/** Fires once — `breakdownTriggeredAt` on the story guards the re-fire — and
 *  never advances `story.stage` itself: the story stays "in_transit" until
 *  Night Shift's own worker detects the stop. */
async function triggerBreakdown(orgId: string, story: DemoStory, assignment: InTransitAssignment, simNowMs: number, wallNowMs: number): Promise<Patch> {
  await freezeTruck(orgId, assignment.driverId);
  const stops = await prisma.loadStop.findMany({ where: { loadId: story.loadId! }, orderBy: { sequence: "asc" }, select: { sequence: true, lat: true, lng: true } });
  const point = positionAlong(stops, Math.min(1, planFraction(assignment, simNowMs)));
  return {
    breakdownTriggeredAt: new Date(wallNowMs),
    logTexts: [`Truck stopped unexpectedly near ${point ? nearestPlaceLabel(point) : "the route"}.`],
  };
}

export async function handleInTransit(orgId: string, story: DemoStory, simNowMs: number, wallNowMs: number): Promise<Patch | null> {
  if (!story.loadId) return null;
  const assignment = await prisma.assignment.findUnique({ where: { loadId: story.loadId } });
  if (!assignment) return null; // recordApproval always links one before this stage is reached

  if (assignment.status === "completed") {
    // The plan ran to its end before the breakdown could fire — the story
    // cannot be told from here, and waiting would only hide that.
    const error = "The load was delivered before the scripted breakdown could happen.";
    return { stage: "error", error, logTexts: [`${error} Reset the demo to run it again.`] };
  }
  if (assignment.status === "assigned") {
    // The runner starts due assignments on its own 1s clock; force it once
    // so a slow poll (or no live runner at all) never leaves the story
    // showing "in transit" against a plan that has not started. The started
    // plan is evaluated on the next poll, not this one.
    const neededMin = Math.max(1, Math.ceil((assignment.plannedStart.getTime() - simNowMs) / 60_000));
    await tick(orgId, neededMin, wallNowMs);
    return null;
  }

  if (!story.breakdownTriggeredAt) {
    if (planFraction(assignment, simNowMs) < story.breakdownAtFraction) return null;
    return triggerBreakdown(orgId, story, assignment, simNowMs, wallNowMs);
  }

  await holdPing(orgId, wallNowMs);
  const { events } = await tripsAndEvents(story.loadId);
  const stopEvent = latest(events, (e) => e.kind === "anomaly" && evidenceOf(e).kind === "unplanned_stop");
  const resolvedAfter = stopEvent && latest(events, (e) => isUnplannedStopResolved(e) && e.atMs > stopEvent.atMs);
  if (stopEvent && !resolvedAfter) {
    return { stage: "breakdown_detected", logTexts: ["Night Shift flagged the stop."] };
  }
  return null;
}

export async function handleBreakdownDetected(orgId: string, story: DemoStory, wallNowMs: number): Promise<Patch | null> {
  if (!story.loadId) return null;
  await holdPing(orgId, wallNowMs);
  const { events } = await tripsAndEvents(story.loadId);
  const contacted = latest(events, (e) => afterBreakdown(story, e) && isDriverOutreach(e));
  if (!contacted) return null;
  return { stage: "awaiting_driver_reply", logTexts: ["Night Shift messaged the driver and is waiting to hear back."] };
}

export async function handleAwaitingDriverReply(orgId: string, story: DemoStory, wallNowMs: number): Promise<Patch | null> {
  if (!story.loadId) return null;
  await holdPing(orgId, wallNowMs);
  const { events } = await tripsAndEvents(story.loadId);
  const escalation = latest(events, (e) => e.kind === "escalation" && afterBreakdown(story, e));
  if (!escalation) return null;
  const evidence = escalation.evidence as { reason?: string; draftAttached?: boolean };
  const reason = evidence.reason ?? "an unresolved issue";
  const text = evidence.draftAttached
    ? `Night Shift escalated: ${reason}; a customer update is proposed.`
    : `Night Shift escalated: ${reason}; no customer update was proposed (deadline not at risk).`;
  return { stage: "awaiting_customer_update", logTexts: [text] };
}

export async function handleAwaitingCustomerUpdate(orgId: string, story: DemoStory, wallNowMs: number): Promise<Patch | null> {
  if (!story.loadId || !story.driverId) return null;
  await holdPing(orgId, wallNowMs);
  const { events } = await tripsAndEvents(story.loadId);
  const updated = latest(events, (e) => afterBreakdown(story, e) && isCustomerUpdateEvent(e));
  if (!updated) return null;

  await releaseTruck(orgId, story.driverId);
  return {
    stage: "customer_updated",
    logTexts: [
      "Customer update sent to the demo sink (shadow mode — no email left the system).",
      "Truck moving again.",
    ],
  };
}

/** The truck is moving under the runner here; the approach guard keeps the
 *  runner from carrying it past the last tenth of the plan while the story
 *  waits for Night Shift to see the stop clear. */
export async function handleCustomerUpdated(orgId: string, story: DemoStory, simNowMs: number, wallNowMs: number): Promise<Patch | null> {
  if (!story.loadId) return null;
  const { events } = await tripsAndEvents(story.loadId);
  const resolvedEvent = latest(events, (e) => afterBreakdown(story, e) && isUnplannedStopResolved(e));
  if (resolvedEvent) return { stage: "resolved", logTexts: ["Truck confirmed moving normally again."] };

  if (wallNowMs - story.updatedAt.getTime() >= RESOLVE_FALLBACK_MS) {
    return { stage: "resolved", logTexts: ["No new issues after a few minutes — treating the truck as back on schedule."] };
  }
  await guardApproach(orgId, story.loadId, simNowMs);
  return null;
}
