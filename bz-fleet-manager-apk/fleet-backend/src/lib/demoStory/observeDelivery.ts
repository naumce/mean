import type { AgentEvent, DemoStory } from "@prisma/client";
import { prisma } from "../../db.js";
import { tick } from "../simulation/engine.js";
import { emitToDispatchers } from "../../realtime.js";
import { switchAgentOff } from "./agentGate.js";
import { evidenceOf, latest, tripsAndEvents } from "./observeEvents.js";
import { stopRunnerAndPersist } from "./runnerPersist.js";
import { planFraction, setDriverMode, type PlanWindow } from "./truck.js";
import type { Patch } from "./types.js";

// Demo Mode: the last miles and the dock. The runner would cover the final
// tenth of the plan in seconds and the engine would complete the assignment
// the instant `plannedEnd` fell behind the clock — before Night Shift (whose
// arrival rule wants five real minutes of pings within half a mile of the
// dock) could ever record an arrival. So:
//   1. At APPROACH_FRACTION the runner stops and each poll moves the truck by
//      APPROACH_STEP_MIN minutes through the engine, until the plan has only
//      DOCK_BUDGET_MIN minutes left. The budget is in plan minutes, not a
//      fraction: the engine's clock is `wall + advanced`, so it keeps moving
//      one plan-minute per real minute while the truck stands on the dock,
//      and the budget must outlast the whole hold plus a margin.
//   2. The truck is parked on the dock: the driver's mode goes to "stopped"
//      (so a stray engine tick re-pings the dock rather than the road) and
//      every poll of the hold writes one ping itself at the delivery stop's
//      exact coordinates — engine shape, engine emit, no engine call, so
//      nothing evaluates `plannedEnd` while the truck waits.
//   3. The hold ends on Night Shift's `arrived` action, on the dispatcher's
//      skip, or after ARRIVAL_WAIT_MS — in which case the agent is switched
//      off first so the trip cannot outlive the load. Completion is one
//      `tick` across `plannedEnd`; a tick the engine had to skip (a lock, a
//      version conflict) leaves the story on "delivering" to try again on the
//      next poll, telling the presenter once. Should the engine ever complete
//      the assignment by itself, the same switch-off applies unless Night
//      Shift had already recorded the arrival.

const APPROACH_FRACTION = 0.9;
const APPROACH_STEP_MIN = 5;
const ARRIVAL_WAIT_MS = 7 * 60_000;
const DOCK_BUDGET_MIN = ARRIVAL_WAIT_MS / 60_000 + 3;

const DELIVERED_CLEAN_TEXT = "Delivered. Night Shift recorded the arrival.";
const DELIVERED_SKIPPED_TEXT = "Delivered (arrival wait skipped).";
const DELIVERY_RETRY_TEXT = "The delivery is taking a moment longer to record — trying again.";

interface DeliveryAssignment extends PlanWindow {
  id: string;
  driverId: string;
}

function isArrival(e: AgentEvent): boolean {
  return e.kind === "action" && evidenceOf(e).kind === "arrived";
}

/** Stops the runner once the truck is within the last tenth of its plan, so
 *  the engine can never complete the assignment on the runner's clock. */
export async function guardApproach(orgId: string, loadId: string, simNowMs: number): Promise<void> {
  const assignment = await prisma.assignment.findUnique({ where: { loadId }, select: { status: true, plannedStart: true, plannedEnd: true } });
  if (!assignment || assignment.status !== "in_progress") return;
  if (planFraction(assignment, simNowMs) >= APPROACH_FRACTION) await stopRunnerAndPersist(orgId);
}

/** The minutes one approach poll may move the plan: APPROACH_STEP_MIN, or
 *  less so that DOCK_BUDGET_MIN plan-minutes always remain. Zero means the
 *  truck is as close as the budget allows — time to park. */
function approachStepMin(assignment: PlanWindow, simNowMs: number): number {
  const remainingMin = (assignment.plannedEnd.getTime() - simNowMs) / 60_000;
  if (remainingMin <= DOCK_BUDGET_MIN + 1) return 0;
  return Math.min(APPROACH_STEP_MIN, Math.floor(remainingMin - DOCK_BUDGET_MIN));
}

/** Writes exactly one ping at the delivery stop, copying `engine.ts`'s own
 *  write byte-for-byte — same rows, same emit shape — without calling the
 *  engine. */
