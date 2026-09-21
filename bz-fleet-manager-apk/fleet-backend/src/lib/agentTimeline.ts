import { prisma } from "../db.js";
import { policyFor } from "./agentPolicies.js";

/** One line of a load's Night Shift timeline, merging AgentUpdate and
 *  AgentEvent rows — same shape GET /loads/:id/agent has always answered
 *  (dispatcherNightShift.ts, pre-Task-10). */
export interface AgentTimelineEntry {
  atMs: number;
  kind: string;
  text: string;
  evidence?: unknown;
}

export interface AgentTimelineBody {
  enabled: boolean;
  /** The board's LOAD# (null for a load that never carried one) — what a
   *  header shows instead of the uuid (final fix wave, minor). */
  boardLoadNo: string | null;
  policy: { id: string; name: string; [key: string]: unknown };
  pill: string;
  line: string | null;
  timeline: AgentTimelineEntry[];
}

/** The load's Night Shift timeline (spec §6.4/§17.3) — extracted from
 *  dispatcherNightShift.ts's GET /loads/:id/agent (Task 10) so the
 *  dispatcher's own route and the token-authenticated deep link
 *  (routes/nightShiftLink.ts) answer byte-for-byte the same body from one
 *  place.
 *
 *  `orgId`: the caller's tenant scope. `null` means unscoped (a legacy/dev
 *  dispatcher account with no org — sees any load, matching
 *  middleware/orgScope.ts's `outsideOrg` semantics exactly); a non-null
 *  value that does not match the load's own org is treated the same as the
 *  load not existing — the caller turns either case into its own 404, since
 *  "not found" and "not yours" must read identically (Global Constraint:
 *  404 not 403). The link route always passes a real, verified org id. */
export async function timelineFor(loadId: string, orgId: string | null): Promise<AgentTimelineBody | null> {
  const load = await prisma.load.findUnique({ where: { id: loadId } });
  if (!load) return null;
  if (orgId != null && load.orgId !== orgId) return null;

  const [policies, updates, trips] = await Promise.all([
    prisma.agentPolicy.findMany({ where: { orgId: load.orgId } }),
    prisma.agentUpdate.findMany({ where: { loadId: load.id }, orderBy: { atMs: "desc" } }),
    prisma.agentTrip.findMany({ where: { loadId: load.id }, select: { id: true } }),
  ]);
  const tripIds = trips.map((t) => t.id);
  const events = tripIds.length
    ? await prisma.agentEvent.findMany({ where: { tripId: { in: tripIds } }, orderBy: { atMs: "desc" } })
    : [];

  const policy = policyFor(load, policies);
  // The board's own "agentLine" concept (dispatcherBrokerBoard.ts's
  // boardRows()): the newest AgentUpdate that is not an attention line.
  const line = updates.find((u) => u.kind !== "attention")?.text ?? null;

  const timeline: AgentTimelineEntry[] = [
    ...updates.map((u) => ({ atMs: Number(u.atMs), kind: u.kind, text: u.text })),
    // AgentEvent carries no plain "text" column (its `evidence` is the core's
    // own evidence object, verbatim, per the model's own comment) — the
    // closest thing to a human line is `actionTaken`, when the event recorded
    // one; a `kind` fallback keeps every row readable rather than blank.
    ...events.map((e) => ({ atMs: Number(e.atMs), kind: e.kind, text: e.actionTaken ?? e.kind, evidence: e.evidence })),
  ].sort((a, b) => b.atMs - a.atMs);

  return { enabled: load.agentEnabled, boardLoadNo: load.boardLoadNo, policy, pill: load.agentPill, line, timeline };
}
