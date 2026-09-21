import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import GanttBoard from '../components/cockpit/GanttBoard.vue'
import PlanVerdictModal from '../components/cockpit/PlanVerdictModal.vue'
import { acquireLoadLock, acquireLock, api, createAssignment, fetchLoadLocks, heartbeatLoadLock, planAssignment, releaseLoadLock, type Lock, type LoadLock } from '../lib/api'
import { useAuthStore } from '../stores/auth'
import { useCockpitStore } from '../stores/cockpit'
import { useLoadboardStore } from '../stores/loadboard'
import { useCarriersStore } from '../stores/carriers'
import { useLocksStore } from '../stores/locks'
import { useTrackingStore } from '../stores/tracking'
import CockpitView from './CockpitView.vue'

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn(), patch: vi.fn() },
  API_BASE_URL: 'http://localhost:3001/api',
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  fetchLocks: vi.fn(),
  planAssignment: vi.fn(),
  createAssignment: vi.fn(),
  // Fix round 3: A2 Load Locks, Task 9 — runGesture now also holds/releases
  // the load lock (`useLoadLocksStore`) beside the lane lock, same as
  // cockpit.spec.ts's mock. Without these the store's real `hold()` calls
  // an undefined `acquireLoadLock`, its catch treats that as a refusal, and
  // every gesture in this file's "gesture wiring" tests gets silently
  // refused before ever reaching PATCH.
  acquireLoadLock: vi.fn(),
  releaseLoadLock: vi.fn(),
  heartbeatLoadLock: vi.fn(),
  fetchLoadLocks: vi.fn(),
}))
vi.mock('../lib/download', () => ({ triggerDownload: vi.fn() }))
const mockedAcquireLock = vi.mocked(acquireLock)
const mockedPlanAssignment = vi.mocked(planAssignment)
const mockedCreateAssignment = vi.mocked(createAssignment)
const mockedAcquireLoadLock = vi.mocked(acquireLoadLock)
const mockedReleaseLoadLock = vi.mocked(releaseLoadLock)
const mockedHeartbeatLoadLock = vi.mocked(heartbeatLoadLock)
const mockedFetchLoadLocks = vi.mocked(fetchLoadLocks)
const lockFor = (laneId: string, over: Partial<Lock> = {}): Lock => ({
  laneId, orgId: 'org-1', dispatcherId: 'disp-1', name: 'Dana Dispatcher', since: 1000, expiresAt: 91000, ...over,
})
const loadLockFor = (loadId: string, over: Partial<LoadLock> = {}): LoadLock => ({
  loadId, orgId: 'org-1', dispatcherId: 'disp-1', by: 'Dana Dispatcher', since: 1000, expiresAt: 61000, ...over,
})

