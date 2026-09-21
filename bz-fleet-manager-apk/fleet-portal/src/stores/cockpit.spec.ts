import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireLoadLock, acquireLock, api, createAssignment, fetchDetention, pairDriver, planAssignment, releaseLoadLock, releaseLock, type Lock, type LoadLock, type PlanResult, type StopDetention } from '../lib/api'
import { useCockpitStore } from './cockpit'
import { useLoadboardStore, type BoardLoad } from './loadboard'
import { useLoadLocksStore } from './loadLocks'
import { useLocksStore } from './locks'

// A4 Task 8: cockpit.ts's own connectRealtime subscribes directly to the
// shared socket — mocked the same way loadLocks.spec.ts mocks it, a map of
// frame type -> the one handler each type gets.
const realtimeHandlers = new Map<string, (f: { type: string } & Record<string, unknown>) => void>()
vi.mock('../lib/realtime', () => ({
  subscribe: vi.fn((type: string, h: (f: { type: string } & Record<string, unknown>) => void) => {
    realtimeHandlers.set(type, h)
    return () => realtimeHandlers.delete(type)
  }),
}))

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  API_BASE_URL: 'http://localhost:3001/api',
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  fetchLocks: vi.fn(),
  planAssignment: vi.fn(),
  createAssignment: vi.fn(),
  pairDriver: vi.fn(),
  fetchDetention: vi.fn(),
  // A2 Load Locks, Task 9: runGesture now also holds/releases the load lock
  // (`useLoadLocksStore`) beside the lane lock — its store hits these three
  // directly, same as the lane lock hits acquireLock/releaseLock above.
  acquireLoadLock: vi.fn(),
  releaseLoadLock: vi.fn(),
  heartbeatLoadLock: vi.fn(),
  fetchLoadLocks: vi.fn(),
}))
const mockedGet = vi.mocked(api.get)
const mockedAcquireLock = vi.mocked(acquireLock)
const mockedReleaseLock = vi.mocked(releaseLock)
const mockedPlanAssignment = vi.mocked(planAssignment)
const mockedCreateAssignment = vi.mocked(createAssignment)
const mockedPairDriver = vi.mocked(pairDriver)
const mockedFetchDetention = vi.mocked(fetchDetention)
const mockedAcquireLoadLock = vi.mocked(acquireLoadLock)
const mockedReleaseLoadLock = vi.mocked(releaseLoadLock)

const NOW = Date.UTC(2026, 7, 28, 19, 32) // Fri 14:32 CDT
const iso = (ms: number) => new Date(ms).toISOString()
const load = (over: Partial<BoardLoad>): BoardLoad => ({
  id: 'l1', reference: 'L-1', status: 'open', requiredEquip: 'DryVan', hazmatClass: null, revenueCents: 1000,
  stopCount: 2, origin: 'Kansas City', destination: 'Chicago', assignment: null, ...over,
})
const payload = {
  lanes: [{ id: 'd1', name: 'Jake Morrow', status: 'active' }],
  tractors: [{ id: 't1', unit: '1207', make: null, cab: 'Sleeper', status: 'active', inspectionExpiresAt: null, registrationExpiresAt: null, nextServiceAt: null, currentDriverId: 'd1' }],
  trailers: [],
  loads: [
    load({ id: 'l1', reference: 'L-1', status: 'assigned', assignment: { id: 'a1', driverId: 'd1', tractorId: 't1', status: 'assigned', plannedStart: iso(NOW + 3_600_000), plannedEnd: iso(NOW + 7_200_000), marginCents: 1 } }),
    load({ id: 'l2', reference: 'L-2', pickupWindowEnd: iso(NOW + 5 * 3_600_000) }),
    load({ id: 'l3', reference: 'L-3', hazmatClass: '8', pickupWindowEnd: iso(NOW + 2 * 3_600_000), brokerName: 'Landstar' }),
    load({ id: 'l4', reference: 'L-4', status: 'tendered' }),
  ],
}

const lockFor = (laneId: string, over: Partial<Lock> = {}): Lock => ({
  laneId, orgId: 'org-1', dispatcherId: 'disp-1', name: 'Dana Dispatcher', since: 1000, expiresAt: 91000, ...over,
})

const loadLockFor = (loadId: string, over: Partial<LoadLock> = {}): LoadLock => ({
  loadId, orgId: 'org-1', dispatcherId: 'disp-1', by: 'Dana Dispatcher', since: 1000, expiresAt: 61000, ...over,
})

