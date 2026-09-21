import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireLock, fetchLocks, releaseLock, type Lock } from '../lib/api'
import { HEARTBEAT_MS, useLocksStore } from './locks'

vi.mock('../lib/api', () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  fetchLocks: vi.fn(),
}))

const mockedAcquire = vi.mocked(acquireLock)
const mockedRelease = vi.mocked(releaseLock)
const mockedFetchLocks = vi.mocked(fetchLocks)

const lockFor = (laneId: string, over: Partial<Lock> = {}): Lock => ({
  laneId,
  orgId: 'org-1',
  dispatcherId: 'disp-1',
  name: 'Dana Dispatcher',
  since: 1000,
  expiresAt: 91000,
  ...over,
})

describe('useLocksStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedAcquire.mockReset()
    mockedRelease.mockReset()
    mockedFetchLocks.mockReset()
    mockedRelease.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with nothing held and no known locks', () => {
    const store = useLocksStore()
    expect(store.held).toBeNull()
    expect(store.byLane).toEqual({})
  })

  describe('hold()', () => {
    it('acquires the lane, records the lock, and returns true', async () => {
      mockedAcquire.mockResolvedValueOnce({ lock: lockFor('d1') })
      const store = useLocksStore()

      const ok = await store.hold('d1')

      expect(ok).toBe(true)
      expect(mockedAcquire).toHaveBeenCalledWith('d1')
      expect(store.held).toBe('d1')
      expect(store.byLane.d1).toEqual(lockFor('d1'))
    })

    it('starts a 30s heartbeat that re-POSTs the same lane exactly once per interval', async () => {
      vi.useFakeTimers()
      mockedAcquire.mockResolvedValue({ lock: lockFor('d1') })
      const store = useLocksStore()

      await store.hold('d1')
      expect(mockedAcquire).toHaveBeenCalledTimes(1) // the initial acquire only

      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
      expect(mockedAcquire).toHaveBeenCalledTimes(2)
      expect(mockedAcquire).toHaveBeenLastCalledWith('d1')

      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
      expect(mockedAcquire).toHaveBeenCalledTimes(3)

      // Not yet due at 29.999s past the last beat.
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS - 1)
      expect(mockedAcquire).toHaveBeenCalledTimes(3)
    })

    it('a second hold() on the same already-held lane does not stack a second interval', async () => {
      vi.useFakeTimers()
      mockedAcquire.mockResolvedValue({ lock: lockFor('d1') })
      const store = useLocksStore()

      await store.hold('d1')
      await store.hold('d1')
      mockedAcquire.mockClear()

      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
      // One heartbeat, not two stacked ones.
      expect(mockedAcquire).toHaveBeenCalledTimes(1)
    })

    it('holding a different lane releases the previous one first', async () => {
      mockedAcquire.mockResolvedValueOnce({ lock: lockFor('d1') }).mockResolvedValueOnce({ lock: lockFor('d2') })
      const store = useLocksStore()

      await store.hold('d1')
      await store.hold('d2')

      expect(mockedRelease).toHaveBeenCalledWith('d1')
      expect(mockedRelease).toHaveBeenCalledTimes(1)
      expect(store.held).toBe('d2')
    })

    it('a 409 does not throw: it records the holder and resolves false', async () => {
      const holder = lockFor('d1', { dispatcherId: 'disp-2', name: 'Other Dispatcher' })
      mockedAcquire.mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 409, data: { error: 'ENTITY_ALREADY_LOCKED', lock: holder } },
      })
      const store = useLocksStore()

      const ok = await store.hold('d1')

      expect(ok).toBe(false)
      expect(store.held).toBeNull()
      expect(store.heldBy('d1')).toEqual(holder)
      expect(store.isLockedByOther('d1')).toBe(true)
    })

    it('a non-409 failure also does not throw and resolves false, with no holder recorded', async () => {
      mockedAcquire.mockRejectedValueOnce({ isAxiosError: true, response: { status: 500, data: {} } })
      const store = useLocksStore()

      const ok = await store.hold('d1')

      expect(ok).toBe(false)
      expect(store.held).toBeNull()
      expect(store.heldBy('d1')).toBeNull()
    })
  })

  describe('release()', () => {
    it('is idempotent: two calls send exactly one DELETE and neither throws', async () => {
      mockedAcquire.mockResolvedValueOnce({ lock: lockFor('d1') })
      const store = useLocksStore()
      await store.hold('d1')

      expect(() => store.release()).not.toThrow()
      expect(() => store.release()).not.toThrow()

      expect(mockedRelease).toHaveBeenCalledTimes(1)
      expect(mockedRelease).toHaveBeenCalledWith('d1')
      expect(store.held).toBeNull()
    })

    it('calling release() with nothing held sends no DELETE and does not throw', () => {
      const store = useLocksStore()
      expect(() => store.release()).not.toThrow()
      expect(mockedRelease).not.toHaveBeenCalled()
    })

    // Leak hazard (plan's explicit warning): an interval that outlives the
    // component keeps a lane locked for every other dispatcher until the 90s
    // TTL. This pins that release() — as called from onBeforeUnmount /
    // beforeRouteLeave — actually tears the heartbeat down, not just the
    // local `held` flag.
    it('stops the heartbeat — no further re-POSTs after release, even though the interval would otherwise still be running', async () => {
      vi.useFakeTimers()
      mockedAcquire.mockResolvedValue({ lock: lockFor('d1') })
      const store = useLocksStore()

      await store.hold('d1')
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
      expect(mockedAcquire).toHaveBeenCalledTimes(2)

      store.release()
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3)

      // Still 2: the acquire from hold() + the one heartbeat before release.
      // A leaking interval would have added 3 more calls here.
      expect(mockedAcquire).toHaveBeenCalledTimes(2)
    })
  })

  describe('applyEvent()', () => {
    it('lane_lock for another lane records the holder', () => {
      const store = useLocksStore()
      store.applyEvent({
        type: 'lane_lock',
        payload: { laneId: 'd2', by: 'Other Dispatcher', dispatcherId: 'disp-2', since: 5000 },
      })

      expect(store.heldBy('d2')).toEqual({
        laneId: 'd2', orgId: null, dispatcherId: 'disp-2', name: 'Other Dispatcher', since: 5000, expiresAt: 95000,
      })
      expect(store.isLockedByOther('d2')).toBe(true)
    })

    it('lane_unlock for another (known) lane clears it', () => {
      const store = useLocksStore()
      store.applyEvent({ type: 'lane_lock', payload: { laneId: 'd2', by: 'X', dispatcherId: 'disp-2', since: 1 } })
      store.applyEvent({ type: 'lane_unlock', payload: { laneId: 'd2' } })

      expect(store.heldBy('d2')).toBeNull()
      expect(store.isLockedByOther('d2')).toBe(false)
    })

    it('ignores a payload with no laneId rather than throwing', () => {
      const store = useLocksStore()
      expect(() => store.applyEvent({ type: 'lane_lock', payload: {} })).not.toThrow()
      expect(store.byLane).toEqual({})
    })

    // Pinned rule: a lane_unlock naming the lane WE believe we hold must not
    // silently drop our own heartbeat bookkeeping — trust our own state over
    // an echo (possibly stale, possibly our own release() reflected back).
    it('does not clear our own held lane on a lane_unlock echo for it', async () => {
      mockedAcquire.mockResolvedValueOnce({ lock: lockFor('d1') })
      const store = useLocksStore()
      await store.hold('d1')

      store.applyEvent({ type: 'lane_unlock', payload: { laneId: 'd1' } })

      expect(store.held).toBe('d1')
      expect(store.byLane.d1).toEqual(lockFor('d1'))
      expect(store.isLockedByOther('d1')).toBe(false)
    })

    it('also ignores a lane_lock echo for our own held lane', async () => {
      mockedAcquire.mockResolvedValueOnce({ lock: lockFor('d1') })
      const store = useLocksStore()
      await store.hold('d1')

      store.applyEvent({
        type: 'lane_lock',
        payload: { laneId: 'd1', by: 'Someone Else', dispatcherId: 'disp-9', since: 999 },
      })

      expect(store.held).toBe('d1')
      expect(store.byLane.d1).toEqual(lockFor('d1'))
    })
  })

  describe('refresh()', () => {
    it('replaces byLane wholesale from GET /locks', async () => {
      mockedFetchLocks.mockResolvedValueOnce({ locks: [lockFor('d1'), lockFor('d2', { dispatcherId: 'disp-2' })] })
      const store = useLocksStore()

      await store.refresh()

      expect(store.byLane.d1).toBeDefined()
      expect(store.byLane.d2).toBeDefined()
      expect(Object.keys(store.byLane)).toHaveLength(2)
    })

    it('a stale lane not present in a later refresh is dropped', async () => {
      mockedFetchLocks.mockResolvedValueOnce({ locks: [lockFor('d1')] })
      const store = useLocksStore()
      await store.refresh()
      expect(store.byLane.d1).toBeDefined()

      mockedFetchLocks.mockResolvedValueOnce({ locks: [] })
      await store.refresh()
      expect(store.byLane).toEqual({})
    })

    it('a failed refresh leaves previously-known locks in place', async () => {
      mockedFetchLocks.mockResolvedValueOnce({ locks: [lockFor('d1')] })
      const store = useLocksStore()
      await store.refresh()

      mockedFetchLocks.mockRejectedValueOnce(new Error('network down'))
      await expect(store.refresh()).resolves.toBeUndefined()

      expect(store.byLane.d1).toBeDefined()
    })
  })

  describe('heldBy() / isLockedByOther()', () => {
    it('reports free when no lock is known for the lane', () => {
      const store = useLocksStore()
      expect(store.heldBy('d1')).toBeNull()
      expect(store.isLockedByOther('d1')).toBe(false)
    })

    it('a lane this client itself holds is never "locked by other"', async () => {
      mockedAcquire.mockResolvedValueOnce({ lock: lockFor('d1') })
      const store = useLocksStore()
      await store.hold('d1')

      expect(store.isLockedByOther('d1')).toBe(false)
    })
  })
})
