import { defineStore } from 'pinia'
import { acquireLock, fetchLocks, releaseLock, type Lock } from '../lib/api'

// Cockpit S2b Task 3: the client half of the pessimistic lane-lock protocol
// (fleet-backend/src/lib/locks.ts). A lane is a driver id; a dispatcher holds
// one while its drawer is open, heartbeating every 30 s against the server's
// 90 s TTL so two missed beats are survivable. Everything here is a courtesy
// — the commit/replan transaction re-checks overlap under Serializable
// isolation regardless — so this store optimizes for "never leaves a lane
// stuck locked," not for perfect consistency with the server.

/** Heartbeat cadence. Deliberately a third of the server's LOCK_TTL_MS (90 s,
 *  fleet-backend/src/lib/locks.ts) so two consecutive missed beats — a slow
 *  network, a backgrounded tab — are still survivable before the lane goes
 *  stale and another dispatcher can take it. */
export const HEARTBEAT_MS = 30_000

/** Mirrors the server's LOCK_TTL_MS. Used only to synthesize an `expiresAt`
 *  for locks learned from the `lane_lock` socket frame, which — unlike the
 *  REST responses — does not carry one (see routes/dispatcherLocks.ts's
 *  emitToDispatchers payload). Purely informational on this side; the server
 *  is the only clock that actually enforces the TTL. */
const LOCK_TTL_MS = 90_000

/** A `board_update`-shaped realtime frame carrying a lane_lock/lane_unlock
 *  payload. Declared locally rather than imported from loadboard.ts (which
 *  no longer keeps a frame type of its own — plan A4 moved the socket to
 *  lib/realtime.ts's shared `Frame`) to keep this store's dependency surface
 *  to just the API client — Task 11 wires the socket into this shape. */
export interface LockSocketEvent {
  type: string
  payload: Record<string, unknown>
}

interface LocksState {
  /** The one lane THIS client is actively holding + heartbeating, or null.
   *  Singular by design: a dispatcher has at most one drawer open at a time,
   *  and hold() releases whichever lane it previously held before taking a
   *  new one, so this never silently doubles up. */
  held: string | null
  /** Last known lock per lane, from GET /locks, the POST/DELETE responses,
   *  and the lane_lock/lane_unlock socket frames. This is a cache of what the
   *  server believes, NOT the source of truth for whether the lane the
   *  dispatcher is looking at IS this client — `held` is, on purpose (see
   *  applyEvent below). */
  byLane: Record<string, Lock>
  /** The heartbeat's window.setInterval handle, or null when not heartbeating.
   *  Not part of the plan's state shape on paper, but it must live in state
   *  (not a module-local like loadboard.ts's `socket`) so a second Pinia
   *  instance in tests never leaks a previous test's timer. */
  heartbeatId: number | null
}

/** Pull the 409's holder out of an acquireLock rejection, if present. Any
 *  other shape of failure (network error, 404, 500) yields null — hold()
 *  still swallows it (see below), it just has nothing to attribute the
 *  lock to. */
function lockFromError(error: unknown): Lock | null {
  const data = (error as { response?: { data?: { lock?: Lock } } })?.response?.data
  return data?.lock ?? null
}

