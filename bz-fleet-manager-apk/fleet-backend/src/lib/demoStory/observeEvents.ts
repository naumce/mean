import type { AgentEvent } from "@prisma/client";
import { prisma } from "../../db.js";

// Demo Mode: the one place the observe modules read Night Shift's own
// AgentTrip/AgentEvent rows — same fetch shape as `lib/agentTimeline.ts`
// (trips for the load, then events for those trips), bounded to one load.
// Split out so the observe modules can all use it without importing each
// other.

export async function tripsAndEvents(loadId: string): Promise<{ events: AgentEvent[] }> {
  const trips = await prisma.agentTrip.findMany({ where: { loadId }, select: { id: true } });
  const tripIds = trips.map((t) => t.id);
  const events = await prisma.agentEvent.findMany({ where: { tripId: { in: tripIds } }, orderBy: { atMs: "asc" } });
  return { events };
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
