import type { DemoStory } from "@prisma/client";
import { prisma } from "../../db.js";
import { enqueueRun } from "../aiHarness/runner.js";
import { harnessEnabled } from "../aiHarness/config.js";
import { InvalidAction, NightShiftReleasing, WorkerUnavailable, WrongStage } from "./types.js";
import { pendingStops, switchAgentOff, switchAgentOn } from "./agentGate.js";
import { currentSimNowMs } from "./observe.js";
import { completeDelivery } from "./observeDelivery.js";
import { withOrgLock } from "./orgLock.js";
import { applyPatch } from "./patch.js";
import { releaseTruck } from "./truck.js";

// Demo Mode: human-triggered transitions, each guarded to the stage it makes
// sense from. Every one of these "records + triggers" — the business write
// itself (an assignment, the agent switch, the customer email) already
// happened through the portal's own existing endpoint or Night Shift's own
// worker; nothing here duplicates that write. Every exported action takes
// the org's turn (orgLock.ts), so it never interleaves with a poll.

const DELIVERY_WINDOW_MS = 3.5 * 60 * 60_000;
const WORKER_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEZONE = "America/Chicago";

async function requireStage(orgId: string, allowed: readonly string[]): Promise<DemoStory> {
  const story = await prisma.demoStory.findUnique({ where: { orgId } });
  if (!story || !allowed.includes(story.stage)) throw new WrongStage(story?.stage ?? "uncovered");
  return story;
}

async function driverName(driverId: string | null): Promise<string> {
  const driver = driverId ? await prisma.driver.findUnique({ where: { id: driverId }, select: { name: true } }) : null;
  return driver?.name ?? "Driver";
}

/** The narration quotes the driver by first name (`John: "…"`), whoever the
 *  assignment named. */
async function driverFirstName(driverId: string | null): Promise<string> {
  return (await driverName(driverId)).split(/\s+/)[0] ?? "Driver";
}

/** "HH:MM" in the org's own timezone (Org.timezone), the clock the presenter
 *  and the customer share. */
function clockLabel(at: Date, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = { hourCycle: "h23", hour: "2-digit", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: DEFAULT_TIMEZONE }).format(at);
  }
}

/** The delivery window is tightened HERE — after the assignment exists,
 *  before the agent is switched on — and not at reset. Night Shift measures
 *  its ETA in wall time (now + remaining miles at planned pace) and judges it
 *  against this appointment, while the simulation fast-forwards the truck:
 *  any window set at reset, tight or not, has stopped being at risk by the
 *  time the truck has covered most of the plan in minutes of real time, and
 *  the assignment endpoint's own feasibility guard would refuse a window this
 *  tight anyway. Set now, the worker's very first ETA (the truck has barely
 *  left Chicago when it stops) already misses it, so the escalation carries
 *  a customer draft. */
async function tightenDeliveryWindow(orgId: string, loadId: string, wallNowMs: number): Promise<string> {
  const windowEnd = new Date(wallNowMs + DELIVERY_WINDOW_MS);
  const deliveryStop = await prisma.loadStop.findFirst({ where: { loadId, type: "delivery" }, select: { appointment: { select: { id: true } } } });
  if (deliveryStop?.appointment) {
    await prisma.appointment.update({ where: { id: deliveryStop.appointment.id }, data: { windowStart: null, windowEnd } });
  }
  const org = await prisma.org.findUnique({ where: { id: orgId }, select: { timezone: true } });
  return `Tight customer window: delivery due by ${clockLabel(windowEnd, org?.timezone ?? DEFAULT_TIMEZONE)}.`;
}

/** `uncovered -> ai_recommendation`. Enqueues the real harness run when it is
 *  configured; otherwise leaves `runId` null so observeStory's own
 *  `ai_recommendation` heartbeat goes straight to the suggestForLoad fallback
 *  on its very next poll. */
async function askAiUnlocked(orgId: string, dispatcherId: string | null): Promise<DemoStory> {
  const story = await requireStage(orgId, ["uncovered"]);
  if (!story.loadId || !story.experimentId) throw new InvalidAction("The demo story has no load to ask about — reset the demo first.");

  let runId: string | null = null;
  if (harnessEnabled()) {
    const result = await enqueueRun({ orgId, experimentId: story.experimentId, loadId: story.loadId, requestedById: dispatcherId });
    if (!("error" in result)) runId = result.runId;
  }

  return applyPatch(orgId, story, { stage: "ai_recommendation", runId, logTexts: ["Asking AI for a recommendation."] });
}