// Fixed so the org-timezone assertions below are hand-derivable: 19:32 UTC on
// Fri 28 Aug 2026 = 14:32 America/Chicago = 12:32 America/Los_Angeles, both
// inside the board's 06:00–24:00 band on the same wall date.
const NOW = Date.UTC(2026, 7, 28, 19, 32)
const H = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()
const board = {
  lanes: [
    { id: 'd1', name: 'Jake Morrow', status: 'active', hosKnown: true, driveRemainingMin: 495, currentTractorId: 't1', currentTrailerId: 'r1', lastCity: 'Kansas City, MO' },
    // No tractor/trailer paired — the gesture-drop "no equipment" toast case.
    { id: 'd2', name: 'Terry NoRig', status: 'active', hosKnown: false },
  ],
  tractors: [{ id: 't1', unit: '1207', make: 'Peterbilt 579', cab: 'Sleeper', status: 'active', inspectionExpiresAt: null, registrationExpiresAt: null, nextServiceAt: null, currentDriverId: 'd1' }],
  trailers: [{ id: 'r1', unit: 'DV-4450', type: 'DryVan', length: "53'", status: 'active', features: null, inspectionExpiresAt: null, registrationExpiresAt: null, nextServiceAt: null, currentDriverId: 'd1' }],
  loads: [
    { id: 'l1', reference: 'L-51217', status: 'in_progress', requiredEquip: 'DryVan', hazmatClass: null, revenueCents: 145000, stopCount: 2, origin: 'Kansas City', destination: 'Chicago', commodity: 'Retail',
      stops: [{ sequence: 1, type: 'pickup', address: 'Kansas City, MO', lat: 39.1, lng: -94.58, dwellMin: 60, windowStart: null, windowEnd: iso(NOW + H) }, { sequence: 2, type: 'delivery', address: 'Chicago, IL', lat: 41.88, lng: -87.63, dwellMin: 60, windowStart: null, windowEnd: iso(NOW + 20 * H) }],
      assignment: { id: 'a1', driverId: 'd1', tractorId: 't1', trailerId: 'r1', status: 'in_progress', plannedStart: iso(NOW - H), plannedEnd: iso(NOW + 18 * H), marginCents: 58000, deadheadMi: 0, loadedMi: 497, savedMi: 40 } },
    { id: 'l2', reference: 'L-51220', status: 'open', requiredEquip: 'DryVan', hazmatClass: null, revenueCents: 75000, stopCount: 1, origin: 'Chicago', destination: 'Indianapolis', assignment: null, pickupWindowEnd: iso(NOW + 5 * H) },
  ],
}
function respond(url: string) {
  if (url.includes('/loadboard')) return { data: board }
  if (url.includes('/kpis')) return { data: { loads: {}, drivers: { total: 1, hosKnown: 1 }, economics: { committedLoads: 1, revenueCents: 145000, estCostCents: 87000, marginCents: 58000, avgMarginPct: 0.4, loadedMi: 497, deadheadMi: 0, deadheadPct: 0, ratePerLoadedMiCents: 292, deadheadCostCents: 0, emptyMilesSavedMi: 40 } } }
  if (url.includes('/fleet/digest')) return { data: { items: [{ label: 'Tractor #1212 inspection', kind: 'inspection', at: '2026-08-01', expired: true }], expiredCount: 1, dueSoonCount: 0 } }
  if (url.includes('/yard')) return { data: { tractors: [], trailers: [], drivers: [] } }
  if (url.includes('/locations')) return { data: [] }
  if (url.includes('/cost-model')) return { data: { mpg: 6.5, dieselCentsPerGal: 400, driverPayCentsPerMi: 60, fixedCentsPerMi: 45, allInCentsPerMi: 167 } }
  if (url.includes('/risk')) return { data: { risks: [] } }
  if (url.includes('/alerts')) return { data: { alerts: [] } }
  return { data: [] }
}

