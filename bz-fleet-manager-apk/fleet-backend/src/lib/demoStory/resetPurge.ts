import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import type { Actor } from "../loadWriter.js";
import { applyAgentSwitch } from "../agentSwitch.js";
import { cancelRun } from "../aiHarness/runner.js";
import { stopRunner } from "../simulation/runner.js";
import { DEMO_HIST_PREFIX, DEMO_LOAD_REF, demoDriverEmail } from "./fixtures.js";

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
 *  switch-off then queues the one `stop` this reset means.
 *
 *  An unapplied `stop` is the ONE row this deletes NOTHING of (finding I1): a
 *  Reset from a live demo queues that `stop` and leaves the load switched
 *  off, so a second Reset moments later would see `agentEnabled: false` and
 *  queue no replacement (`switchAgentOffIfOn` below is a no-op on an
 *  already-off load) — deleting the pending `stop` here would leave the
 *  worker's previous in-memory trip with nothing left to end it. Every OTHER
 *  command row — every other kind, and every already-`stop`-but-applied row
 *  too (finding M8: applied rows used to be the only ones that survived a
 *  Reset) — is purged unconditionally, so Reset never grows a permanent
 *  command-history leftover. */
async function purgeLocksAndStaleCommands(loadId: string): Promise<void> {
  await prisma.$transaction([
    prisma.loadLock.deleteMany({ where: { loadId } }),
    prisma.agentCommand.deleteMany({ where: { loadId, NOT: { kind: "stop", appliedAt: null } } }),
  ]);
}

const TIMELINE_PURGE_MAX_ATTEMPTS = 3;

function isForeignKeyViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003";
}

/** AiDecisionRecord/AgentEvent/AgentTrip/AgentUpdate/LoadChange — everything
 *  Night Shift and the AI harness wrote against this one load. AiRunStep
 *  cascades with its AiDecisionRecord; AgentEvent does NOT cascade with its
 *  AgentTrip (schema has no `onDelete`), so it is cleared first.
 *
 *  A live worker can still be appending `AgentEvent` rows (a ping every few
 *  seconds during the demo) against a trip this same call is about to
 *  delete — an insert landing between the two deletes below makes the
 *  `AgentTrip` delete violate that FK and the transaction rejects with
 *  Prisma's P2003 (finding M4). Retried a bounded number of times, re-reading
 *  the trip ids fresh on each attempt (the worker's own insert already
 *  committed by the time this retries, so the next attempt's read sees it);
 *  a failure that outlives every attempt still throws — the caller (reset.ts,
 *  via the route) already maps an unexpected error to a plain 500. */
async function purgeLoadTimelineOnce(loadId: string): Promise<void> {
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

async function purgeLoadTimeline(loadId: string): Promise<void> {
  for (let attempt = 1; attempt <= TIMELINE_PURGE_MAX_ATTEMPTS; attempt++) {
    try {
      await purgeLoadTimelineOnce(loadId);
      return;
    } catch (err) {
      if (!isForeignKeyViolation(err) || attempt === TIMELINE_PURGE_MAX_ATTEMPTS) throw err;
    }
  }
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

/** The ids to purge: the story's own `loadId`/`driverId` when the row is
 *  there, otherwise the same fixture identities `fixturesDemoLoad.ts` and
 *  `fixtures.ts` upsert by — `orgId_externalId: DEMO_LOAD_REF` for the load,
 *  `demoDriverEmail(orgId)` for the driver (finding M3). Keying the purge
 *  off the `DemoStory` row alone meant a missing/deleted row (however that
 *  happened) left `upsertDemoLoad` rebuilding the SAME load row in place
 *  with the previous run's Assignment, Rate, trips and locks still attached
 *  — exactly the P2002 → 409 class fix round 3 already chased down once. */
async function idsToPurge(orgId: string, story: { loadId: string | null; driverId: string | null } | null): Promise<{ loadId: string | null; driverId: string | null }> {
  const loadId = story?.loadId ?? (await prisma.load.findUnique({ where: { orgId_externalId: { orgId, externalId: DEMO_LOAD_REF } }, select: { id: true } }))?.id ?? null;
  const driverId = story?.driverId ?? (await prisma.driver.findUnique({ where: { email: demoDriverEmail(orgId) }, select: { id: true } }))?.id ?? null;
  return { loadId, driverId };
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

  const { loadId, driverId } = await idsToPurge(orgId, story);
  if (loadId) {
    await purgeLocksAndStaleCommands(loadId);
    await switchAgentOffIfOn(orgId, loadId, actor);
    await purgeLoadTimeline(loadId);
    await purgeAssignmentFor(loadId);
  }
  if (driverId) await purgeDriverSimTraces(driverId);

  await purgeHistoricalLoads(orgId);
}
