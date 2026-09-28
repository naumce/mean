import { prisma } from "../../db.js";
import type { Actor } from "../loadWriter.js";
import { applyAgentSwitch } from "../agentSwitch.js";
import { cancelRun } from "../aiHarness/runner.js";
import { stopRunner } from "../simulation/runner.js";
import { DEMO_HIST_PREFIX } from "./fixtures.js";

// Demo Mode: tears down whatever the story left behind before fixtures.ts
// rebuilds it, so Reset is total and idempotent from ANY prior state — a
// running sim, a live Night Shift trip, a queued/running AI run, an
// in-progress assignment (and its Rate pricing snapshot, which outlives it),
// a load lock. Every group below is its own small transaction, not one giant
// one — a failure in one group must not leave an earlier one half-undone.

/** Everything the commit transaction (dispatcherAssignments.ts, POST
 *  /assignments) writes against ONE load: DispatchConflict, the Rate pricing
 *  snapshot, and the Assignment itself (+ its DeadheadLeg, which does not
 *  cascade off it — deleted first, in the same transaction). HosState is not
 *  this function's job: fixtures.ts upserts it back to full hours on every
 *  reset regardless of prior state.
 *
 *  Rate.loadId is its own @id with NO relation to Assignment.id, so deleting
 *  the Assignment never removes it — confirmed by incident: the demo load
 *  keeps its row id across resets, so a Rate left behind here made the next
 *  run's `tx.rate.create` collide on that same id (Prisma P2002), which
 *  lib/writeConflict.ts maps straight to a 409 the dispatcher cannot retry
 *  past. Deleted unconditionally, before the Assignment lookup below, so it
 *  is gone even on a load whose Assignment was already removed by some other
 *  path. */
async function purgeAssignmentFor(loadId: string): Promise<void> {
  await prisma.dispatchConflict.deleteMany({ where: { loadId } });
  await prisma.rate.deleteMany({ where: { loadId } });
  const assignment = await prisma.assignment.findUnique({ where: { loadId }, select: { id: true } });
  if (!assignment) return;
  await prisma.$transaction([
    prisma.deadheadLeg.deleteMany({ where: { assignmentId: assignment.id } }),
    prisma.assignment.delete({ where: { id: assignment.id } }),
  ]);
}

/** Runs BEFORE the agent is switched off: a lock held by another dispatcher
 *  would make the switch-off refuse (the writer's gate refuses system writes
 *  too), and a stale unapplied command from the previous run (a `reply`, a
 *  `send_customer_email`) must not be applied to the next run's trip. The
 *  switch-off then queues the one `stop` this reset means. */
async function purgeLocksAndStaleCommands(loadId: string): Promise<void> {
  await prisma.$transaction([
    prisma.loadLock.deleteMany({ where: { loadId } }),
    prisma.agentCommand.deleteMany({ where: { loadId, appliedAt: null } }),
  ]);
}

/** AiDecisionRecord/AgentEvent/AgentTrip/AgentUpdate/LoadChange — everything
 *  Night Shift and the AI harness wrote against this one load. AiRunStep
 *  cascades with its AiDecisionRecord; AgentEvent does NOT cascade with its
 *  AgentTrip (schema has no `onDelete`), so it is cleared first. */
async function purgeLoadTimeline(loadId: string): Promise<void> {
  const trips = await prisma.agentTrip.findMany({ where: { loadId }, select: { id: true } });
  const tripIds = trips.map((t) => t.id);
  await prisma.$transaction([
    prisma.aiDecisionRecord.deleteMany({ where: { loadId } }),
    prisma.agentEvent.deleteMany({ where: { tripId: { in: tripIds } } }),
    prisma.agentTrip.deleteMany({ where: { loadId } }),
    prisma.agentUpdate.deleteMany({ where: { loadId } }),
    prisma.loadChange.deleteMany({ where: { loadId } }),
  ]);
}

async function purgeDriverSimTraces(driverId: string): Promise<void> {
  await prisma.$transaction([
    prisma.driverLocation.deleteMany({ where: { driverId } }),
    prisma.simDriverState.deleteMany({ where: { driverId } }),
  ]);
}

/** The ten historical loads are recreated, not updated in place — delete
 *  each one in full: its assignment (+ deadhead legs), its stops and their
 *  appointments (neither cascades off Load), then the load itself. */
async function purgeHistoricalLoads(orgId: string): Promise<void> {
  const loads = await prisma.load.findMany({ where: { orgId, externalId: { startsWith: DEMO_HIST_PREFIX } }, select: { id: true } });
  const loadIds = loads.map((l) => l.id);
  if (loadIds.length === 0) return;

  const assignments = await prisma.assignment.findMany({ where: { loadId: { in: loadIds } }, select: { id: true } });
  const assignmentIds = assignments.map((a) => a.id);
  const stops = await prisma.loadStop.findMany({ where: { loadId: { in: loadIds } }, select: { id: true } });
  const stopIds = stops.map((s) => s.id);

  await prisma.$transaction([
    prisma.deadheadLeg.deleteMany({ where: { assignmentId: { in: assignmentIds } } }),
    prisma.dispatchConflict.deleteMany({ where: { loadId: { in: loadIds } } }),
    prisma.assignment.deleteMany({ where: { loadId: { in: loadIds } } }),
    prisma.appointment.deleteMany({ where: { stopId: { in: stopIds } } }),
    prisma.loadStop.deleteMany({ where: { loadId: { in: loadIds } } }),
    prisma.load.deleteMany({ where: { id: { in: loadIds } } }),
  ]);
}

/** Switches the demo load's agent off through the real service (queues the
 *  worker's own `stop` command, same as a dispatcher's own toggle) — never a
 *  direct `Load.agentEnabled` write. Best-effort: a version conflict on a
 *  load mid-edit by a stray test fixture must not fail the whole reset. */
async function switchAgentOffIfOn(orgId: string, loadId: string, actor: Actor): Promise<void> {
  const load = await prisma.load.findUnique({ where: { id: loadId }, select: { id: true, agentEnabled: true } });
  if (!load?.agentEnabled) return;
  try {
    await prisma.$transaction((tx) => applyAgentSwitch(tx, { loadId: load.id, orgId, actor, source: "system", enabled: false }));
  } catch (err) {
    console.warn(`demo reset: could not switch the agent off for load ${load.id}`, err);
  }
}

/**
 * Total, idempotent teardown. Safe to call for an org that has never had a
 * demo story at all — every step below is a no-op against rows that do not
 * exist.
 */
export async function purgeDemoStory(orgId: string, actor: Actor): Promise<void> {
  stopRunner(orgId);

  const story = await prisma.demoStory.findUnique({ where: { orgId } });
  if (story?.runId) {
    // A stale/unknown runId (this process never owned it, or it already
    // finished) must not fail reset — cancelRun itself never throws, but a
    // defensive catch keeps a future change to that contract from becoming
    // a reset outage.
    await cancelRun(orgId, story.runId).catch((err: unknown) => console.warn(`demo reset: cancelRun failed for ${story.runId}`, err));
  }
  if (story?.loadId) {
    await purgeLocksAndStaleCommands(story.loadId);
    await switchAgentOffIfOn(orgId, story.loadId, actor);
    await purgeLoadTimeline(story.loadId);
    await purgeAssignmentFor(story.loadId);
  }
  if (story?.driverId) await purgeDriverSimTraces(story.driverId);

  await purgeHistoricalLoads(orgId);
}