describe('CockpitView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    vi.mocked(api.get).mockImplementation(async (url: string) => respond(url))
    mockedAcquireLock.mockReset()
    mockedAcquireLock.mockResolvedValue({ lock: lockFor('d1') })
    mockedPlanAssignment.mockReset()
    mockedCreateAssignment.mockReset()
    mockedAcquireLoadLock.mockReset()
    mockedAcquireLoadLock.mockResolvedValue({ lock: loadLockFor('l1') })
    mockedHeartbeatLoadLock.mockReset()
    mockedHeartbeatLoadLock.mockResolvedValue({ lock: loadLockFor('l1') })
    mockedReleaseLoadLock.mockReset()
    mockedReleaseLoadLock.mockResolvedValue(undefined)
    mockedFetchLoadLocks.mockReset()
    mockedFetchLoadLocks.mockResolvedValue({ locks: [] })
    class FakeWs { onmessage: unknown = null; onclose: unknown = null; close() {} }
    vi.stubGlobal('WebSocket', FakeWs)
  })
  afterEach(() => vi.restoreAllMocks())

  async function mountView() {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/cockpit', component: CockpitView }, { path: '/messages', component: { template: '<div/>' } }] })
    await router.push('/cockpit')
    await router.isReady()
    const w = mount(CockpitView, { global: { plugins: [router] } })
    await flushPromises()
    return w
  }

  it('loads everything, renders the board with live data, and opens the drawer on a brick', async () => {
    const w = await mountView()
    const urls = vi.mocked(api.get).mock.calls.map((c) => String(c[0]))
    for (const u of ['/dispatcher/loadboard', '/dispatcher/yard', '/dispatcher/risk', '/dispatcher/fleet/digest', '/dispatcher/locations', '/dispatcher/settings/cost-model'])
      expect(urls.some((x) => x.includes(u)), u).toBe(true)
    // Cockpit review 2026-09-19: the KPI strip is gone, and with it the only
    // reader of /dispatcher/kpis on this screen.
    expect(urls.some((x) => x.includes('/dispatcher/kpis'))).toBe(false)
    expect(w.find('[data-lane="d1"]').exists()).toBe(true)
    expect(w.find('[data-load="l1"]').exists()).toBe(true)
    expect(w.find('[data-bid="l2"]').exists()).toBe(true)
    expect(w.find('[data-testid="drawer"]').text()).toContain('MASTER DRAWER')
    await w.find('[data-load="l1"]').trigger('click')
    expect(useCockpitStore().selectedLoadId).toBe('l1')
    expect(w.find('[data-testid="drawer"]').text()).toContain('INSPECT: LEG L-51217')
    expect(w.find('[data-testid="drawer"]').text()).toContain('#1207')
    expect(w.find('[data-testid="drawer"]').text()).toContain('Chicago, IL')
  })

  it('the radar is entered from the store (drawer "show on map"), never from a header tab; the header only offers the way back', async () => {
    const w = await mountView()
    expect(w.find('[data-view="radar"]').exists()).toBe(false)
    expect(w.find('[data-view="board"]').exists()).toBe(false)
    useCockpitStore().focusOnMap('l1')
    await flushPromises()
    expect(w.find('[data-route="l1"]').exists()).toBe(true)
    expect(w.find('[data-lane="d1"]').exists()).toBe(false)
    await w.find('[data-view="board"]').trigger('click')
    expect(w.find('[data-lane="d1"]').exists()).toBe(true)
    // Money and Compliance are the untouched light-mode legacy screens: they
    // must not be tabbable into the dark cockpit shell (they stay on the
    // sidebar at /money and /fleet).
    expect(w.find('[data-view="money"]').exists()).toBe(false)
    expect(w.find('[data-view="comp"]').exists()).toBe(false)
  })

  it('the expired-clocks chip navigates to the fleet screen rather than switching the cockpit tab', async () => {
    const w = await mountView()
    await w.find('[data-testid="insp-chip"]').trigger('click')
    await flushPromises()
    expect(w.vm.$router.currentRoute.value.path).toBe('/fleet')
  })

  it('tears down cleanly: shared window override cleared and every realtime subscription opened on mount is closed on unmount', async () => {
    // windowOverride is shared state — other screens read it,
    // so a cockpit that leaves it behind breaks the next screen the dispatcher
    // opens. All three realtime consumers (loadboard, tracking, cockpit) keep
    // retrying if they are not closed — and a subscription that never opened
    // in the first place is the same class of bug from the other end, so both
    // halves are asserted here, on the real view wiring (onMounted/onUnmounted
    // in CockpitView.vue), not just on each store's own unit test.
    const lb = useLoadboardStore()
    const tracking = useTrackingStore()
    const ck = useCockpitStore()
    const lbConnect = vi.spyOn(lb, 'connectRealtime')
    const trackingConnect = vi.spyOn(tracking, 'connectRealtime')
    const ckConnect = vi.spyOn(ck, 'connectRealtime')

    const w = await mountView()

    expect(lb.windowOverride).not.toBeNull()
    expect(lbConnect).toHaveBeenCalledTimes(1)
    expect(trackingConnect).toHaveBeenCalledTimes(1)
    expect(ckConnect).toHaveBeenCalledTimes(1)

    const lbClose = vi.spyOn(lb, 'disconnectRealtime')
    const trackingClose = vi.spyOn(tracking, 'disconnectRealtime')
    const ckClose = vi.spyOn(ck, 'disconnectRealtime')

    w.unmount()

    expect(lbClose).toHaveBeenCalledTimes(1)
    expect(trackingClose).toHaveBeenCalledTimes(1)
    expect(ckClose).toHaveBeenCalledTimes(1)
    expect(lb.windowOverride).toBeNull()
  })

  it('draws the board in the org timezone, not the default one', async () => {
    // The regression this pins: auth.org used to live in memory only, so after
    // a refresh the cockpit fell back to America/Chicago and every brick,
    // the now-line and the header clock moved by the offset difference.
    useAuthStore().org = { id: 'o1', name: 'Pacific Freight', timezone: 'America/Los_Angeles' }
    const w = await mountView()
    expect(useCockpitStore().tz).toBe('America/Los_Angeles')
    // l1 starts at 18:32Z = 11:32 PDT; the day band opens at 06:00 and the
    // default 3-day horizon is 22 px/h -> (11h32 - 6h) * 22 = 121.7 -> 122px.
    expect(w.find('[data-load="l1"]').attributes('style')).toContain('left: 122px')
  })

  it('the same board in the default timezone puts the same leg two hours further right', async () => {
    const w = await mountView() // no auth.org -> DEFAULT_TZ America/Chicago
    expect(useCockpitStore().tz).toBe('America/Chicago')
    // 13:32 CDT -> (13h32 - 6h) * 22 = 165.7 -> 166px, i.e. 2h * 22px right of
    // the Los Angeles position above.
    expect(w.find('[data-load="l1"]').attributes('style')).toContain('left: 166px')
  })

  // Cockpit S2b Task 4: GanttBoard's gesture-* events wired into the shared
  // pipeline, the verdict modal wired to it, and the lock released on every
  // exit path. GanttBoard's own pointer-gesture detection is another agent's
  // work (Task 5) — these tests emit the agreed events directly on the
  // mounted child, so they exercise CockpitView's wiring regardless of that
  // work's progress.
  describe('gesture wiring', () => {
    const planFixture = { proposedStart: 0, proposedEnd: 1, deadheadMi: 10, loadedMi: 100, driveMin: 200, onDutyMin: 300, needsBreak: false }
    const econFixture = { revenueCents: 50000, totalMi: 110, deadheadMi: 10, loadedMi: 100, estCostCents: 30000, marginCents: 20000, marginPct: 0.4, ratePerLoadedMiCents: 200, ratePerTotalMiCents: 180 }

    it('gesture-move calls PATCH /assignments/:id/plan for the target lane, and refreshes on success', async () => {
      mockedPlanAssignment.mockResolvedValue({ feasible: true, conflicts: [], plan: planFixture, economics: econFixture })
      const w = await mountView()
      vi.mocked(api.get).mockClear()

      await w.getComponent(GanttBoard).vm.$emit('gesture-move', { loadId: 'l1', assignmentId: 'a1', driverId: 'd1', availableAt: NOW + 2 * H })
      await flushPromises()

      expect(mockedAcquireLock).toHaveBeenCalledWith('d1')
      expect(mockedPlanAssignment).toHaveBeenNthCalledWith(1, 'a1', { driverId: 'd1', availableAt: NOW + 2 * H, dryRun: true, force: false })
      expect(mockedPlanAssignment).toHaveBeenNthCalledWith(2, 'a1', { driverId: 'd1', availableAt: NOW + 2 * H, dryRun: false, force: false })
      expect(vi.mocked(api.get)).toHaveBeenCalledWith(expect.stringContaining('/loadboard'), expect.anything())
    })

    it('gesture-resize looks up the lane from the leg\'s current assignment (the event carries no driverId)', async () => {
      mockedPlanAssignment.mockResolvedValue({ feasible: true, conflicts: [], plan: planFixture, economics: econFixture })
      const w = await mountView()

      await w.getComponent(GanttBoard).vm.$emit('gesture-resize', { loadId: 'l1', assignmentId: 'a1', plannedEnd: NOW + 20 * H })
      await flushPromises()

      expect(mockedAcquireLock).toHaveBeenCalledWith('d1') // l1's assignment.driverId, not supplied by the event
      expect(mockedPlanAssignment).toHaveBeenNthCalledWith(1, 'a1', { plannedEnd: NOW + 20 * H, availableAt: undefined, dryRun: true, force: false })
    })

    it('gesture-drop pulls tractor/trailer from the target driver\'s current pairing and calls POST /assignments', async () => {
      mockedCreateAssignment.mockResolvedValue({ feasible: true, conflicts: [], plan: planFixture, economics: econFixture })
      const w = await mountView()

      await w.getComponent(GanttBoard).vm.$emit('gesture-drop', { loadId: 'l2', driverId: 'd1', availableAt: NOW + 3 * H })
      await flushPromises()

      expect(mockedCreateAssignment).toHaveBeenNthCalledWith(1, { loadId: 'l2', driverId: 'd1', tractorId: 't1', trailerId: 'r1', availableAt: NOW + 3 * H, dryRun: true, force: false })
    })

    it('gesture-drop onto a driver with no equipment paired toasts instead of sending a request that would 422', async () => {
      const w = await mountView()

      await w.getComponent(GanttBoard).vm.$emit('gesture-drop', { loadId: 'l2', driverId: 'd2', availableAt: NOW + 3 * H })
      await flushPromises()

      expect(mockedCreateAssignment).not.toHaveBeenCalled()
      expect(mockedAcquireLock).not.toHaveBeenCalled() // refused locally — never even reaches the pipeline
      expect(useCockpitStore().toasts.at(-1)).toMatchObject({ kind: 'conflict' })
      expect(useCockpitStore().toasts.at(-1)!.sub).toContain('Terry NoRig')
    })

    it('a blocked gesture opens PlanVerdictModal; Cancel closes it, Force re-commits with force:true', async () => {
      mockedPlanAssignment.mockResolvedValueOnce({ feasible: false, conflicts: [{ kind: 'hos', severity: 'block', detail: 'not enough drive time' }], plan: planFixture, economics: econFixture })
      const w = await mountView()

      await w.getComponent(GanttBoard).vm.$emit('gesture-move', { loadId: 'l1', assignmentId: 'a1', driverId: 'd1', availableAt: NOW + 2 * H })
      await flushPromises()

      const modal = w.getComponent(PlanVerdictModal)
      expect(modal.props('verdict')).toMatchObject({ feasible: false })

      mockedPlanAssignment.mockResolvedValueOnce({ feasible: true, conflicts: [], plan: planFixture, economics: econFixture })
      await modal.vm.$emit('force')
      await flushPromises()

      expect(mockedPlanAssignment).toHaveBeenNthCalledWith(2, 'a1', { driverId: 'd1', availableAt: NOW + 2 * H, dryRun: false, force: true })
      expect(w.getComponent(PlanVerdictModal).props('verdict')).toBeNull()
    })
  })

  describe('lock release on every exit path', () => {
    it('closing the drawer releases the held lane', async () => {
      const w = await mountView()
      const release = vi.spyOn(useLocksStore(), 'release')

      await w.find('[data-load="l1"]').trigger('click')
      await w.find('[data-testid="drawer-close"]').trigger('click')

      expect(release).toHaveBeenCalled()
    })

    it('unmount releases the held lane (the leak S1 caught here before)', async () => {
      const w = await mountView()
      const release = vi.spyOn(useLocksStore(), 'release')

      w.unmount()

      expect(release).toHaveBeenCalled()
    })

    // The carrier filter is a cockpit control, but the carriers/loadboard
    // stores are shared with other screens — which have no
    // carrier UI at all. A selection left behind would silently narrow that
    // board's yard and assign-modal equipment with nothing on screen saying a
    // filter is active: trucks missing, no reason visible.
    it('unmount clears the carrier filter so it cannot silently narrow the legacy board', async () => {
      const w = await mountView()
      const carriers = useCarriersStore()
      carriers.select('carrier-a')

      w.unmount()

      expect(carriers.selectedCarrierId).toBeNull()
    })

    it('navigating away from /cockpit releases the held lane', async () => {
      // onBeforeRouteLeave registers on the route record vue-router injects
      // via <router-view> — mounting CockpitView directly (as mountView()
      // does for every other test in this file) never provides that
      // injection, so this one test needs a real router-view in the tree for
      // the guard to attach to anything real.
      const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: '/cockpit', component: CockpitView }, { path: '/elsewhere', component: { template: '<div/>' } }],
      })
      await router.push('/cockpit')
      await router.isReady()
      mount({ template: '<router-view />' }, { global: { plugins: [router] } })
      await flushPromises()
      const release = vi.spyOn(useLocksStore(), 'release')

      await router.push('/elsewhere')

      expect(release).toHaveBeenCalled()
    })
  })
})
