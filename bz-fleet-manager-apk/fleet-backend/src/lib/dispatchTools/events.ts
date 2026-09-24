import { prisma } from "../../db.js";

// dispatchTools/events.ts (AI Dispatch Foundation, Task 5): read-only event
// trails. getLoadEvents merges two existing tables (LoadChange, AgentUpdate)
// by time; getAgentEvents reads the Night Shift agent's own AgentTrip/
// AgentEvent trail verbatim. Neither computes anything new.

export type LoadEventRow =
  | {
      atMs: number;
      type: "change";
      actorName: string;
      source: string;
      field: string;
      before: string | null;
      after: string | null;
      note: string | null;
    }
  | { atMs: number; type: "agent_update"; kind: string; text: string };

/**
 * `LoadChange` (dispatcher/board/import edits) and `AgentUpdate` (the Night
 * Shift agent's own UPDATE-cell lines) merged into one ascending timeline;
 * null when the load does not exist or belongs to another org. Both tables
 * key `atMs` as a Postgres bigint (Prisma's `BigInt`) — converted to
 * `Number` here, same as every other tool in this module, since a
 * millisecond timestamp never approaches BigInt's actual range.
 */
export async function getLoadEvents(orgId: string, loadId: string): Promise<LoadEventRow[] | null> {
  const load = await prisma.load.findUnique({ where: { id: loadId }, select: { orgId: true } });
  if (!load || load.orgId !== orgId) return null;

  const [changes, updates] = await Promise.all([
    prisma.loadChange.findMany({ where: { loadId }, orderBy: { atMs: "asc" } }),
    prisma.agentUpdate.findMany({ where: { loadId }, orderBy: { atMs: "asc" } }),
  ]);

  const changeRows: LoadEventRow[] = changes.map((c) => ({
    atMs: Number(c.atMs),
    type: "change",
    actorName: c.actorName,
    source: c.source,
    field: c.field,
    before: c.before,
    after: c.after,
    note: c.note,
  }));
  const updateRows: LoadEventRow[] = updates.map((u) => ({
    atMs: Number(u.atMs),
    type: "agent_update",
    kind: u.kind,
    text: u.text,
  }));

  return [...changeRows, ...updateRows].sort((a, b) => a.atMs - b.atMs);
}

export interface AgentEventRow {
  atMs: number;
  kind: string;
  evidence: unknown;
  actionTaken: string | null;
}

export interface AgentTripRow {
  tripId: string;
  status: string;
  createdAt: Date;
  events: AgentEventRow[];
}

/**
 * The load's own AgentTrip/AgentEvent trail, newest trip first, each trip's
 * events oldest first; null when the load does not exist or belongs to
 * another org. Evidence is returned verbatim (it is already plain JSON) —
 * this is a read of the agent's raw trail, not an interpretation of it.
 */
export async function getAgentEvents(orgId: string, loadId: string): Promise<AgentTripRow[] | null> {
  const load = await prisma.load.findUnique({ where: { id: loadId }, select: { orgId: true } });
  if (!load || load.orgId !== orgId) return null;

  const trips = await prisma.agentTrip.findMany({
    where: { loadId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      createdAt: true,
      events: {
        orderBy: { atMs: "asc" },
        select: { atMs: true, kind: true, evidence: true, actionTaken: true },
      },
    },
  });

  return trips.map((t) => ({
    tripId: t.id,
    status: t.status,
    createdAt: t.createdAt,
    events: t.events.map((e) => ({ atMs: Number(e.atMs), kind: e.kind, evidence: e.evidence, actionTaken: e.actionTaken })),
  }));
}