describe('cockpit store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    realtimeHandlers.clear()
    mockedGet.mockReset()
    mockedGet.mockResolvedValue({ data: payload })
    mockedAcquireLock.mockReset()
    mockedAcquireLock.mockResolvedValue({ lock: lockFor('d1') })
    mockedReleaseLock.mockReset()
    mockedReleaseLock.mockResolvedValue(undefined)
    mockedAcquireLoadLock.mockReset()
    mockedAcquireLoadLock.mockResolvedValue({ lock: loadLockFor('l1') })
    mockedReleaseLoadLock.mockReset()
    mockedReleaseLoadLock.mockResolvedValue(undefined)
    mockedPlanAssignment.mockReset()
    mockedCreateAssignment.mockReset()
    mockedPairDriver.mockReset()
    mockedFetchDetention.mockReset()
  })

  it('init sets the org tz + today, and syncs a whole-day window onto the loadboard store', async () => {
    const store = useCockpitStore()
    store.init('America/Chicago', NOW)
    expect(store.day0).toBe('2026-08-28')
    expect(store.config).toMatchObject({ tz: 'America/Chicago', days: 3, dayStartHour: 6, dayEndHour: 24, pxPerHour: 22 })
    await store.reload()
    expect(useLoadboardStore().windowOverride).toEqual({ from: '2026-08-28T05:00:00.000Z', to: '2026-08-31T05:00:00.000Z' })
    expect(mockedGet).toHaveBeenCalledWith('/dispatcher/loadboard', { params: { from: '2026-08-28T05:00:00.000Z', to: '2026-08-31T05:00:00.000Z' } })
  })

  it('window controls: day presets set the zoom, shifting moves day0, today snaps back', async () => {
    const store = useCockpitStore()
    store.init('America/Chicago', NOW)
    await store.setDays(1)
    expect(store.pxPerHour).toBe(60)
    await store.shiftDays(2)
    expect(store.day0).toBe('2026-08-30')
    await store.goToToday(NOW)
    expect(store.day0).toBe('2026-08-28')
    store.setZoom(999)
    expect(store.pxPerHour).toBe(72)
    store.setZoom(1)
    expect(store.pxPerHour).toBe(10)
  })

  it('projects lanes per grouping from the loadboard store and sorts the backlog by urgency', async () => {
    const store = useCockpitStore()
    store.init('America/Chicago', NOW)
    await store.reload()
    expect(store.lanes.map((l) => l.id)).toEqual(['d1'])
    expect(store.lanes[0].legs.map((l) => l.id)).toEqual(['l1'])
    store.setGroupBy('tractor')
    expect(store.lanes[0]).toMatchObject({ kind: 'tractor', name: '#1207' })
    expect(store.backlog.map((l) => l.id)).toEqual(['l3', 'l2', 'l4']) // tightest window first, no-appointment last
  })

  it('filters and spotting', async () => {
    const store = useCockpitStore()
    store.init('America/Chicago', NOW)
    await store.reload()
    const lb = useLoadboardStore()
    store.setFilter('haz')
    expect(lb.loads.filter((l) => store.matchesFilter(l)).map((l) => l.id)).toEqual(['l3'])
    store.setFilter('tendered')
    expect(lb.loads.filter((l) => store.matchesFilter(l)).map((l) => l.id)).toEqual(['l4'])
    store.setFilter('all')
    store.setEquip('Reefer')
    expect(lb.loads.filter((l) => store.matchesFilter(l))).toEqual([])
    store.setEquip('all')
    store.setSearch('landstar')
    expect(lb.loads.filter((l) => store.matchesSearch(l)).map((l) => l.id)).toEqual(['l3'])
    store.setSearch('jake')
    expect(store.matchesSearch(lb.loads[0], 'Jake Morrow')).toBe(true)
    store.setSearch('')
    expect(store.matchesSearch(lb.loads[0])).toBe(true)
  })

  it('conflictLoadIds guards against a malformed alerts payload instead of throwing', async () => {
    const store = useCockpitStore()
    store.init('America/Chicago', NOW)
    await store.reload()
    const lb = useLoadboardStore()
    lb.alerts = undefined as unknown as typeof lb.alerts
    expect(() => store.conflictLoadIds).not.toThrow()
    expect(store.conflictLoadIds).toEqual(new Set())
  })

  it('activity feed + toasts: newest first, capped, unread count, toasts capped at 4', () => {
    const store = useCockpitStore()
    for (let i = 0; i < 70; i++) store.pushActivity('feed', `t${i}`, 's', null, NOW + i)
    expect(store.activity).toHaveLength(60)
    expect(store.activity[0].title).toBe('t69')
    expect(store.unreadActivity).toBe(60)
    expect(store.toasts).toHaveLength(4)
    store.dismissToast(store.toasts[0].id)
    expect(store.toasts).toHaveLength(3)
    store.markAllRead()
    expect(store.unreadActivity).toBe(0)
  })

  it('translates realtime frames into feed lines with the load reference', async () => {
    const store = useCockpitStore()
    store.init('America/Chicago', NOW)
    await store.reload()
    store.ingestEvent({ type: 'board_update', payload: { loadId: 'l1', unassigned: true } })
    expect(store.activity[0]).toMatchObject({ kind: 'conflict', title: 'L-1 unassigned', loadId: 'l1' })
    store.ingestEvent({ type: 'board_update', payload: { source: 'webhook', imported: 3 } })
    expect(store.activity[0].title).toBe('Board 3 loads pushed by webhook')
    store.ingestEvent({ type: 'driver_status', payload: { driverId: 'd1', status: 'on_break' } })
    expect(store.activity[0].title).toBe('Jake Morrow on break')
    store.ingestEvent({ type: 'driver_location', payload: { driverId: 'd1' } })
    expect(store.activity[0].title).toBe('Jake Morrow on break') // location frames are radar-only
    // A4 Task 8: the load_changed arm — A4 Task 1's frame shape is
    // { orgId, loadId, version, fields }. Names the load and the fields that
    // changed; never refetches (Task 6's loadboard store already did).
    store.ingestEvent({ type: 'load_changed', payload: { loadId: 'l1', version: 4, fields: ['rate', 'status'] } })
    expect(store.activity[0]).toMatchObject({ kind: 'feed', title: 'L-1 changed', sub: 'rate, status', loadId: 'l1' })
  })

  // A4 Task 8: the Cockpit no longer reaches the feed by watching
  // loadboard's `lastEvent` (CockpitView.vue) — it subscribes to the shared
  // socket directly, the same shape as loadboard.ts's/tracking.ts's own
  // connectRealtime.
  describe('connectRealtime', () => {
    it('subscribes to board_update, driver_status and load_changed, feeding every frame to ingestEvent', async () => {
      const store = useCockpitStore()
      store.init('America/Chicago', NOW)
      await store.reload()

      store.connectRealtime()
      expect(realtimeHandlers.has('board_update')).toBe(true)
      expect(realtimeHandlers.has('driver_status')).toBe(true)
      expect(realtimeHandlers.has('load_changed')).toBe(true)

      realtimeHandlers.get('board_update')!({ type: 'board_update', loadId: 'l1', unassigned: true })
      expect(store.activity[0]).toMatchObject({ kind: 'conflict', title: 'L-1 unassigned' })

      realtimeHandlers.get('driver_status')!({ type: 'driver_status', driverId: 'd1', status: 'on_break' })
      expect(store.activity[0].title).toBe('Jake Morrow on break')

      realtimeHandlers.get('load_changed')!({ type: 'load_changed', loadId: 'l1', version: 4, fields: ['rate'] })
      expect(store.activity[0]).toMatchObject({ title: 'L-1 changed', sub: 'rate' })
    })

    it('a second call does not add a second subscription', () => {
      const store = useCockpitStore()
      store.connectRealtime()
      const first = store.realtimeUnsubscribe
      store.connectRealtime()
      expect(store.realtimeUnsubscribe).toBe(first)
    })

    it('disconnectRealtime tears every subscription down and is idempotent', () => {
      const store = useCockpitStore()
      store.connectRealtime()
      store.disconnectRealtime()
      expect(realtimeHandlers.has('board_update')).toBe(false)
      expect(realtimeHandlers.has('driver_status')).toBe(false)
      expect(realtimeHandlers.has('load_changed')).toBe(false)
      expect(store.realtimeUnsubscribe).toBeNull()
      expect(() => store.disconnectRealtime()).not.toThrow()
    })
  })

  // T2 "Map as Navigation", Task 4: the one thing a map popup's "Show on
  // board" (and CockpitView's own jumpTo, for the schematic radar and the
  // activity/toast "jump" links) needs — select the load, switch to the
  // board view, and attempt to scroll that brick into view.
  it('focusOnBoard selects the load, switches to the board view, and scrolls the matching brick into view', () => {
    const store = useCockpitStore()
    store.setView('radar')
    const brick = document.createElement('div')
    brick.setAttribute('data-load', 'l7')
    document.body.appendChild(brick)
    const scrollIntoView = vi.fn()
    brick.scrollIntoView = scrollIntoView
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })

    store.focusOnBoard('l7')

    expect(store.view).toBe('board')
    expect(store.selectedLoadId).toBe('l7')
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', inline: 'center', block: 'center' })

    rafSpy.mockRestore()
    document.body.removeChild(brick)
  })

  it('focusOnBoard does not throw when no matching brick is on the page (a fresh board reload, a stale id)', () => {
    const store = useCockpitStore()
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    expect(() => store.focusOnBoard('does-not-exist')).not.toThrow()
    expect(store.selectedLoadId).toBe('does-not-exist')
    rafSpy.mockRestore()
  })

  // T2 "Map as Navigation", Task 5: the reverse of focusOnBoard — the
  // board's (drawer's) "Show on map" jump. The actual centring is
  // FleetMap.vue's job (see FleetMap.spec.ts); this store action only owns
  // the view switch + selection + carrying the one-shot centring request.
  it('focusOnMap selects the load, switches to the radar/map view, and sets a pending mapFocusLoadId', () => {
    const store = useCockpitStore()
    store.setView('board')
    store.focusOnMap('l7')
    expect(store.view).toBe('radar')
    expect(store.selectedLoadId).toBe('l7')
    expect(store.mapFocusLoadId).toBe('l7')
  })

  it('clearMapFocus consumes the pending request without touching view/selection', () => {
    const store = useCockpitStore()
    store.focusOnMap('l7')
    store.clearMapFocus()
    expect(store.mapFocusLoadId).toBeNull()
    expect(store.view).toBe('radar')
    expect(store.selectedLoadId).toBe('l7')
  })

  // Cockpit S2b Task 4: the gesture pipeline every drag (move/resize/drop)
  // funnels through. `call` stands in for the caller's planAssignment/
  // createAssignment closure so the pipeline's sequencing is pinned
  // independent of which endpoint a given gesture uses.
  describe('gesture pipeline (runGesture)', () => {
    const planFixture = { proposedStart: 0, proposedEnd: 1, deadheadMi: 10, loadedMi: 100, driveMin: 200, onDutyMin: 300, needsBreak: false }
    const econFixture = { revenueCents: 50000, totalMi: 110, deadheadMi: 10, loadedMi: 100, estCostCents: 30000, marginCents: 20000, marginPct: 0.4, ratePerLoadedMiCents: 200, ratePerTotalMiCents: 180 }
    const feasible = (over: Partial<PlanResult> = {}): PlanResult => ({ feasible: true, conflicts: [], plan: planFixture, economics: econFixture, ...over })
    const blocked = (over: Partial<PlanResult> = {}): PlanResult => ({
      feasible: false, conflicts: [{ kind: 'hos', severity: 'block', detail: 'not enough drive time' }], plan: planFixture, economics: econFixture, ...over,
    })

    it('dry-runs before committing on a feasible gesture, then refreshes the board and toasts', async () => {
      const store = useCockpitStore()
      store.init('America/Chicago', NOW)
      await store.reload()
      mockedGet.mockClear()
      const call = vi.fn().mockResolvedValue(feasible())

      await store.runGesture('d1', 'l1', call)

      expect(call).toHaveBeenCalledTimes(2)
      expect(call).toHaveBeenNthCalledWith(1, true, false) // dry-run first
      expect(call).toHaveBeenNthCalledWith(2, false, false) // then the real write
      expect(mockedGet).toHaveBeenCalledWith('/dispatcher/loadboard', expect.anything()) // refreshBoard ran
      expect(store.toasts.at(-1)).toMatchObject({ kind: 'plan' })
    })

    it('a blocked dry-run preview opens the verdict modal, commits nothing, and never touches the board', async () => {
      const store = useCockpitStore()
      store.init('America/Chicago', NOW)
      await store.reload()
      mockedGet.mockClear()
      const call = vi.fn().mockResolvedValueOnce(blocked())

      await store.runGesture('d1', 'l1', call)

      expect(call).toHaveBeenCalledTimes(1) // the dry-run only — no commit attempt
      expect(call).toHaveBeenCalledWith(true, false)
      expect(store.verdict).toMatchObject({ feasible: false })
      expect(store.verdict!.conflicts[0].detail).toBe('not enough drive time')
      expect(mockedGet).not.toHaveBeenCalled() // refreshBoard never ran: nothing to mutate the board with
    })

    it('Force re-calls the pending commit with force:true', async () => {
      const store = useCockpitStore()
      store.init('America/Chicago', NOW)
      await store.reload()
      const call = vi.fn().mockResolvedValueOnce(blocked()).mockResolvedValueOnce(feasible())
      await store.runGesture('d1', 'l1', call)
      expect(call).toHaveBeenCalledTimes(1)

      await store.forceVerdict()

      expect(call).toHaveBeenCalledTimes(2)
      expect(call).toHaveBeenNthCalledWith(2, false, true)
      expect(store.verdict).toBeNull() // the forced commit succeeded, closing the modal
    })

    it('Cancel discards the pending retry — a later forceVerdict is a no-op', async () => {
      const store = useCockpitStore()
      const call = vi.fn().mockResolvedValueOnce(blocked())
      await store.runGesture('d1', 'l1', call)

      store.cancelVerdict()
      expect(store.verdict).toBeNull()

      await store.forceVerdict()
      expect(call).toHaveBeenCalledTimes(1) // never re-invoked
    })

    it('a 409 on the commit itself shows the lock toast naming the holder, and refreshes', async () => {
      const store = useCockpitStore()
      store.init('America/Chicago', NOW)
      await store.reload()
      mockedGet.mockClear()
      const holder = lockFor('d1', { dispatcherId: 'disp-9', name: 'Marta Ops' })
      const call = vi.fn()
        .mockResolvedValueOnce(feasible())
        .mockRejectedValueOnce({ isAxiosError: true, response: { status: 409, data: { error: 'ENTITY_ALREADY_LOCKED', lock: holder } } })

      await store.runGesture('d1', 'l1', call)

      expect(store.toasts.at(-1)).toMatchObject({ kind: 'lock' })
      expect(store.toasts.at(-1)!.sub).toContain('Marta Ops')
      expect(mockedGet).toHaveBeenCalledWith('/dispatcher/loadboard', expect.anything()) // still refreshes
    })

    it('a refused lock hold shows the toast and never calls the endpoint at all', async () => {
      const store = useCockpitStore()
      mockedAcquireLock.mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 409, data: { error: 'ENTITY_ALREADY_LOCKED', lock: lockFor('d1', { name: 'Marta Ops' }) } },
      })
      const call = vi.fn()

      await store.runGesture('d1', 'l1', call)

      expect(call).not.toHaveBeenCalled()
      expect(store.toasts.at(-1)).toMatchObject({ kind: 'lock' })
      expect(useLocksStore().held).toBeNull()
    })

    // A2 Load Locks, Task 9: the load lock is taken BESIDE the lane lock —
    // "Their Board" holding the load must refuse the gesture by name, even
    // though the lane itself is free. And whatever the gesture's outcome,
    // the load lock must not outlive the gesture that took it.
    it('takes the load lock beside the lane lock, refuses by name when Their Board holds it, and releases when the gesture settles', async () => {
      const loadLocks = useLoadLocksStore()
      const hold = vi.spyOn(loadLocks, 'hold').mockResolvedValue(false)
      loadLocks.byLoad = { L1: { loadId: 'L1', orgId: 'o', dispatcherId: 'maria', by: 'Maria', since: 1, expiresAt: 61_001 } }
      const call = vi.fn()
      const store = useCockpitStore()

      await store.runGesture('lane-1', 'L1', call)

      expect(hold).toHaveBeenCalledWith('L1')
      expect(call).not.toHaveBeenCalled()
      // Same toast hook every other runGesture test in this file uses (see
      // e.g. the 409-lock-refused test above): `store.toasts.at(-1)!.sub`.
      expect(store.toasts.at(-1)!.sub).toMatch(/Maria is editing/)

      hold.mockResolvedValue(true)
      const release = vi.spyOn(loadLocks, 'release')
      call.mockResolvedValue({ feasible: true, conflicts: [], plan: planFixture, economics: econFixture } as PlanResult)

      await store.runGesture('lane-1', 'L1', call)

      expect(release).toHaveBeenCalled()
    })

    // Fix round 1: a blocked dry-run is NOT a settled gesture — it's a
    // dispatcher decision pending. The load lock must survive the verdict
    // modal being open, and let go only once that decision is made, one way
    // (Force -> the forced commit settles) or the other (Cancel).
    it('Fix round 1: a blocked dry-run holds the load lock until Force settles the retried commit', async () => {
      const store = useCockpitStore()
      store.init('America/Chicago', NOW)
      await store.reload()
      const loadLocks = useLoadLocksStore()
      const release = vi.spyOn(loadLocks, 'release')
      const call = vi.fn().mockResolvedValueOnce(blocked()).mockResolvedValueOnce(feasible())

      await store.runGesture('d1', 'l1', call)

      expect(store.verdict).not.toBeNull() // the verdict modal is open
      expect(release).not.toHaveBeenCalled() // NOT released while it's pending a decision

      await store.forceVerdict()

      expect(call).toHaveBeenCalledTimes(2) // dry-run, then the forced write
      expect(release).toHaveBeenCalledTimes(1) // released once the forced commit settled
    })

    it('Fix round 1: a blocked dry-run releases the load lock when the verdict is dismissed without forcing', async () => {
      const store = useCockpitStore()
      store.init('America/Chicago', NOW)
      await store.reload()
      const loadLocks = useLoadLocksStore()
      const release = vi.spyOn(loadLocks, 'release')
      const call = vi.fn().mockResolvedValueOnce(blocked())

      await store.runGesture('d1', 'l1', call)
      expect(release).not.toHaveBeenCalled()

      store.cancelVerdict()

      expect(release).toHaveBeenCalledTimes(1)
      expect(call).toHaveBeenCalledTimes(1) // the dry-run only — never committed
    })

    // Fix round 2: the reviewer found round 1's per-path reasoning missed a
    // case reachable on the ORDINARY path — a feasible dry-run whose OWN
    // commit 422s. `handleGestureError`'s 422 branch reopens a fresh
    // verdict there, but `commitGesture` still resolves normally
    // afterwards, so releasing unconditionally right after `await
    // commitGesture(...)` let the lock go while that fresh verdict sat
    // open. `settleLoadLock`'s `verdict === null` check closes this.
    it('Fix round 2: a feasible dry-run whose commit itself 422s keeps the load lock held until a later Force settles', async () => {
      const store = useCockpitStore()
      store.init('America/Chicago', NOW)
      await store.reload()
      const loadLocks = useLoadLocksStore()
      const release = vi.spyOn(loadLocks, 'release')
      const overlapVerdict = blocked({ conflicts: [{ kind: 'overlap', severity: 'block', detail: 'now overlaps another leg' }] })
      const call = vi.fn()
        .mockResolvedValueOnce(feasible()) // dry-run: feasible
        .mockRejectedValueOnce({ isAxiosError: true, response: { status: 422, data: overlapVerdict } }) // the commit itself 422s
        .mockResolvedValueOnce(feasible()) // the forced retry succeeds

      await store.runGesture('d1', 'l1', call)

      expect(store.verdict).toMatchObject({ feasible: false }) // a FRESH verdict, opened from the commit's own 422
      expect(release).not.toHaveBeenCalled() // NOT released — a verdict is pending

      await store.forceVerdict()

      expect(call).toHaveBeenCalledTimes(3) // dry-run, blocked commit, forced retry
      expect(release).toHaveBeenCalledTimes(1) // released once the retried commit settled with nothing left open
      expect(store.verdict).toBeNull()
    })

    it('Fix round 2: the same commit-time 422 releases the load lock when that fresh verdict is dismissed without forcing', async () => {
      const store = useCockpitStore()
      store.init('America/Chicago', NOW)
      await store.reload()
      const loadLocks = useLoadLocksStore()
      const release = vi.spyOn(loadLocks, 'release')
      const overlapVerdict = blocked({ conflicts: [{ kind: 'overlap', severity: 'block', detail: 'now overlaps another leg' }] })
      const call = vi.fn()
        .mockResolvedValueOnce(feasible())
        .mockRejectedValueOnce({ isAxiosError: true, response: { status: 422, data: overlapVerdict } })

      await store.runGesture('d1', 'l1', call)
      expect(release).not.toHaveBeenCalled()

      store.cancelVerdict()

      expect(release).toHaveBeenCalledTimes(1)
      expect(call).toHaveBeenCalledTimes(2) // dry-run + the one blocked commit attempt — never retried
    })

    it('a 422 on the commit (a fresh block found at write time) opens the verdict modal with the server verdict', async () => {
      const store = useCockpitStore()
      store.init('America/Chicago', NOW)
      await store.reload()
      const overlapVerdict = blocked({ conflicts: [{ kind: 'overlap', severity: 'block', detail: 'now overlaps another leg' }] })
      const call = vi.fn()
        .mockResolvedValueOnce(feasible())
        .mockRejectedValueOnce({ isAxiosError: true, response: { status: 422, data: overlapVerdict } })

      await store.runGesture('d1', 'l1', call)

      expect(store.verdict).toMatchObject({ feasible: false })
      expect(store.verdict!.conflicts[0].kind).toBe('overlap')
    })

    it('any other commit failure shows a generic error toast via extractApiErrorMessage', async () => {
      const store = useCockpitStore()
      store.init('America/Chicago', NOW)
      await store.reload()
      const call = vi.fn()
        .mockResolvedValueOnce(feasible())
        .mockRejectedValueOnce({ isAxiosError: true, response: { status: 500, data: { error: 'Engine unavailable' } } })

      await store.runGesture('d1', 'l1', call)

      // extractApiErrorMessage only reads `.response.data.error` off a real
      // AxiosError instance (see lib/errors.ts) — the codebase-wide test
      // convention (locks.spec.ts, vehicles.spec.ts, etc.) mocks rejections
      // as plain `{isAxiosError, response}` objects, so this only pins that
      // SOME error toast is shown, not the exact fallback-vs-server text.
      expect(store.toasts.at(-1)).toMatchObject({ kind: 'conflict' })
      expect(store.toasts.at(-1)!.sub).toBeTruthy()
    })

    it('planLeg calls PATCH /assignments/:id/plan with dryRun/force wired by the pipeline', async () => {
      const store = useCockpitStore()
      store.init('America/Chicago', NOW)
      await store.reload()
      mockedPlanAssignment.mockResolvedValue(feasible())

      await store.planLeg('a1', 'd1', 'l1', { driverId: 'd1', availableAt: 12345 })

      expect(mockedPlanAssignment).toHaveBeenNthCalledWith(1, 'a1', { driverId: 'd1', availableAt: 12345, dryRun: true, force: false })
      expect(mockedPlanAssignment).toHaveBeenNthCalledWith(2, 'a1', { driverId: 'd1', availableAt: 12345, dryRun: false, force: false })
    })

    it('dropLoad calls POST /assignments with the given body and dryRun/force wired by the pipeline', async () => {
      const store = useCockpitStore()
      store.init('America/Chicago', NOW)
      await store.reload()
      mockedCreateAssignment.mockResolvedValue(feasible())

      await store.dropLoad('d1', { loadId: 'l2', driverId: 'd1', tractorId: 't1', trailerId: 'r1', availableAt: 999 })

      expect(mockedCreateAssignment).toHaveBeenNthCalledWith(1, { loadId: 'l2', driverId: 'd1', tractorId: 't1', trailerId: 'r1', availableAt: 999, dryRun: true, force: false })
      expect(mockedCreateAssignment).toHaveBeenNthCalledWith(2, { loadId: 'l2', driverId: 'd1', tractorId: 't1', trailerId: 'r1', availableAt: 999, dryRun: false, force: false })
    })

    // T3 Break and Rest Planning, Task 8 (Ruling 7): `breakPlanByLoadId` is
    // the map's own source for break points — deliberately not `verdict`,
    // which PlanVerdictModal nulls the instant it closes. These tests pin
    // that every shape of verdict response (a dry-run preview, a blocked
    // 422, a written commit) files into it, keyed by the load id the
    // pipeline itself was given — never the server's own body, which names
    // no load id at all.
    describe('breakPlanByLoadId (Task 8, Ruling 7)', () => {
      const breakEntry = { atMs: 1000, at: { lat: 39.1, lng: -94.58 }, precision: 'estimated' as const, options: [], hasCoverage: false }

      it('a blocked dry-run preview files its break plan under the load id, even though nothing commits', async () => {
        const store = useCockpitStore()
        const call = vi.fn().mockResolvedValueOnce(blocked({ breakPlan: [breakEntry], breakPlanKnown: true }))

        await store.runGesture('d1', 'l9', call)

        expect(store.breakPlanByLoadId.l9).toEqual({ entries: [breakEntry], known: true })
      })

      it('a 422 raised on the commit attempt itself also files its break plan', async () => {
        const store = useCockpitStore()
        store.init('America/Chicago', NOW)
        await store.reload()
        const call = vi.fn()
          .mockResolvedValueOnce(feasible({ breakPlan: [], breakPlanKnown: true }))
          .mockRejectedValueOnce({
            isAxiosError: true,
            response: { status: 422, data: blocked({ breakPlan: [breakEntry], breakPlanKnown: true }) },
          })

        await store.runGesture('d1', 'l9', call)

        // The 422's own body — the freshest evaluation — wins over the
        // preview's, exactly like `store.verdict` itself does.
        expect(store.breakPlanByLoadId.l9).toEqual({ entries: [breakEntry], known: true })
      })

      it('a successful commit files the break plan from the commit response, overwriting the preview\'s', async () => {
        const store = useCockpitStore()
        store.init('America/Chicago', NOW)
        await store.reload()
        const committedEntry = { ...breakEntry, atMs: 2000 }
        const call = vi.fn()
          .mockResolvedValueOnce(feasible({ breakPlan: [breakEntry], breakPlanKnown: true }))
          .mockResolvedValueOnce(feasible({ breakPlan: [committedEntry], breakPlanKnown: true }))

        await store.runGesture('d1', 'l9', call)

        expect(store.breakPlanByLoadId.l9).toEqual({ entries: [committedEntry], known: true })
      })

      it('records breakPlanKnown: false verbatim — never upgraded to "known and empty"', async () => {
        const store = useCockpitStore()
        const call = vi.fn().mockResolvedValueOnce(blocked({ breakPlan: [], breakPlanKnown: false }))

        await store.runGesture('d1', 'l9', call)

        expect(store.breakPlanByLoadId.l9).toEqual({ entries: [], known: false })
      })

      it('a response carrying neither field at all (pre-T3 shape) leaves the map untouched', async () => {
        const store = useCockpitStore()
        const call = vi.fn().mockResolvedValueOnce(blocked()) // no breakPlan/breakPlanKnown

        await store.runGesture('d1', 'l9', call)

        expect(store.breakPlanByLoadId.l9).toBeUndefined()
      })

      it('surviving the modal closing: cancelVerdict nulls `verdict` but never touches breakPlanByLoadId', async () => {
        const store = useCockpitStore()
        const call = vi.fn().mockResolvedValueOnce(blocked({ breakPlan: [breakEntry], breakPlanKnown: true }))
        await store.runGesture('d1', 'l9', call)
        expect(store.verdict).not.toBeNull()

        store.cancelVerdict()

        expect(store.verdict).toBeNull()
        expect(store.breakPlanByLoadId.l9).toEqual({ entries: [breakEntry], known: true })
      })
    })

    // T3 Break and Rest Planning, Task 9: `store.verdict` (CockpitVerdict) is
    // what `PlanVerdictModal` actually renders from — `breakPlanByLoadId`
    // above is the map's own copy (Ruling 7), a separate fact that outlives
    // the modal closing. Both must be populated from the same verdict body,
    // or the modal would never show a break row a dispatcher hasn't already
    // dismissed once.
    describe('verdict.breakPlan / breakPlanKnown (Task 9)', () => {
      const breakEntry = { atMs: 1000, at: { lat: 39.1, lng: -94.58 }, precision: 'estimated' as const, options: [], hasCoverage: false }

      it('a blocked dry-run carries breakPlan/breakPlanKnown onto store.verdict, not just breakPlanByLoadId', async () => {
        const store = useCockpitStore()
        const call = vi.fn().mockResolvedValueOnce(blocked({ breakPlan: [breakEntry], breakPlanKnown: true }))

        await store.runGesture('d1', 'l9', call)

        expect(store.verdict!.breakPlan).toEqual([breakEntry])
        expect(store.verdict!.breakPlanKnown).toBe(true)
      })

      it('a pre-T3 response (neither field present) leaves both undefined on store.verdict — never coerced to known-empty', async () => {
        const store = useCockpitStore()
        const call = vi.fn().mockResolvedValueOnce(blocked())

        await store.runGesture('d1', 'l9', call)

        expect(store.verdict!.breakPlan).toBeUndefined()
        expect(store.verdict!.breakPlanKnown).toBeUndefined()
      })
    })

    // T4 Fuel and Stops, Task 9: `fuelPlanByLoadId` mirrors `breakPlanByLoadId`
    // (Ruling 7/8) field-for-field — the same three response points file into
    // it, the same "not cleared on modal close" lifetime, the same "response
    // silent on the field leaves the map untouched" rule. `FuelPlanBody`
    // itself needs no reshaping (unlike breakPlan/breakPlanKnown, which are
    // two separate wire fields folded into one wrapper), so this cache stores
    // `data.fuel` verbatim.
    describe('fuelPlanByLoadId (Task 9)', () => {
      const fuelPlan = {
        burn: { deadheadGal: 2, loadedGal: 18, totalGal: 20, mpgUsed: 6.5 },
        advice: { atSequence: 1, atLabel: 'Kansas City, MO' , state: 'MO', gallons: 20, centsPerGal: 389, vsLabel: 'fleet avg', vsCentsPerGal: 412, savingCents: 4700 },
        ifta: { byState: [{ state: 'MO', gallons: 20 }], unattributedGal: 0, complete: true },
        known: true,
      }

      // REGRESSION (found by T4's live pass, not by any unit test). The store
      // cached `fuel` correctly and every modal spec passed, because those
      // specs hand the prop straight to the component. But `toVerdict` — the
      // mapping that builds the object the modal actually renders from —
      // dropped the field, so the live Fuel panel showed "unavailable"
      // forever against a server that was sending real advice.
      //
      // The defect lived in the SEAM between two tasks: one owned the modal,
      // one owned the store cache, and neither owned the mapping between
      // them. This asserts the seam itself.
      it('carries fuel through to the verdict the modal renders from, not just the cache', async () => {
        const store = useCockpitStore()
        const call = vi.fn().mockResolvedValueOnce(blocked({ fuel: fuelPlan }))

        await store.runGesture('d1', 'l9', call)

        expect(store.verdict).not.toBeNull()
        expect(store.verdict!.fuel).toEqual(fuelPlan)
      })

      it('a blocked dry-run preview files its fuel plan under the load id, even though nothing commits', async () => {
        const store = useCockpitStore()
        const call = vi.fn().mockResolvedValueOnce(blocked({ fuel: fuelPlan }))

        await store.runGesture('d1', 'l9', call)

        expect(store.fuelPlanByLoadId.l9).toEqual(fuelPlan)
      })

      it('a 422 raised on the commit attempt itself also files its fuel plan', async () => {
        const store = useCockpitStore()
        store.init('America/Chicago', NOW)
        await store.reload()
        const committed = { ...fuelPlan, advice: { ...fuelPlan.advice, savingCents: 5200 } }
        const call = vi.fn()
          .mockResolvedValueOnce(feasible({ fuel: fuelPlan }))
          .mockRejectedValueOnce({
            isAxiosError: true,
            response: { status: 422, data: blocked({ fuel: committed }) },
          })

        await store.runGesture('d1', 'l9', call)

        // The 422's own body — the freshest evaluation — wins over the
        // preview's, exactly like breakPlanByLoadId's own equivalent test.
        expect(store.fuelPlanByLoadId.l9).toEqual(committed)
      })

      it('a successful commit files the fuel plan from the commit response, overwriting the preview\'s', async () => {
        const store = useCockpitStore()
        store.init('America/Chicago', NOW)
        await store.reload()
        const committed = { ...fuelPlan, advice: { ...fuelPlan.advice, savingCents: 1200 } }
        const call = vi.fn()
          .mockResolvedValueOnce(feasible({ fuel: fuelPlan }))
          .mockResolvedValueOnce(feasible({ fuel: committed }))

        await store.runGesture('d1', 'l9', call)

        expect(store.fuelPlanByLoadId.l9).toEqual(committed)
      })

      it('a response carrying no `fuel` at all (pre-T4 shape) leaves the map untouched', async () => {
        const store = useCockpitStore()
        const call = vi.fn().mockResolvedValueOnce(blocked()) // no fuel field

        await store.runGesture('d1', 'l9', call)

        expect(store.fuelPlanByLoadId.l9).toBeUndefined()
      })

      it('surviving the modal closing: cancelVerdict nulls `verdict` but never touches fuelPlanByLoadId', async () => {
        const store = useCockpitStore()
        const call = vi.fn().mockResolvedValueOnce(blocked({ fuel: fuelPlan }))
        await store.runGesture('d1', 'l9', call)
        expect(store.verdict).not.toBeNull()

        store.cancelVerdict()

        expect(store.verdict).toBeNull()
        expect(store.fuelPlanByLoadId.l9).toEqual(fuelPlan)
      })
    })
  })

  // Cockpit S2b Task 12: the yard-chip pairing drag. Not a plan/assign
  // gesture (no dry-run) — pairUnit skips runGesture but must still land in
  // the identical lock/error/toast handling, pinned by reusing this file's
  // exact holder fixture and toast assertions from the tests above.
  describe('pairUnit (yard-chip drag)', () => {
    it('acquires the lane lock, calls pairDriver with the given body, and refreshes the board', async () => {
      const store = useCockpitStore()
      store.init('America/Chicago', NOW)
      await store.reload()
      mockedGet.mockClear()
      mockedPairDriver.mockResolvedValue({ driver: { id: 'd1' } })

      await store.pairUnit('d1', { tractorId: 't9' })

      expect(mockedAcquireLock).toHaveBeenCalledWith('d1')
      expect(mockedPairDriver).toHaveBeenCalledWith('d1', { tractorId: 't9' })
      expect(mockedGet).toHaveBeenCalledWith('/dispatcher/loadboard', expect.anything())
      expect(store.toasts.at(-1)).toMatchObject({ kind: 'hook' })
    })

    it('a refused lock hold shows the toast and never calls pairDriver', async () => {
      mockedAcquireLock.mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 409, data: { error: 'ENTITY_ALREADY_LOCKED', lock: lockFor('d1', { name: 'Marta Ops' }) } },
      })
      const store = useCockpitStore()

      await store.pairUnit('d1', { trailerId: 'r9' })

      expect(mockedPairDriver).not.toHaveBeenCalled()
      expect(store.toasts.at(-1)).toMatchObject({ kind: 'lock' })
      expect(store.toasts.at(-1)!.sub).toContain('Marta Ops')
    })

    it('a 409 on the write itself shows the same lock toast as every other gesture, and refreshes', async () => {
      const store = useCockpitStore()
      store.init('America/Chicago', NOW)
      await store.reload()
      mockedGet.mockClear()
      const holder = lockFor('d1', { dispatcherId: 'disp-9', name: 'Marta Ops' })
      mockedPairDriver.mockRejectedValueOnce({ isAxiosError: true, response: { status: 409, data: { error: 'ENTITY_ALREADY_LOCKED', lock: holder } } })

      await store.pairUnit('d1', { tractorId: 't9' })

      expect(store.toasts.at(-1)).toMatchObject({ kind: 'lock' })
      expect(store.toasts.at(-1)!.sub).toContain('Marta Ops')
      expect(mockedGet).toHaveBeenCalledWith('/dispatcher/loadboard', expect.anything())
    })

    // `PATCH /pairing` answers 409 for TWO different reasons: the lane is
    // locked, or the unit is already another driver's default. Only the first
    // carries ENTITY_ALREADY_LOCKED. Telling a dispatcher "held by another
    // dispatcher" when the truth is "that tractor is Tyrone's" sends them
    // hunting a colleague who is not the obstacle.
    it('a 409 that is NOT a lane lock shows the server reason, not the lock toast', async () => {
      const store = useCockpitStore()
      store.init('America/Chicago', NOW)
      await store.reload()
      mockedGet.mockClear()
      mockedPairDriver.mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 409, data: { error: 'Tractor #1212 is already Tyrone Banks’ default' } },
      })

      await store.pairUnit('d1', { tractorId: 't9' })

      const toast = store.toasts.at(-1)!
      expect(toast.kind).not.toBe('lock')
      expect(toast.sub).toContain('Tyrone Banks')
      expect(toast.sub).not.toContain('another dispatcher')
      expect(mockedGet).toHaveBeenCalledWith('/dispatcher/loadboard', expect.anything())
    })
  })

  // T5 Dwell and Detention, Task 6: the org-wide detention scan. Independent
  // of any load selection or gesture, so it gets its own loading/error
  // rather than reusing verdict's — the whole point of this slice is that an
  // empty list and a failed fetch must NOT look the same to a component: a
  // failure must set `error` and leave a previously loaded list exactly as
  // it was (stale-but-labelled beats blank; see Global Constraint 1 in the
  // task brief — a silently-emptied list reads as "nothing is detained,"
  // the single most expensive lie this feature can render).
  describe('detention (Task 6)', () => {
    const detentionRow = (over: Partial<StopDetention> = {}): StopDetention => ({
      loadId: 'l1',
      loadRef: 'L-1',
      stopId: 's1',
      stopLabel: 'Kansas City, MO',
      stopType: 'delivery',
      driverId: 'd1',
      driverName: 'Jake Morrow',
      claim: {
        clockStartMs: 1000,
        freeMin: 120,
        billableMin: 45,
        evidence: { pingCount: 12, maxGapMin: 4, firstSeenMs: 1000, lastSeenMs: 12_000, departureObserved: true },
        needsReview: false,
        reviewReasons: [],
      },
      noClaimReason: null,
      observedMin: 165,
      ...over,
    })

    it('starts with an empty, unloaded slice', () => {
      const store = useCockpitStore()
      expect(store.detention).toEqual({ items: [], loading: false, error: null })
    })

    it('loadDetention fetches with sinceHours and files the result, clearing any prior error', async () => {
      const store = useCockpitStore()
      const rows = [detentionRow()]
      mockedFetchDetention.mockResolvedValueOnce(rows)

      await store.loadDetention(72)

      expect(mockedFetchDetention).toHaveBeenCalledWith(72)
      expect(store.detention.items).toEqual(rows)
      expect(store.detention.error).toBeNull()
      expect(store.detention.loading).toBe(false)
    })

    it('a failed fetch sets error and leaves items exactly as they were (empty, on a first load)', async () => {
      const store = useCockpitStore()
      mockedFetchDetention.mockRejectedValueOnce({ isAxiosError: true, response: { status: 500, data: { error: 'Detention scan failed' } } })

      await store.loadDetention(72)

      expect(store.detention.items).toEqual([])
      expect(store.detention.error).toBeTruthy()
      expect(store.detention.loading).toBe(false)
    })

    it('a failure does NOT clear a previously loaded list', async () => {
      const store = useCockpitStore()
      const rows = [detentionRow()]
      mockedFetchDetention.mockResolvedValueOnce(rows)
      await store.loadDetention(72)
      expect(store.detention.items).toEqual(rows)

      mockedFetchDetention.mockRejectedValueOnce({ isAxiosError: true, response: { status: 500, data: { error: 'Detention scan failed' } } })
      await store.loadDetention(72)

      expect(store.detention.items).toEqual(rows) // stale list survives the failure
      expect(store.detention.error).toBeTruthy()
      expect(store.detention.loading).toBe(false)
    })
  })

  // Clicking a route on the map asks for that run's plan. Before this action
  // existed the break and fuel numbers were only in the store if someone had
  // happened to drag that leg, so the map card read "not loaded" for every run
  // on a freshly opened board.
  describe('loadPlanFor', () => {
    const verdict = (over: Record<string, unknown> = {}) =>
      ({
        breakPlan: [{ atMs: 1, at: null, precision: 'estimated', options: [], hasCoverage: false }],
        breakPlanKnown: true,
        fuel: { burn: { deadheadGal: 1, loadedGal: 2, totalGal: 3, mpgUsed: 6 }, advice: null, ifta: { byState: [], unattributedGal: 0 }, known: true },
        ...over,
      }) as unknown as PlanResult

    const withAssignedLoad = () => {
      const lb = useLoadboardStore()
      lb.loads = [{ id: 'l1', assignment: { id: 'a1' } }] as unknown as typeof lb.loads
    }

    it('reads the plan WITHOUT writing — dryRun, and no lock taken', async () => {
      // The whole safety property. A dispatcher clicking a line must never
      // move a leg, and must never take the lane lock from whoever is editing
      // it. Both have bitten this codebase before.
      withAssignedLoad()
      vi.mocked(planAssignment).mockResolvedValue(verdict())
      const store = useCockpitStore()
      await store.loadPlanFor('l1')
      expect(planAssignment).toHaveBeenCalledWith('a1', { dryRun: true })
      expect(acquireLock).not.toHaveBeenCalled()
    })

    it('files both the break plan and the fuel plan', async () => {
      withAssignedLoad()
      vi.mocked(planAssignment).mockResolvedValue(verdict())
      const store = useCockpitStore()
      await store.loadPlanFor('l1')
      expect(store.breakPlanByLoadId.l1.known).toBe(true)
      expect(store.fuelPlanByLoadId.l1.burn.totalGal).toBe(3)
    })

    it('still files the plan from a BLOCKED verdict', async () => {
      // A 422 leg is the one whose breaks matter most — it is over hours.
      // Dropping its plan on the floor would blank the card exactly when a
      // dispatcher needs it.
      withAssignedLoad()
      const err = Object.assign(new Error('blocked'), { response: { status: 422, data: verdict() } })
      vi.mocked(planAssignment).mockRejectedValue(err)
      const store = useCockpitStore()
      await store.loadPlanFor('l1')
      expect(store.breakPlanByLoadId.l1.known).toBe(true)
    })

    it('stays silent on any other failure rather than raising a toast', async () => {
      withAssignedLoad()
      vi.mocked(planAssignment).mockRejectedValue(Object.assign(new Error('boom'), { response: { status: 500, data: {} } }))
      const store = useCockpitStore()
      await store.loadPlanFor('l1')
      expect(store.breakPlanByLoadId.l1).toBeUndefined()
      expect(store.activity.length).toBe(0)
    })

    it('does not re-ask once both halves are held', async () => {
      // One routing call per click would be paid on every stray click.
      withAssignedLoad()
      vi.mocked(planAssignment).mockResolvedValue(verdict())
      const store = useCockpitStore()
      await store.loadPlanFor('l1')
      await store.loadPlanFor('l1')
      expect(vi.mocked(planAssignment)).toHaveBeenCalledTimes(1)
    })

    it('does nothing for a load with no assignment', async () => {
      const lb = useLoadboardStore()
      lb.loads = [{ id: 'l9', assignment: null }] as unknown as typeof lb.loads
      const store = useCockpitStore()
      await store.loadPlanFor('l9')
      expect(planAssignment).not.toHaveBeenCalled()
    })
  })
})
