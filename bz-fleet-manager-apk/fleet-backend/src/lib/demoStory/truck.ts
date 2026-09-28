import { prisma } from "../../db.js";
import { tick } from "../simulation/engine.js";
import { startRunnerAndPersist, stopRunnerAndPersist } from "./runnerPersist.js";

// Demo Mode: the story's only hands on the simulation. The runner
// (lib/simulation/runner.ts) moves the truck at RUNNER_SPEED simulated
// minutes per real second. Whenever the story needs the truck to stand still
// — the scripted breakdown, the approach to the dock, the dock hold — the
// runner is stopped and the observe heartbeat drives the engine itself:
// during the breakdown `tick(orgId, 0)` writes one engine-shaped ping without
// moving the clock (a stationary truck reporting in, which is what Night
// Shift's stop rule needs to see) and `tick(orgId, n)` moves the plan by
// exactly n minutes on the approach; the dock hold writes its own ping at the
// delivery stop (observeDelivery.ts) and never touches the engine, because
// the engine clock follows wall time and a tick there could deliver the load
// out from under the story.

export const RUNNER_SPEED = 3;

export type DriverMode = "auto" | "stopped";

export async function setDriverMode(driverId: string, mode: DriverMode): Promise<void> {
  await prisma.simDriverState.upsert({
    where: { driverId },
    update: { mode, modeUntil: null, offsetLat: 0, offsetLng: 0 },
    create: { driverId, mode },
  });
}

/** The truck stands still: the runner stops so the plan's clock cannot run
 *  past the truck, and the driver's sim mode re-pings the last known point. */
export async function freezeTruck(orgId: string, driverId: string): Promise<void> {
  await stopRunnerAndPersist(orgId);
  await setDriverMode(driverId, "stopped");
}

/** The truck moves again under the runner's clock. */
export async function releaseTruck(orgId: string, driverId: string): Promise<void> {
  await setDriverMode(driverId, "auto");
  await startRunnerAndPersist(orgId, RUNNER_SPEED);
}

/** One ping through the engine, no clock advance: with the driver's mode
 *  "stopped" it lands on the last known point — the breakdown site. */
export async function holdPing(orgId: string, wallNowMs: number): Promise<void> {
  await tick(orgId, 0, wallNowMs);
}

export interface PlanWindow {
  plannedStart: Date;
  plannedEnd: Date;
}

/** How far through its plan (plannedStart..plannedEnd) the truck is at
 *  `simNowMs`. Not clamped: a value past 1 means the plan has already
 *  elapsed. */
export function planFraction(plan: PlanWindow, simNowMs: number): number {
  const span = plan.plannedEnd.getTime() - plan.plannedStart.getTime();
  return span <= 0 ? 1 : (simNowMs - plan.plannedStart.getTime()) / span;
}