/** `awaiting_approval -> in_transit`. The assignment itself is verified, not
 *  created — a human already booked it through the portal's real
 *  POST /dispatcher/assignments. Whoever that assignment names becomes the
 *  story's driver from here on (the scripted stop, the release, the purge all
 *  follow the assignment's driver, not the fixture's). */
async function recordApprovalUnlocked(orgId: string, args: { assignmentId: string; driverId: string }): Promise<DemoStory> {
  const story = await requireStage(orgId, ["awaiting_approval"]);
  if (!story.loadId) throw new WrongStage(story.stage);

  const assignment = await prisma.assignment.findUnique({ where: { id: args.assignmentId } });
  if (!assignment || assignment.orgId !== orgId || assignment.loadId !== story.loadId || assignment.driverId !== args.driverId) {
    throw new InvalidAction(`Assignment ${args.assignmentId} does not match this demo load and driver.`);
  }

  // The previous reset's `stop` must reach the worker before this run is
  // switched on (agentGate.ts): refuse while it is fresh, discard it once it
  // is old enough to belong to a worker with nothing left to stop.
  const wallNowMs = Date.now();
  const stops = await pendingStops(story.loadId, wallNowMs);
  if (stops.fresh.length > 0) throw new NightShiftReleasing();
  if (stops.stale.length > 0) await prisma.agentCommand.deleteMany({ where: { id: { in: stops.stale } } });

  // Mirrors POST /ai/runs/:id/decision's own write (dispatcherAiRuns.ts)
  // directly, rather than an HTTP call to itself — same fields, same
  // allow-list of statuses a verdict makes sense against.
  if (story.runId) {
    const run = await prisma.aiDecisionRecord.findUnique({ where: { id: story.runId }, select: { status: true } });
    if (run && ["proposed", "incomplete", "failed"].includes(run.status)) {
      await prisma.aiDecisionRecord.update({
        where: { id: story.runId },
        data: { humanDecision: { verdict: "accept", driverId: assignment.driverId, note: null, byDispatcherId: null }, decidedAt: new Date() },
      });
    }
  }

  const windowText = await tightenDeliveryWindow(orgId, story.loadId, wallNowMs);
  await switchAgentOn(orgId, story.loadId, story.policyId);
  await releaseTruck(orgId, assignment.driverId);

  const name = await driverName(assignment.driverId);
  return applyPatch(orgId, story, {
    stage: "in_transit",
    assignmentId: assignment.id,
    driverId: assignment.driverId,
    logTexts: [`Approved: ${name} assigned. Night Shift is watching this load.`, windowText],
  });
}

/** Proxies to the worker's real driver-link endpoint, the token coming off
 *  the load's newest AgentTrip. Never changes `story.stage` — Night Shift's
 *  own reaction (a canned reply, an immediate escalation on a breakdown
 *  reply) is what observeStory's `awaiting_driver_reply` heartbeat picks up
 *  on its next poll. Anything but a 2xx from the worker means the reply did
 *  not land: nothing is logged as sent. */
