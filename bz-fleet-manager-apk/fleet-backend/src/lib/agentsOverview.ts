import { prisma } from "../db.js";
import { deriveAgentSummary, type AgentSummaryEvent } from "./agentSummary.js";
import { DEFAULT_HARNESS_CONFIG, harnessEnabled } from "./aiHarness/config.js";
import { checkOllama } from "./aiHarness/ollamaAdapter.js";
import { runnerState } from "./aiHarness/runner.js";
import { STANDARD_POLICY } from "./agentPolicies.js";

// AI Agents Surface (Task 3): the one read the "AI Agents" overview page
// reads, shaped so dispatch's readiness (rules vs. model) and Night Shift's
// mode/activity read exactly like the per-load summary (agentSummary.ts,
// Task 1) does — same vocabulary everywhere, never a second source of truth.
// Query + shaping only; the route (routes/dispatcherAgents.ts) stays thin.

export interface AgentsOverview {
  generatedAt: string;
  dispatch: {
    rules: { available: true };
    model: {
      configured: boolean;
      reachable: boolean | null;
      modelPresent: boolean | null;
      model: string | null;
      error: string | null;
    };
    activity: {
      running: { runId: string; loadId: string | null; startedAt: string | null } | null;
      queued: number;
      lastRun: {
        runId: string;
        loadId: string | null;
        status: string;
        driverId: string | null;
        driverName: string | null;
        confidence: number | null;
        completedAt: string | null;
        promptVersion: string | null;
      } | null;
    };
  };
  nightShift: {
    service: { configured: boolean; lastActivityAt: string | null };
    activity: {
      watching: number;
      waitingReply: number;
      escalated: number;
      held: number;
      attention: number;
      delivered: number;
      off: number;
      total: number;
    };
    mode: { shadowLoads: number; liveLoads: number; livePolicies: number };
    enforcement: { customerEmailOn: "not_enforced"; quietHours: "not_enforced" };
    loads: Array<{
      loadId: string;
      boardLoadNo: string | null;
      pill: string;
      mode: "shadow" | "live" | "off";
      activity: string;
      next: string;
      nextConfidence: "known" | "inferred" | "unknown";
      lastEventAt: string | null;
    }>;
  };
}

const MAX_LOADS = 25;
const NON_TERMINAL_RUN_STATUSES: string[] = ["queued", "running"];

/** Prisma where-fragment for the current tenant ({} when unscoped) — the
 *  same shape middleware/orgScope.ts's `orgWhere(req)` gives a route, built
 *  here from the already-resolved orgId so this module never needs the
 *  request object itself. */
function orgFilter(orgId: string | null): { orgId?: string } {
  return orgId ? { orgId } : {};
}

async function modelStatus(): Promise<AgentsOverview["dispatch"]["model"]> {
  if (!harnessEnabled()) {
    return { configured: false, reachable: null, modelPresent: null, model: null, error: null };
  }
  // harnessEnabled() only returns true once OLLAMA_URL is set, so the `!`
  // here matches aiHarness/config.ts's own ollamaBaseUrl() contract: this
  // call site sits behind that exact check.
  const ollama = await checkOllama(process.env.OLLAMA_URL!, DEFAULT_HARNESS_CONFIG.model);
  return {
    configured: true,
    reachable: ollama.reachable,
    modelPresent: ollama.modelPresent,
    model: DEFAULT_HARNESS_CONFIG.model,
    error: ollama.error,
  };
}

async function runningInfo(orgId: string | null): Promise<{ running: AgentsOverview["dispatch"]["activity"]["running"]; queued: number }> {
  if (!orgId) return { running: null, queued: 0 };
  const state = runnerState(orgId);
  if (!state.running) return { running: null, queued: state.queued.length };
  const record = await prisma.aiDecisionRecord.findUnique({
    where: { id: state.running },
    select: { id: true, loadId: true, startedAt: true, proposedAt: true },
  });
  if (!record) return { running: { runId: state.running, loadId: null, startedAt: null }, queued: state.queued.length };
  return {
    running: { runId: record.id, loadId: record.loadId, startedAt: (record.startedAt ?? record.proposedAt).toISOString() },
    queued: state.queued.length,
  };
}

async function lastRunFor(orgId: string | null): Promise<AgentsOverview["dispatch"]["activity"]["lastRun"]> {
  const record = await prisma.aiDecisionRecord.findFirst({
    where: { ...orgFilter(orgId), status: { notIn: NON_TERMINAL_RUN_STATUSES } },
    orderBy: { proposedAt: "desc" },
    select: { id: true, loadId: true, status: true, driverId: true, confidence: true, completedAt: true, promptVersion: true },
  });
  if (!record) return null;
  const driver = record.driverId
    ? await prisma.driver.findUnique({ where: { id: record.driverId }, select: { name: true } })
    : null;
  return {
    runId: record.id,
    loadId: record.loadId,
    status: record.status,
    driverId: record.driverId,
    driverName: driver?.name ?? null,
    confidence: record.confidence,
    completedAt: record.completedAt ? record.completedAt.toISOString() : null,
    promptVersion: record.promptVersion,
  };
}