export const useLocksStore = defineStore('locks', {
  state: (): LocksState => ({
    held: null,
    byLane: {},
    heartbeatId: null,
  }),

  actions: {
    /** Acquire (or re-affirm) a lane. Resolves `true` on success and starts
     *  the 30 s heartbeat; resolves `false` — WITHOUT throwing — on a 409 or
     *  any other failure, recording the holder (when the server sent one) so
     *  the drawer can open read-only and name who has it. Engine-authoritative
     *  callers must never have a lock refusal come back as a thrown error the
     *  gesture pipeline has to specifically know to catch. */
    async hold(laneId: string): Promise<boolean> {
      // Already actively holding and heartbeating this exact lane — a second
      // hold() (double-open, a re-render) must not stack a second interval.
      if (this.held === laneId && this.heartbeatId != null) return true

      // Switching lanes without an intervening release (e.g. one drawer
      // closed by opening another): release the old lane FIRST, so this
      // client is never heartbeating two lanes and leaking the one nobody is
      // looking at anymore. This is exactly the leak class S1's review caught
      // in CockpitView — closing it here rather than trusting every caller to
      // remember.
      if (this.held && this.held !== laneId) this.release()

      try {
        const { lock } = await acquireLock(laneId)
        this.held = laneId
        this.byLane = { ...this.byLane, [laneId]: lock }
        this.startHeartbeat(laneId)
        return true
      } catch (error) {
        const lock = lockFromError(error)
        if (lock) this.byLane = { ...this.byLane, [laneId]: lock }
        return false
      }
    },

    /** Internal: (re)start the 30 s heartbeat for `laneId`. Always clears any
     *  existing interval first so this is safe to call repeatedly. */
    startHeartbeat(laneId: string): void {
      this.stopHeartbeat()
      this.heartbeatId = window.setInterval(() => {
        acquireLock(laneId)
          .then(({ lock }) => {
            this.byLane = { ...this.byLane, [laneId]: lock }
          })
          .catch(() => {
            // A heartbeat re-POST of a lane we already hold should always
            // succeed server-side (acquire() treats "same dispatcher, still
            // live" as a renewal, never a conflict) — a failure here is a
            // network hiccup, not a lost lock. Leave local state as-is rather
            // than throwing inside a timer callback with no caller to catch
            // it; refresh() or the next lane_lock echo is the correction path.
          })
      }, HEARTBEAT_MS)
    },

    /** Internal: stop the heartbeat without touching `held` or `byLane`. */
    stopHeartbeat(): void {
      if (this.heartbeatId != null) {
        window.clearInterval(this.heartbeatId)
        this.heartbeatId = null
      }
    },

    /** Release whatever lane this client holds. Idempotent by design: a
     *  second call (or a third — drawer-close AND unmount AND route-leave can
     *  all fire for the same close) finds `held` already null and is a pure
     *  no-op, so it never sends a second DELETE and never throws. The DELETE
     *  itself is fire-and-forget — release() must not block or reject on a
     *  network hiccup, since the server-side TTL is the actual backstop
     *  (fleet-backend/src/lib/locks.ts's header comment). */
    release(): void {
      const laneId = this.held
      this.stopHeartbeat()
      this.held = null
      if (laneId == null) return
      releaseLock(laneId).catch(() => {
        // Best-effort. The lane will fall free on its own within the TTL if
        // this request never lands.
      })
    },

    /** Resync the full lock snapshot from the server (GET /locks) — e.g. when
     *  the board mounts, or as a periodic correction under a flaky socket.
     *  Replaces byLane wholesale; a failure leaves what we already knew in
     *  place rather than blanking the board's lock badges. */
    async refresh(): Promise<void> {
      try {
        const { locks } = await fetchLocks()
        const byLane: Record<string, Lock> = {}
        for (const lock of locks) byLane[lock.laneId] = lock
        this.byLane = byLane
      } catch {
        // auxiliary — never let a failed resync erase locally-known state
      }
    },

    /** Fold a `lane_lock` / `lane_unlock` realtime frame into byLane. Any
     *  other event type, or a payload missing `laneId`, is ignored.
     *
     *  Pinned rule: an event naming the lane THIS client currently holds
     *  (`laneId === this.held`) is ignored outright, for both event types.
     *  `lane_unlock` for our own lane is the case that matters most — it is
     *  either a stale/reordered frame or an echo of our own release() — and
     *  applying it here would silently drop the heartbeat's bookkeeping out
     *  from under an active hold. Our own `held`/heartbeat state is always
     *  more current than a fan-out echo of it. */
    applyEvent(evt: LockSocketEvent): void {
      const laneId = typeof evt.payload.laneId === 'string' ? evt.payload.laneId : null
      if (!laneId || laneId === this.held) return

      if (evt.type === 'lane_lock') {
        const dispatcherId = typeof evt.payload.dispatcherId === 'string' ? evt.payload.dispatcherId : ''
        const name = typeof evt.payload.by === 'string' ? evt.payload.by : 'Another dispatcher'
        const since = typeof evt.payload.since === 'number' ? evt.payload.since : Date.now()
        const lock: Lock = { laneId, orgId: null, dispatcherId, name, since, expiresAt: since + LOCK_TTL_MS }
        this.byLane = { ...this.byLane, [laneId]: lock }
      } else if (evt.type === 'lane_unlock' && laneId in this.byLane) {
        const next = { ...this.byLane }
        delete next[laneId]
        this.byLane = next
      }
    },

    /** The last known lock on a lane, or null when it's free (as far as this
     *  client knows). */
    heldBy(laneId: string): Lock | null {
      return this.byLane[laneId] ?? null
    },

    /** True when some OTHER dispatcher — not this client — holds the lane.
     *  Deliberately keyed off `held`, not a dispatcher-id comparison: this
     *  client is the one drawer/gesture surface that matters for "can I edit
     *  this lane right now," and `held` is exactly that answer. A lane this
     *  client itself locked from another browser tab reads as "other" here,
     *  same as any other dispatcher's hold — correct, since this tab isn't
     *  the one heartbeating it. */
    isLockedByOther(laneId: string): boolean {
      if (laneId === this.held) return false
      return this.byLane[laneId] != null
    },
  },
})
