import { prisma } from "../../db.js";
import { ACTIVE_STATUSES } from "../activeStatuses.js";

// dispatchTools/eta.ts (AI Dispatch Foundation, Task 5): getCurrentETA reads
// two evidence trails that already exist — the Night Shift agent's own
// AgentTrip/AgentEvent evidence (see night-shift/src/core/agent.ts's
// `record("plan", ...)` / `record("sheet_write", ...)` calls, which this
// module only ever READS, never writes) and the dispatch Assignment's
// plannedEnd. It computes no new ETA of its own — it only picks the best
// evidence already on record.

export type EtaSource = "agent_itinerary" | "plan_interpolation" | "none";

export interface CurrentEta {
  source: EtaSource;
  etaMs: number | null;
  precision: "live" | "planned" | null;
  computedAt: number;
}

interface EtaCarryingEvent {
  atMs: bigint;
  kind: string;
  evidence: unknown;
}

/** The number at `evidence.etaAtMs` (a "plan" event) or
 *  `evidence.remaining.etaAtMs` (a "sheet_write" event that reached a
 *  re-timed remainder) — null for every other shape, including a failed
 *  "plan" (`evidence.failed`) or a cells-only "sheet_write" with no
 *  `remaining` yet. */
function etaFromEvidence(kind: string, evidence: unknown): number | null {
  if (evidence == null || typeof evidence !== "object") return null;
  const record = evidence as Record<string, unknown>;
  if (kind === "plan") {
    return typeof record.etaAtMs === "number" ? record.etaAtMs : null;
  }
  if (kind === "sheet_write") {
    const remaining = record.remaining;
    const etaAtMs = remaining && typeof remaining === "object" ? (remaining as Record<string, unknown>).etaAtMs : null;
    return typeof etaAtMs === "number" ? etaAtMs : null;
  }
  return null;
}

/** `events` is newest-first (`atMs desc`, as queried below) — the first one
 *  that actually resolves an eta wins, so a newer event carrying none (a
 *  failed plan, a cells-only sheet_write) never masks an older one that does
 *  carry one. This is how a later sheet_write's re-timed remainder ends up
 *  preferred over an earlier plan's original estimate: it is simply newer. */
function newestEtaFromEvents(events: EtaCarryingEvent[]): number | null {
  for (const event of events) {
    const eta = etaFromEvidence(event.kind, event.evidence);
    if (eta != null) return eta;
  }
  return null;
}

/**
 * `assigned`/`tendered`/`in_progress` (ACTIVE_STATUSES) or `completed` —
 * every real `Assignment.status` EXCEPT `canceled`. An assignment's
 * plannedEnd only counts as "planned" evidence of an ETA while the run it
 * describes is still happening or actually happened; a canceled assignment's
 * plannedEnd describes a run that never happened, so reporting it as a
 * delivery-time estimate would be inventing an ETA for a load that was never
 * actually moving toward one. Pinned by the canceled-only-assignment case in
 * tests/dispatch-tools-loads.test.ts.
 */
const PLANNED_ETA_STATUSES = new Set<string>([...ACTIVE_STATUSES, "completed"]);

/**
 * The load's best-known current ETA:
 *  1. "agent_itinerary" (precision "live") — the load's NEWEST AgentTrip's
 *     newest plan/sheet_write event that carries an etaAtMs.
 *  2. else "plan_interpolation" (precision "planned") — the load's
 *     assignment's plannedEnd, when that assignment is active or completed.
 *  3. else "none".
 * Null (as opposed to a `CurrentEta` with source "none") when the load
 * itself does not exist or belongs to another org.
 */
export async function getCurrentETA(orgId: string, loadId: string): Promise<CurrentEta | null> {
  const load = await prisma.load.findUnique({
    where: { id: loadId },
    select: { orgId: true, assignment: { select: { status: true, plannedEnd: true } } },
  });
  if (!load || load.orgId !== orgId) return null;

  const computedAt = Date.now();

  const newestTrip = await prisma.agentTrip.findFirst({
    where: { loadId },
    orderBy: { createdAt: "desc" },
    select: {
      events: {
        where: { kind: { in: ["plan", "sheet_write"] } },
        orderBy: { atMs: "desc" },
        select: { atMs: true, kind: true, evidence: true },
      },
    },
  });

  const liveEtaMs = newestTrip ? newestEtaFromEvents(newestTrip.events) : null;
  if (liveEtaMs != null) {
    return { source: "agent_itinerary", etaMs: liveEtaMs, precision: "live", computedAt };
  }

  if (load.assignment && PLANNED_ETA_STATUSES.has(load.assignment.status)) {
    return { source: "plan_interpolation", etaMs: load.assignment.plannedEnd.getTime(), precision: "planned", computedAt };
  }

  return { source: "none", etaMs: null, precision: null, computedAt };
}
