import type { AgentEvent } from "@prisma/client";
import { prisma } from "../../db.js";

// Demo Mode: the one place the observe modules read Night Shift's own
// AgentTrip/AgentEvent rows — same fetch shape as `lib/agentTimeline.ts`
// (trips for the load, then events for those trips), bounded to one load.
// Split out so the observe modules can all use it without importing each
// other.

export interface TripsAndEvents {
  events: AgentEvent[];
  /** Every trip this load has ever had, oldest first — a purge miss can
   *  leave a stale leftover trip from a previous run sitting alongside the
   *  current one (`newestTripStartMs` below is what tells them apart). */
  trips: { id: string; createdAt: Date }[];
}

export async function tripsAndEvents(loadId: string): Promise<TripsAndEvents> {
  const trips = await prisma.agentTrip.findMany({ where: { loadId }, select: { id: true, createdAt: true }, orderBy: { createdAt: "asc" } });
  const tripIds = trips.map((t) => t.id);
  const events = await prisma.agentEvent.findMany({ where: { tripId: { in: tripIds } }, orderBy: { atMs: "asc" } });
  return { events, trips };
}

/** The current run's own trip start — the newest `AgentTrip.createdAt` for
 *  the load, same trip `driverReplyUnlocked` (actions.ts) already treats as
 *  "the" trip (`orderBy: { createdAt: "desc" }`). Used as the lower fence
 *  for Night Shift's rung-1 outreach (observeBreakdown.ts, contact-fix-
 *  brief.md): a `breakdownTriggeredAt` fence is too narrow when the rung-1
 *  message lands before the scripted breakdown fires, but a fence with no
 *  floor at all would also accept a stale leftover trip's rows from a
 *  previous run that a purge missed. Zero (never satisfied by a real
 *  `atMs`, which is a positive epoch ms) when the load has no trip yet. */
export function newestTripStartMs(trips: readonly { createdAt: Date }[]): number {
  return trips.reduce((max, t) => Math.max(max, t.createdAt.getTime()), 0);
}

/** AgentEvent carries no plain "text" column — `evidence` is the core's own
 *  evidence object, verbatim (its own model comment). Every read of it in
 *  this feature goes through here rather than a scattered `as Record<...>`. */
export function evidenceOf(e: AgentEvent): Record<string, unknown> {
  return (e.evidence as Record<string, unknown>) ?? {};
}

/** The newest event matching `match`, or undefined — events are fetched in
 *  ascending `atMs` order, so this is a linear scan backward rather than a
 *  second query with a `desc` order. */
export function latest(events: AgentEvent[], match: (e: AgentEvent) => boolean): AgentEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (match(events[i]!)) return events[i];
  }
  return undefined;
}