async function lastActivityAt(orgId: string | null): Promise<string | null> {
  const [event, update] = await Promise.all([
    prisma.agentEvent.findFirst({
      where: orgId ? { trip: { load: { orgId } } } : {},
      orderBy: { atMs: "desc" },
      select: { atMs: true },
    }),
    prisma.agentUpdate.findFirst({
      where: orgId ? { load: { orgId } } : {},
      orderBy: { atMs: "desc" },
      select: { atMs: true },
    }),
  ]);
  const candidates = [event?.atMs, update?.atMs].filter((v): v is bigint => v !== undefined);
  if (candidates.length === 0) return null;
  const newest = candidates.reduce((a, b) => (b > a ? b : a));
  return new Date(Number(newest)).toISOString();
}

/** A load's policy shadow flag: its own policy if named, else the org's
 *  Standard, else unknown. Mirrors agentPolicies.ts's `policyFor` but never
 *  throws — this is a read-only overview over rows that may be mid-migration
 *  or otherwise inconsistent, and "policy unknown" (agentSummary.ts's own
 *  honest fallback) is the correct answer for that, not a 500. */
function shadowFor(
  load: { agentPolicyId: string | null; orgId: string },
  policies: readonly { id: string; orgId: string; name: string; shadow: boolean }[],
): boolean | null {
  const own = load.agentPolicyId ? policies.find((p) => p.id === load.agentPolicyId && p.orgId === load.orgId) : undefined;
  const std = policies.find((p) => p.orgId === load.orgId && p.name === STANDARD_POLICY.name);
  const chosen = own ?? std;
  return chosen ? chosen.shadow : null;
}

/** `loads[].boardLoadNo`: the field name stays `boardLoadNo` (the portal
 *  type mirrors it verbatim) but its VALUE is the first non-empty of the
 *  load's own board number, its `orderRef`, then its `externalId` — most
 *  seeded/imported loads never got a board number, and showing a raw uuid
 *  instead of any of the ids the load actually carries is a live-data bug,
 *  not a fallback anyone reads intentionally. Precedence is fixed; do not
 *  reorder it. */
function displayLoadNo(load: { boardLoadNo: string | null; orderRef: string | null; externalId: string | null }): string | null {
  const candidates = [load.boardLoadNo, load.orderRef, load.externalId];
  return candidates.find((v): v is string => typeof v === "string" && v.trim().length > 0) ?? null;
}

const ACTIVITY_PRIORITY: Record<string, number> = { attention: 0, escalated: 0, waiting_reply: 1 };

/** Same shape as `AgentsOverview["nightShift"]["loads"][number]`, but with
 *  `lastEventAt` still a raw epoch-ms number — sorting needs the number;
 *  only the final response needs the ISO string, applied once at the end. */
type LoadRow = Omit<AgentsOverview["nightShift"]["loads"][number], "lastEventAt"> & { lastEventAt: number | null };

