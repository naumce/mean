import { defineStore } from 'pinia'
import { acquireLoadLock, fetchLoadLocks, heartbeatLoadLock, releaseLoadLock, type LoadLock } from '../lib/api'
import { subscribe, type Frame } from '../lib/realtime'
import { useAuthStore } from './auth'

/** A third of the server's 60 s TTL: two heartbeats can be lost before a
 *  held load looks free to anyone else. */
export const LOAD_HEARTBEAT_MS = 20_000
const LOAD_LOCK_TTL_MS = 60_000
/** How often the badge clock moves while the board is listening (F2). Fine
 *  enough that a badge nobody released disappears within a few seconds of the
 *  server's own TTL, coarse enough to be free. */
export const LOAD_LOCK_TICK_MS = 5_000

function lockFromError(error: unknown): LoadLock | null {
  return (error as { response?: { data?: { lock?: LoadLock } } })?.response?.data?.lock ?? null
}

interface LoadLocksState {
  /** The loads THIS tab holds and heartbeats, each with its own timer.
   *  A map, not one id (F4): a dispatcher tabbing across a row starts
   *  editing the next load before the previous one's save has landed, and
   *  taking the second lock must never drop the first. */
  held: Record<string, { heartbeatId: number }>
  /** Last known lock per load — ours and theirs — from the snapshot, the
   *  acquire/heartbeat responses and the socket. */
  byLoad: Record<string, LoadLock>
  /** The badge clock (F2). A lock is a fact with an expiry, and the server is
   *  the authority on it: a `load_unlock` that never arrives (a dropped
   *  socket, a crashed tab) must not leave a row read-only forever. Ticked
   *  only while `listen()` is active. */
  now: number
  tickId: number | null
  /** Frames that arrived while `refresh()`'s GET was in flight, so they can
   *  be re-applied over the snapshot they are newer than (F7). */
  inFlight: Frame[] | null
  unsubscribe: (() => void) | null
}

export const useLoadLocksStore = defineStore('loadLocks', {
  state: (): LoadLocksState => ({ held: {}, byLoad: {}, now: Date.now(), tickId: null, inFlight: null, unsubscribe: null }),
  getters: {
    /** Locks held by someone other than this dispatcher, and not yet expired
     *  — what a row badge shows and what makes a row read-only.
     *
     *  Before login nothing is "theirs" (B4): with no dispatcher id every
     *  lock would compare unequal to `null` and the whole board would render
     *  read-only, badged with names.  */
    theirs(state): Record<string, LoadLock> {
      const me = useAuthStore().dispatcher?.id ?? null
      if (me === null) return {}
      const out: Record<string, LoadLock> = {}
      for (const [id, l] of Object.entries(state.byLoad)) {
        if (l.dispatcherId === me) continue
        if (l.expiresAt <= state.now) continue
        out[id] = l
      }
      return out
    },
    heldBy: (state) => (loadId: string): LoadLock | null => state.byLoad[loadId] ?? null,
    /** Whether this tab holds a given load. */
    holds: (state) => (loadId: string): boolean => state.held[loadId] !== undefined,
  },
  actions: {
    /** Take (or re-affirm) a load. `false` means someone else has it — their
     *  lock is recorded so the badge can name them.
     *
     *  F4: holding a new load NEVER releases another. The view decides when
     *  each load's lock has done its job (its editor closed and its saves
     *  settled); this only takes them. */
    async hold(loadId: string): Promise<boolean> {
      if (this.held[loadId]) return true
      try {
        const { lock } = await acquireLoadLock(loadId)
        this.byLoad = { ...this.byLoad, [loadId]: lock }
        this.startHeartbeat(loadId)
        return true
      } catch (error) {
        const lock = lockFromError(error)
        if (lock) this.byLoad = { ...this.byLoad, [loadId]: lock }
        return false
      }
    },
    startHeartbeat(loadId: string): void {
      this.stopHeartbeat(loadId)
      const heartbeatId = window.setInterval(() => {
        heartbeatLoadLock(loadId)
          .then(({ lock }) => { this.byLoad = { ...this.byLoad, [loadId]: lock } })
          .catch(() => { /* the next write's baseVersion is the backstop (spec §7.4) */ })
      }, LOAD_HEARTBEAT_MS)
      this.held = { ...this.held, [loadId]: { heartbeatId } }
    },
    stopHeartbeat(loadId: string): void {
      const entry = this.held[loadId]
      if (!entry) return
      window.clearInterval(entry.heartbeatId)
      const { [loadId]: _gone, ...rest } = this.held
      this.held = rest
    },
    /** Idempotent: releasing a load this tab does not hold is fine, so blur,
     *  unmount and route-leave can all call it. */
    release(loadId: string): void {
      if (!this.held[loadId]) return
      this.stopHeartbeat(loadId)
      const { [loadId]: _mine, ...rest } = this.byLoad
      this.byLoad = rest
      releaseLoadLock(loadId).catch(() => { /* the TTL releases it */ })
    },
    /** Everything this tab holds — unmount, route-leave, logout. */
    releaseAll(): void {
      for (const loadId of Object.keys(this.held)) this.release(loadId)
    },
    async refresh(): Promise<void> {
      // F7: a frame that lands while this GET is in flight is NEWER than the
      // snapshot it would be overwritten by. Collect those and re-apply them
      // on top — otherwise a `load_unlock` that arrived mid-fetch left the
      // badge on the row for a lock that was already gone.
      this.inFlight = []
      try {
        const { locks } = await fetchLoadLocks()
        const byLoad: Record<string, LoadLock> = {}
        for (const l of locks) byLoad[l.loadId] = l
        this.byLoad = byLoad
        const during = this.inFlight ?? []
        this.inFlight = null
        for (const f of during) this.applyEvent(f)
      } catch { /* badges are a courtesy; the server still refuses */ }
      finally { this.inFlight = null }
    },
    applyEvent(frame: Frame): void {
      if (this.inFlight) this.inFlight = [...this.inFlight, frame]
      if (frame.type === 'load_lock' && typeof frame.loadId === 'string') {
        const since = Number(frame.since ?? Date.now())
        const l: LoadLock = { loadId: frame.loadId, orgId: String(frame.orgId ?? ''), dispatcherId: String(frame.dispatcherId ?? ''), by: String(frame.by ?? ''), since, expiresAt: since + LOAD_LOCK_TTL_MS }
        this.byLoad = { ...this.byLoad, [l.loadId]: l }
      } else if (frame.type === 'load_unlock' && typeof frame.loadId === 'string') {
        const { [frame.loadId]: _gone, ...rest } = this.byLoad
        this.byLoad = rest
      }
    },
    listen(): void {
      if (this.unsubscribe) return
      // Subscribe FIRST, then read the snapshot (F7): the other order has a
      // window in which a frame is neither in the snapshot nor delivered.
      const offLock = subscribe('load_lock', (f) => this.applyEvent(f))
      const offUnlock = subscribe('load_unlock', (f) => this.applyEvent(f))
      // A reconnect means the socket missed whatever happened while it was
      // down; the snapshot is the only way back to the truth.
      const offOpen = subscribe('$open', () => { void this.refresh() })
      this.unsubscribe = () => { offLock(); offUnlock(); offOpen() }
      this.now = Date.now()
      this.tickId = window.setInterval(() => { this.now = Date.now() }, LOAD_LOCK_TICK_MS)
      void this.refresh()
    },
    unlisten(): void {
      this.unsubscribe?.()
      this.unsubscribe = null
      if (this.tickId != null) { window.clearInterval(this.tickId); this.tickId = null }
    },
  },
})
