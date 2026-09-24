// Response metrics from the Night Shift agent's own evidence trail (AI
// Dispatch Foundation, Task 4) — replaying AgentEvent rows the agent already
// recorded, never a subjective score. Isolated from driverMetrics.ts because
// this is a distinct concern: knowing the SHAPE of the agent's untyped
// `evidence` Json blob, not assignment/lane arithmetic. This package never
// imports night-shift/ (Task 4's own hard rule) — the shapes read here are
// copied by hand from night-shift/src/core/agent.ts and types.ts (ActionKind,
// EventKind) and must be kept in sync manually if that module's evidence
// shapes ever change.
//
// Kinds replayed here, verbatim from the agent's own `record()` calls:
//  - ASK: kind "action", evidence.kind one of "message" | "message_again" |
//    "sms" (night-shift/src/core/ladder.ts's ActionKind rungs that actually
//    text the driver). "call"/"call_retry" are recorded as their OWN
//    EventKind "call", never "action" — they can never match isTextAsk below
//    regardless of their evidence.kind, so a phone call is never counted as
//    a text question.
//  - REPLY: kind "reply", evidence.situationKey is `string | null`.
//  - ESCALATION: kind "escalation", evidence.reason is a string that starts
//    "<anomaly kind> unresolved after N calls" or "could not reach the
//    driver — …".

export interface AgentEventForResponseMetrics {
  atMs: bigint;
  kind: string;
  evidence: unknown;
}

export interface TripForResponseMetrics {
  events: AgentEventForResponseMetrics[];
}

export interface ResponseMetrics {
  averageResponseMinutes: number | null;
  responseRate: number | null;
  noResponseIncidents: number;
  breakdownIncidents: number;
  accidentIncidents: number;
}

const TEXT_ASK_KINDS = new Set(["message", "message_again", "sms"]);

/** Json comes back typed as `unknown` (Prisma's JsonValue widened) — this is
 *  the one, shared narrowing point every field read below goes through,
 *  matching dispatcherCustomers.ts's own `(e as {code?: string})` cast style
 *  for an untyped value from outside this module's control. */
function evidenceOf(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function isTextAsk(e: AgentEventForResponseMetrics): boolean {
  if (e.kind !== "action") return false;
  const kind = evidenceOf(e.evidence).kind;
  return typeof kind === "string" && TEXT_ASK_KINDS.has(kind);
}

function isNoResponseEscalation(e: AgentEventForResponseMetrics): boolean {
  if (e.kind !== "escalation") return false;
  const reason = evidenceOf(e.evidence).reason;
  return typeof reason === "string" && (reason.includes("unresolved") || reason.includes("could not reach"));
}

interface TripStats {
  opened: number;
  closed: number;
  responseMinutes: number[];
  noResponseIncidents: number;
  breakdownIncidents: number;
  accidentIncidents: number;
}

/**
 * One trip's own open/close bookkeeping, brief-exact: events ordered by
 * `atMs` (BigInt — `Number()` converts, same as agentTimeline.ts), each ASK
 * opens a question ONLY when none is already open (a second ask before any
 * reply never opens a SECOND question), and the next REPLY closes whichever
 * question is open, however it answered. `breakdownIncidents`/
 * `accidentIncidents` count every reply with that `situationKey` regardless
 * of whether it happened to close a question — the brief defines them as a
 * property of the REPLY, not of the pairing.
 *
 * Scoped to one trip at a time: two trips never share an open question (each
 * is the agent's own independent run at one load), so the caller sums these
 * totals across a driver's trips rather than this function looking past its
 * own event list.
 */
function tripStats(trip: TripForResponseMetrics): TripStats {
  const sorted = [...trip.events].sort((a, b) => Number(a.atMs) - Number(b.atMs));
  let opened = 0;
  let closed = 0;
  let openedAtMs: number | null = null;
  const responseMinutes: number[] = [];
  let noResponseIncidents = 0;
  let breakdownIncidents = 0;
  let accidentIncidents = 0;

  for (const e of sorted) {
    const atMs = Number(e.atMs);
    if (isTextAsk(e)) {
      if (openedAtMs === null) {
        opened += 1;
        openedAtMs = atMs;
      }
      continue;
    }
    if (e.kind === "reply") {
      if (openedAtMs !== null) {
        closed += 1;
        responseMinutes.push((atMs - openedAtMs) / 60_000);
        openedAtMs = null;
      }
      const situationKey = evidenceOf(e.evidence).situationKey;
      if (situationKey === "breakdown") breakdownIncidents += 1;
      if (situationKey === "accident") accidentIncidents += 1;
      continue;
    }
    if (isNoResponseEscalation(e)) noResponseIncidents += 1;
  }

  return { opened, closed, responseMinutes, noResponseIncidents, breakdownIncidents, accidentIncidents };
}

/**
 * Pools every trip's own open/close bookkeeping into one driver-level
 * summary: `averageResponseMinutes` over every CLOSED question across all of
 * the driver's trips (null when none closed — never 0, which would claim an
 * instant reply that never happened); `responseRate` = closed / opened (null
 * when nothing was ever asked, not 0 — an unasked driver is not evidence of
 * a bad one). The three incident counts are summed the same way.
 */
export function responseMetricsFor(trips: TripForResponseMetrics[]): ResponseMetrics {
  let opened = 0;
  let closed = 0;
  let noResponseIncidents = 0;
  let breakdownIncidents = 0;
  let accidentIncidents = 0;
  const responseMinutes: number[] = [];

  for (const trip of trips) {
    const stats = tripStats(trip);
    opened += stats.opened;
    closed += stats.closed;
    responseMinutes.push(...stats.responseMinutes);
    noResponseIncidents += stats.noResponseIncidents;
    breakdownIncidents += stats.breakdownIncidents;
    accidentIncidents += stats.accidentIncidents;
  }

  return {
    averageResponseMinutes: responseMinutes.length
      ? responseMinutes.reduce((sum, m) => sum + m, 0) / responseMinutes.length
      : null,
    responseRate: opened === 0 ? null : closed / opened,
    noResponseIncidents,
    breakdownIncidents,
    accidentIncidents,
  };
}