export async function buildAgentsOverview(orgId: string | null): Promise<AgentsOverview> {
  const nowMs = Date.now();

  const [modelResult, running, lastRun, serviceLastActivityAt, livePolicies] = await Promise.all([
    modelStatus(),
    runningInfo(orgId),
    lastRunFor(orgId),
    lastActivityAt(orgId),
    prisma.agentPolicy.count({ where: { ...orgFilter(orgId), shadow: false } }),
  ]);

  // Per Global Constraints / plan: a load counts toward the overview when
  // Night Shift is switched on for it OR its pill still records something
  // other than "off" (a load turned off a moment ago whose last-known pill
  // has not caught up yet) — never filtered by the worker being configured,
  // which is a separate fact (service.configured) from the workload itself.
  const loads = await prisma.load.findMany({
    where: { ...orgFilter(orgId), OR: [{ agentEnabled: true }, { agentPill: { not: "off" } }] },
    select: { id: true, orgId: true, boardLoadNo: true, orderRef: true, externalId: true, agentPill: true, agentEnabled: true, agentPolicyId: true },
  });

  const activity = { watching: 0, waitingReply: 0, escalated: 0, held: 0, attention: 0, delivered: 0, off: 0, total: 0 };
  const mode = { shadowLoads: 0, liveLoads: 0, livePolicies };
  const loadRows: LoadRow[] = [];

  if (loads.length > 0) {
    const loadIds = loads.map((l) => l.id);
    const orgIds = [...new Set(loads.map((l) => l.orgId))];

    const [policies, attentionUpdates, trips] = await Promise.all([
      prisma.agentPolicy.findMany({ where: { orgId: { in: orgIds } }, select: { id: true, orgId: true, name: true, shadow: true } }),
      prisma.agentUpdate.findMany({
        where: { loadId: { in: loadIds }, kind: "attention" },
        orderBy: { atMs: "desc" },
        select: { loadId: true, text: true },
      }),
      prisma.agentTrip.findMany({ where: { loadId: { in: loadIds } }, select: { id: true, loadId: true } }),
    ]);

    const attentionByLoad = new Map<string, string>();
    for (const u of attentionUpdates) if (!attentionByLoad.has(u.loadId)) attentionByLoad.set(u.loadId, u.text);

    const tripLoadMap = new Map(trips.filter((t) => t.loadId).map((t) => [t.id, t.loadId as string]));
    const tripIds = [...tripLoadMap.keys()];
    const events = tripIds.length
      ? await prisma.agentEvent.findMany({ where: { tripId: { in: tripIds } }, orderBy: { atMs: "desc" } })
      : [];

    // Bounded per load (spec: "last 200 by atMs desc") — events arrive newest
    // first already, so capping each load's bucket at 200 as we iterate keeps
    // the newest 200 and drops the rest without a second sort.
    const eventsByLoad = new Map<string, AgentSummaryEvent[]>();
    for (const e of events) {
      const loadId = tripLoadMap.get(e.tripId);
      if (!loadId) continue;
      const bucket = eventsByLoad.get(loadId) ?? [];
      if (bucket.length < 200) {
        bucket.push({ atMs: Number(e.atMs), kind: e.kind, evidence: e.evidence, actionTaken: e.actionTaken });
        eventsByLoad.set(loadId, bucket);
      }
    }

    for (const load of loads) {
      const summary = deriveAgentSummary({
        enabled: load.agentEnabled,
        pill: load.agentPill,
        policyShadow: shadowFor(load, policies),
        attentionLine: attentionByLoad.get(load.id) ?? null,
        events: eventsByLoad.get(load.id) ?? [],
        nowMs,
      });

      activity.total += 1;
      switch (summary.activity) {
        case "watching": activity.watching += 1; break;
        case "waiting_reply": activity.waitingReply += 1; break;
        case "escalated": activity.escalated += 1; break;
        case "held": activity.held += 1; break;
        case "attention": activity.attention += 1; break;
        case "delivered": activity.delivered += 1; break;
        case "off": activity.off += 1; break;
      }
      if (summary.mode === "shadow") mode.shadowLoads += 1;
      else if (summary.mode === "live") mode.liveLoads += 1;

      // `loads[]` itself is narrower than the counted set: only loads Night
      // Shift is actually switched on for (spec: "enabled loads only") — a
      // load whose pill has not caught up to being switched off yet is
      // counted above but not surfaced as something to look at.
      if (load.agentEnabled) {
        loadRows.push({
          loadId: load.id,
          boardLoadNo: displayLoadNo(load),
          pill: load.agentPill,
          mode: summary.mode,
          activity: summary.activity,
          next: summary.next,
          nextConfidence: summary.nextConfidence,
          lastEventAt: summary.lastEventAt,
        });
      }
    }
  }

  // Sort: attention/escalated first, then waiting_reply, then everything
  // else — each group newest-activity-first — then cap at 25.
  const sorted = [...loadRows].sort((a, b) => {
    const pa = ACTIVITY_PRIORITY[a.activity] ?? 2;
    const pb = ACTIVITY_PRIORITY[b.activity] ?? 2;
    if (pa !== pb) return pa - pb;
    const la = typeof a.lastEventAt === "number" ? a.lastEventAt : -Infinity;
    const lb = typeof b.lastEventAt === "number" ? b.lastEventAt : -Infinity;
    return lb - la;
  });
  const topLoads = sorted.slice(0, MAX_LOADS).map((row) => ({
    ...row,
    lastEventAt: typeof row.lastEventAt === "number" ? new Date(row.lastEventAt).toISOString() : null,
  }));

  return {
    generatedAt: new Date(nowMs).toISOString(),
    dispatch: {
      rules: { available: true },
      model: modelResult,
      activity: { running: running.running, queued: running.queued, lastRun },
    },
    nightShift: {
      service: { configured: Boolean(process.env.WORKER_URL), lastActivityAt: serviceLastActivityAt },
      activity,
      mode,
      enforcement: { customerEmailOn: "not_enforced", quietHours: "not_enforced" },
      loads: topLoads,
    },
  };
}