async function writeDockPing(orgId: string, loadId: string, driverId: string, wallNowMs: number): Promise<void> {
  const deliveryStop = await prisma.loadStop.findFirst({ where: { loadId, type: "delivery" }, orderBy: { sequence: "desc" }, select: { lat: true, lng: true } });
  if (deliveryStop?.lat == null || deliveryStop?.lng == null) return; // the demo load's delivery stop is always geocoded

  const driver = await prisma.driver.findUnique({ where: { id: driverId }, select: { name: true } });
  const [loc] = await prisma.$transaction([
    prisma.driverLocation.create({ data: { driverId, latitude: deliveryStop.lat, longitude: deliveryStop.lng } }),
    prisma.driver.update({ where: { id: driverId }, data: { lastLat: deliveryStop.lat, lastLng: deliveryStop.lng, lastLocationAt: new Date(wallNowMs) } }),
  ]);

  emitToDispatchers(orgId, "driver_location", {
    driverId, driverName: driver?.name ?? "", latitude: deliveryStop.lat, longitude: deliveryStop.lng, at: loc.createdAt.toISOString(),
  });
}

/** The engine completed the assignment on its own. Delivered either way; if
 *  Night Shift never saw it arrive, its trip is ended through the switch and
 *  the presenter is told the wait was skipped. */
async function deliveredByEngine(orgId: string, loadId: string): Promise<Patch> {
  const { events } = await tripsAndEvents(loadId);
  const arrived = latest(events, isArrival) != null;
  if (!arrived) await switchAgentOff(orgId, loadId);
  return { stage: "delivered", holdStartedAt: null, logTexts: [arrived ? DELIVERED_CLEAN_TEXT : DELIVERED_SKIPPED_TEXT] };
}

/** One `tick` across `plannedEnd` so the engine's own transition completes
 *  the assignment (load `delivered`, completion ping at the dock). Shared by
 *  the arrival event, the timeout and the dispatcher's skip. */
export async function completeDelivery(orgId: string, assignment: DeliveryAssignment, simNowMs: number, wallNowMs: number, clean: boolean): Promise<Patch> {
  const remainingMin = Math.max(1, Math.ceil((assignment.plannedEnd.getTime() - simNowMs) / 60_000));
  const result = await tick(orgId, remainingMin, wallNowMs);
  const fresh = await prisma.assignment.findUnique({ where: { id: assignment.id }, select: { status: true } });
  if (result.skipped > 0 || fresh?.status !== "completed") {
    console.warn(`demo story: the delivery tick did not complete the assignment for org ${orgId} (skipped ${result.skipped}, status ${fresh?.status ?? "gone"}) — retrying on the next poll`);
    return { logTexts: [DELIVERY_RETRY_TEXT] };
  }
  await setDriverMode(assignment.driverId, "auto");
  return { stage: "delivered", holdStartedAt: null, logTexts: [clean ? DELIVERED_CLEAN_TEXT : DELIVERED_SKIPPED_TEXT] };
}

export async function handleResolved(orgId: string, story: DemoStory, simNowMs: number, wallNowMs: number): Promise<Patch | null> {
  if (!story.loadId) return null;
  const assignment = await prisma.assignment.findUnique({ where: { loadId: story.loadId } });
  if (!assignment) return null;
  if (assignment.status === "completed") return deliveredByEngine(orgId, story.loadId);
  if (assignment.status !== "in_progress") return null;

  if (planFraction(assignment, simNowMs) < APPROACH_FRACTION) return null; // the runner is still driving

  await stopRunnerAndPersist(orgId);
  const step = approachStepMin(assignment, simNowMs);
  if (step >= 1) {
    await tick(orgId, step, wallNowMs);
    return null;
  }

  await setDriverMode(assignment.driverId, "stopped");
  await writeDockPing(orgId, story.loadId, assignment.driverId, wallNowMs);
  return { stage: "delivering", holdStartedAt: new Date(wallNowMs) };
}

export async function handleDelivering(orgId: string, story: DemoStory, simNowMs: number, wallNowMs: number): Promise<Patch | null> {
  if (!story.loadId) return null;
  const assignment = await prisma.assignment.findUnique({ where: { loadId: story.loadId } });
  if (!assignment) return null;
  if (assignment.status === "completed") return deliveredByEngine(orgId, story.loadId);

  const { events } = await tripsAndEvents(story.loadId);
  const arrived = latest(events, isArrival) != null;
  const waitedLongEnough = story.holdStartedAt != null && wallNowMs - story.holdStartedAt.getTime() >= ARRIVAL_WAIT_MS;

  if (!arrived && !waitedLongEnough) {
    await writeDockPing(orgId, story.loadId, assignment.driverId, wallNowMs);
    return null; // still on the dock — one more ping written, nothing to narrate
  }

  if (!arrived) await switchAgentOff(orgId, story.loadId);
  return completeDelivery(orgId, assignment, simNowMs, wallNowMs, arrived);
}