async function driverReplyUnlocked(orgId: string, text: string): Promise<DemoStory> {
  const story = await requireStage(orgId, ["awaiting_driver_reply"]);
  const workerUrl = process.env.WORKER_URL;
  if (!workerUrl) throw new WorkerUnavailable("WORKER_URL is not configured — nothing to send the reply to.");

  const trip = story.loadId ? await prisma.agentTrip.findFirst({ where: { loadId: story.loadId }, orderBy: { createdAt: "desc" } }) : null;
  if (!trip) throw new WorkerUnavailable("No active Night Shift trip for this load yet.");

  let res: Response;
  try {
    res = await fetch(`${workerUrl}/d/${encodeURIComponent(trip.driverToken)}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
    });
  } catch (err) {
    throw new WorkerUnavailable(`The worker could not be reached (${err instanceof Error ? err.message : "no response in time"}).`);
  }
  if (!res.ok) throw new WorkerUnavailable(`The worker refused the reply (HTTP ${res.status}).`);

  const name = await driverFirstName(story.driverId);
  return applyPatch(orgId, story, { logTexts: [`${name}: "${text}"`] });
}

/** `awaiting_customer_update -> customer_updated`. The email itself already
 *  went out (in shadow, as a `would_say`) through the portal's real
 *  send_customer_email command — this only records that the human did it and
 *  gets the truck moving again, same as observeStory's own automatic
 *  detection of that same event would. */
async function recordCustomerUpdateUnlocked(orgId: string): Promise<DemoStory> {
  const story = await requireStage(orgId, ["awaiting_customer_update"]);
  if (story.driverId) await releaseTruck(orgId, story.driverId);
  return applyPatch(orgId, story, {
    stage: "customer_updated",
    logTexts: [
      "Customer update sent to the demo sink (shadow mode — no email left the system).",
      "Truck moving again.",
    ],
  });
}

/** A dispatcher's own shortcut past `awaiting_customer_update` (no draft was
 *  attached — nothing to send) or `customer_updated` (skip the automatic
 *  resolved-event/3-min wait). Calling it again once resolved changes
 *  nothing: the truck is already moving. */
async function resolveUnlocked(orgId: string): Promise<DemoStory> {
  const story = await requireStage(orgId, ["awaiting_customer_update", "customer_updated", "resolved"]);
  if (story.stage === "resolved") return story;
  if (story.driverId) await releaseTruck(orgId, story.driverId);
  return applyPatch(orgId, story, { stage: "resolved", logTexts: ["Marked resolved by the dispatcher."] });
}

/** `delivering -> delivered`, on the dispatcher's word rather than waiting
 *  for the arrival event or the 7-minute timeout. The assignment is verified
 *  BEFORE the agent is switched off (finding F11/M11): switching first and
 *  then finding no assignment left Night Shift off (and a `stop` queued)
 *  under a 409 the caller cannot recover cleanly from. */
async function skipArrivalUnlocked(orgId: string): Promise<DemoStory> {
  const story = await requireStage(orgId, ["delivering"]);
  if (!story.loadId) throw new WrongStage(story.stage);

  const assignment = await prisma.assignment.findUnique({ where: { loadId: story.loadId } });
  if (!assignment) throw new WrongStage(story.stage);

  await switchAgentOff(orgId, story.loadId);

  const wallNowMs = Date.now();
  const simNowMs = await currentSimNowMs(orgId, wallNowMs);
  const patch = await completeDelivery(orgId, assignment, simNowMs, wallNowMs, false);
  return applyPatch(orgId, story, patch);
}

/** For stages with no pending human action, the obvious automatic step — so
 *  an "Auto-run" presenter mode can drive the story with one call regardless
 *  of stage. Every other stage either needs data Auto-run cannot fabricate
 *  (an assignment, driver text) or is already moving on its own via
 *  observeStory, so it 409s here rather than guessing. */
async function nextUnlocked(orgId: string, dispatcherId: string | null): Promise<DemoStory> {
  const story = await prisma.demoStory.findUnique({ where: { orgId } });
  if (!story) throw new WrongStage("uncovered");
  if (story.stage === "uncovered") return askAiUnlocked(orgId, dispatcherId);
  if (story.stage === "customer_updated") return resolveUnlocked(orgId);
  throw new WrongStage(story.stage);
}

export const askAi = (orgId: string, dispatcherId: string | null): Promise<DemoStory> =>
  withOrgLock(orgId, () => askAiUnlocked(orgId, dispatcherId));
export const recordApproval = (orgId: string, args: { assignmentId: string; driverId: string }): Promise<DemoStory> =>
  withOrgLock(orgId, () => recordApprovalUnlocked(orgId, args));
export const driverReply = (orgId: string, text: string): Promise<DemoStory> =>
  withOrgLock(orgId, () => driverReplyUnlocked(orgId, text));
export const recordCustomerUpdate = (orgId: string): Promise<DemoStory> =>
  withOrgLock(orgId, () => recordCustomerUpdateUnlocked(orgId));
export const resolve = (orgId: string): Promise<DemoStory> =>
  withOrgLock(orgId, () => resolveUnlocked(orgId));
export const skipArrival = (orgId: string): Promise<DemoStory> =>
  withOrgLock(orgId, () => skipArrivalUnlocked(orgId));
export const next = (orgId: string, dispatcherId: string | null): Promise<DemoStory> =>
  withOrgLock(orgId, () => nextUnlocked(orgId, dispatcherId));
