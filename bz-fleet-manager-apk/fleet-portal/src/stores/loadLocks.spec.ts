import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api', () => ({
  acquireLoadLock: vi.fn(),
  heartbeatLoadLock: vi.fn(),
  releaseLoadLock: vi.fn(),
  fetchLoadLocks: vi.fn(),
}))
const handlers = new Map<string, (f: { type: string } & Record<string, unknown>) => void>()
vi.mock('../lib/realtime', () => ({
  subscribe: vi.fn((type: string, h: (f: { type: string } & Record<string, unknown>) => void) => {
    handlers.set(type, h)
    return () => handlers.delete(type)
  }),
}))

import * as api from '../lib/api'
import { DISPATCHER_STORAGE_KEY } from '../lib/constants'
import { LOAD_HEARTBEAT_MS, LOAD_LOCK_TICK_MS, useLoadLocksStore } from './loadLocks'
import { useAuthStore } from './auth'

const T0 = 1_760_000_000_000
const lock = (loadId: string, dispatcherId: string, by: string, expiresAt = T0 + 60_000) =>
  ({ loadId, orgId: 'o', dispatcherId, by, since: T0, expiresAt })

const signedIn = () => { useAuthStore().dispatcher = { id: 'me', email: 'me@x.com', name: 'Me' } as never }

