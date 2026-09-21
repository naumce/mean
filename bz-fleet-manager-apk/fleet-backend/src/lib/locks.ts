// Pessimistic lane locks. Deliberately in process memory, not Postgres: a lock
// is a courtesy between dispatchers looking at the same board, and one that
// outlives a crashed browser is worse than one that expires. The TTL is the
// guarantee; explicit release and socket-disconnect cleanup are optimisations.
//
// Single-process assumption: this is correct for the current single-instance
// deployment, and ONLY there. Behind a load balancer each instance would keep
// its own table, so two dispatchers routed to different instances would each
// be granted the same lane and each be told they hold it exclusively — the
// one thing this module exists to prevent. Scaling out therefore requires
// moving the table to shared storage (Redis SET NX PX, whose TTL maps onto
// LOCK_TTL_MS directly) before a second instance is started, not afterwards.
// Data stays consistent either way: the commit transaction re-checks overlap
// under Serializable isolation, so what breaks is the UX guarantee, not the
// database.
//
// Keyed by laneId ALONE — no org partition. Lane ids are driver UUIDs,
// globally unique, so one lane can only ever have one lock; org buckets
// bought nothing for correctness and cost a real bug: a scoped dispatcher and
// an unscoped (legacy) one could each acquire the SAME lane and both be told
// they hold it, because their locks landed in different buckets while
// orgWhere()'s "unscoped sees everything" stance meant the unscoped
// dispatcher could genuinely reach that lane. `orgId` is carried on the Lock
// purely so `snapshot()` can filter what a board *displays* — it plays no
// part in whether an acquire succeeds.

export interface Lock {
  laneId: string;
  /** The LANE's owning org (the locked driver's), for snapshot() visibility
   *  filtering only — never consulted by acquire/release/get, which are
   *  global by laneId. Deliberately the lane's org and not the HOLDER's: the
   *  two differ only when an unscoped (legacy/dev) dispatcher holds the lane,
   *  and keying on the holder then hid the lock from the very org whose
   *  mutations it blocks. null = a driver with no org at all, a lane no
   *  scoped dispatcher can reach. See routes/dispatcherLocks.ts. */
  orgId: string | null;
  dispatcherId: string;
  name: string;
  since: number;
  expiresAt: number;
}

export const LOCK_TTL_MS = 90_000;

const table = new Map<string, Lock>(); // laneId -> Lock. No org partition.

/** A lock is live until strictly past its expiry: at exactly `expiresAt` it is
 *  still held.
 *
 *  Deliberately the opposite stance from `domain/dispatch/compliance.ts`, which
 *  treats `expiresAt <= proposedStart` as expired — there, equality must block,
 *  because rolling on a licence that expires the instant you depart is illegal.
 *  Here equality must hold, because releasing a lock at the exact tick it
 *  expires lets two dispatchers each believe they own the lane. Both rules
 *  round in the safe direction for their own domain; they are not in conflict,
 *  and neither should be "harmonised" into the other. */
function live(l: Lock, nowMs: number): boolean {
  return nowMs <= l.expiresAt;
}

export function get(laneId: string, nowMs = Date.now()): Lock | null {
  const l = table.get(laneId);
  return l && live(l, nowMs) ? l : null;
}

export function acquire(
  laneId: string,
  dispatcherId: string,
  name: string,
  orgId: string | null,
  nowMs = Date.now(),
): { ok: true; lock: Lock; fresh: boolean } | { ok: false; lock: Lock } {
  const held = get(laneId, nowMs);
  if (held && held.dispatcherId !== dispatcherId) return { ok: false, lock: held };
  // `held` is non-null only when THIS dispatcher already holds a live lock on
  // the lane (any other holder was rejected above) — that's the 30 s
  // heartbeat: keep `since` (held continuously) and report `fresh: false` so
  // callers know not to announce it. Anything else reaching here — a free
  // lane, or the previous holder's (anyone's) lock having expired — is a
  // genuine new hold: `since` restarts at `nowMs` and `fresh` is true.
  const lock: Lock = {
    laneId,
    orgId,
    dispatcherId,
    name,
    since: held?.since ?? nowMs,
    expiresAt: nowMs + LOCK_TTL_MS,
  };
  table.set(laneId, lock);
  return { ok: true, lock, fresh: held == null };
}

/** Release a lane. Returns `false` ONLY when someone else holds it — releasing
 *  a lane that is already free (never held, or expired) is a success, not an
 *  error, so the client's cleanup on drawer-close, unmount and route-leave is
 *  idempotent and cannot produce a spurious 409. No `orgId`/scope parameter:
 *  a lane has exactly one lock table-wide, so the holder's dispatcherId alone
 *  decides who may release it. */
export function release(laneId: string, dispatcherId: string, nowMs = Date.now()): boolean {
  const held = get(laneId, nowMs);
  if (!held) {
    table.delete(laneId); // clear an expired remnant
    return true;
  }
  if (held.dispatcherId !== dispatcherId) return false;
  table.delete(laneId);
  return true;
}

/** `scope` is a display filter over the (already-global) lock table, not a
 *  partition: a real orgId returns only that org's locks; `null` (unscoped,
 *  legacy caller) returns every live lock — matching `orgWhere()`'s
 *  documented "unscoped sees everything" stance, rather than being more
 *  restrictive than it the way the bucketed table was. */
export function snapshot(scope: string | null, nowMs = Date.now()): Lock[] {
  const live_ = [...table.values()].filter((l) => live(l, nowMs));
  return scope == null ? live_ : live_.filter((l) => l.orgId === scope);
}

/** Best-effort cleanup when a dispatcher's socket drops. Returns the lanes
 *  freed so the caller can emit `lane_unlock` for each. */
export function releaseAllFor(dispatcherId: string): string[] {
  const freed: string[] = [];
  for (const [laneId, l] of table) {
    if (l.dispatcherId === dispatcherId) {
      table.delete(laneId);
      freed.push(laneId);
    }
  }
  return freed;
}

/** Sweeps expired locks out of the table so abandoned lanes don't accumulate
 *  Lock objects forever (Task 3 runs this on a 15 s interval). Returns the
 *  number of entries actually deleted — a genuine signal worth logging, and
 *  it keeps the function honest about what it did rather than a fire-and-forget
 *  `void`. Walks the WHOLE table — a sweeper that stops after the first entry
 *  it inspects looks identical to a correct one on a single-lane test, which
 *  is exactly the gap the multi-lane sweep test below exists to close. */
export function sweep(nowMs = Date.now()): number {
  let removed = 0;
  for (const [laneId, l] of table) {
    if (!live(l, nowMs)) {
      table.delete(laneId);
      removed++;
    }
  }
  return removed;
}

/** Test-only: the table is module state, so suites must be able to reset it.
 *  Authorised the same way `__resetThemeMedia` was in S0. */
export function __resetLocks(): void {
  table.clear();
}

/** Test-only: the Map's true entry count, INCLUDING expired locks that
 *  `snapshot()` would filter out. Exists so a test can distinguish a working
 *  sweeper from a decorative one — `snapshot()` cannot, because it filters by
 *  `live()` regardless of whether the entry was actually deleted. No `orgId`
 *  parameter: the table has no org partition to select from. */
export function __rawSize(): number {
  return table.size;
}