describe('stores/loadLocks', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    handlers.clear()
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    vi.mocked(api.releaseLoadLock).mockResolvedValue()
    vi.mocked(api.fetchLoadLocks).mockResolvedValue({ locks: [] })
  })
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); localStorage.clear() })

  it('holds a load, heartbeats every 20 s, and releases on demand', async () => {
    vi.mocked(api.acquireLoadLock).mockResolvedValue({ lock: lock('a', 'me', 'Me') })
    vi.mocked(api.heartbeatLoadLock).mockResolvedValue({ lock: lock('a', 'me', 'Me') })
    const s = useLoadLocksStore()
    expect(await s.hold('a')).toBe(true)
    expect(s.holds('a')).toBe(true)
    vi.advanceTimersByTime(LOAD_HEARTBEAT_MS)
    expect(api.heartbeatLoadLock).toHaveBeenCalledWith('a')
    s.release('a')
    expect(s.holds('a')).toBe(false)
    expect(api.releaseLoadLock).toHaveBeenCalledWith('a')
    vi.advanceTimersByTime(LOAD_HEARTBEAT_MS * 2)
    expect(api.heartbeatLoadLock).toHaveBeenCalledTimes(1)
  })

  it("reports the holder when refused, and shows only other people's locks as theirs", async () => {
    signedIn()
    vi.mocked(api.acquireLoadLock).mockRejectedValue({ response: { status: 409, data: { error: 'LOAD_LOCKED', lock: lock('a', 'maria', 'Maria') } } })
    const s = useLoadLocksStore()
    expect(await s.hold('a')).toBe(false)
    expect(s.heldBy('a')?.by).toBe('Maria')
    s.applyEvent({ type: 'load_lock', loadId: 'b', dispatcherId: 'me', by: 'Me', since: T0 })
    s.applyEvent({ type: 'load_lock', loadId: 'c', dispatcherId: 'jake', by: 'Jake', since: T0 })
    expect(Object.keys(s.theirs).sort()).toEqual(['a', 'c'])
    s.applyEvent({ type: 'load_unlock', loadId: 'c' })
    expect(Object.keys(s.theirs)).toEqual(['a'])
  })

  // --- F4: several loads at once -----------------------------------------

  it('holds SEVERAL loads at once, each with its own heartbeat, and never drops one to take another', async () => {
    signedIn()
    vi.mocked(api.acquireLoadLock).mockImplementation(async (id: string) => ({ lock: lock(id, 'me', 'Me') }))
    vi.mocked(api.heartbeatLoadLock).mockImplementation(async (id: string) => ({ lock: lock(id, 'me', 'Me') }))
    const s = useLoadLocksStore()
    expect(await s.hold('a')).toBe(true)
    expect(await s.hold('b')).toBe(true)
    // Taking b released nothing.
    expect(api.releaseLoadLock).not.toHaveBeenCalled()
    expect(s.holds('a')).toBe(true)
    expect(s.holds('b')).toBe(true)
    vi.advanceTimersByTime(LOAD_HEARTBEAT_MS)
    expect(api.heartbeatLoadLock).toHaveBeenCalledWith('a')
    expect(api.heartbeatLoadLock).toHaveBeenCalledWith('b')

    s.release('a')
    expect(api.releaseLoadLock).toHaveBeenCalledWith('a')
    expect(s.holds('b')).toBe(true)
    s.releaseAll()
    expect(api.releaseLoadLock).toHaveBeenCalledWith('b')
    expect(Object.keys(s.held)).toEqual([])
  })

  it('releasing a load this tab does not hold is a no-op', () => {
    const s = useLoadLocksStore()
    s.release('nope')
    expect(api.releaseLoadLock).not.toHaveBeenCalled()
  })

  // --- F2: a badge expires; the server is the authority -------------------

  it('drops a badge once its lock has expired, without waiting for a load_unlock that may never come', () => {
    signedIn()
    const s = useLoadLocksStore()
    s.listen()
    s.applyEvent({ type: 'load_lock', loadId: 'a', dispatcherId: 'maria', by: 'Maria', since: T0 })
    expect(Object.keys(s.theirs)).toEqual(['a'])
    // The socket dropped and no load_unlock ever arrived. The clock does it.
    vi.setSystemTime(T0 + 61_000)
    vi.advanceTimersByTime(LOAD_LOCK_TICK_MS)
    expect(s.theirs).toEqual({})
    s.unlisten()
    // And the clock stops with the listener.
    const stopped = s.now
    vi.setSystemTime(T0 + 200_000)
    vi.advanceTimersByTime(LOAD_LOCK_TICK_MS * 3)
    expect(s.now).toBe(stopped)
  })

  it('replaces a synthesized expiry with the real one from an acquire', async () => {
    signedIn()
    const s = useLoadLocksStore()
    s.applyEvent({ type: 'load_lock', loadId: 'a', dispatcherId: 'maria', by: 'Maria', since: T0 })
    expect(s.heldBy('a')?.expiresAt).toBe(T0 + 60_000)
    vi.mocked(api.acquireLoadLock).mockResolvedValue({ lock: lock('a', 'me', 'Me', T0 + 999_000) })
    await s.hold('a')
    expect(s.heldBy('a')?.expiresAt).toBe(T0 + 999_000)
  })

  // --- B4: nothing is "theirs" before login -------------------------------

  it('shows nothing as theirs when no dispatcher is signed in', () => {
    const s = useLoadLocksStore()
    s.applyEvent({ type: 'load_lock', loadId: 'a', dispatcherId: 'maria', by: 'Maria', since: T0 })
    expect(useAuthStore().dispatcher).toBeNull()
    expect(s.theirs).toEqual({})
  })

  it('shows a foreign lock as theirs when the dispatcher was rehydrated from storage, not freshly logged in', () => {
    // The regression this guards against: a resumed session (page reload,
    // reopened tab) sets auth.dispatcher via the store's own rehydration
    // path (reading its storage key at store creation), never through
    // login()/signup(). The signedIn() helper above sets the field directly
    // and would pass even if the auth store never persisted or rehydrated
    // anything — so this test goes through the real path instead, by
    // seeding localStorage before the auth store is ever instantiated. This
    // is the test that would have caught the dispatcher never being
    // persisted/rehydrated in the first place.
    localStorage.setItem(DISPATCHER_STORAGE_KEY, JSON.stringify({
      id: 'me', email: 'me@x.com', name: 'Me', createdAt: '2026-01-01',
    }))
    const s = useLoadLocksStore()
    s.byLoad = { a: lock('a', 'maria', 'Maria') }

    expect(useAuthStore().dispatcher?.id).toBe('me')
    expect(s.theirs).toEqual({ a: lock('a', 'maria', 'Maria') })
  })

  // --- F7: the snapshot vs the frames -------------------------------------

  it('lets a frame that arrives DURING refresh win over the snapshot it is newer than', async () => {
    signedIn()
    const s = useLoadLocksStore()
    let release!: (v: { locks: ReturnType<typeof lock>[] }) => void
    vi.mocked(api.fetchLoadLocks).mockReturnValue(new Promise((r) => { release = r }))
    const pending = s.refresh()
    // The unlock lands while the GET is still in flight.
    s.applyEvent({ type: 'load_unlock', loadId: 'a' })
    release({ locks: [lock('a', 'maria', 'Maria')] })
    await pending
    expect(s.theirs).toEqual({})
  })

  it('re-reads the snapshot when the socket reconnects', async () => {
    signedIn()
    const s = useLoadLocksStore()
    s.listen()
    await Promise.resolve()
    expect(api.fetchLoadLocks).toHaveBeenCalledTimes(1)
    expect(handlers.has('$open')).toBe(true)
    vi.mocked(api.fetchLoadLocks).mockResolvedValue({ locks: [lock('a', 'maria', 'Maria')] })
    handlers.get('$open')!({ type: '$open' })
    await vi.waitFor(() => expect(api.fetchLoadLocks).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(Object.keys(s.theirs)).toEqual(['a']))
    s.unlisten()
  })
})
