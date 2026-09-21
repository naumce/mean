import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AxiosError } from 'axios'
import { nextTick } from 'vue'
import { api } from '../../lib/api'
import { useAuthStore } from '../../stores/auth'
import { useCockpitStore } from '../../stores/cockpit'
import { useLoadboardStore, type BoardLoad } from '../../stores/loadboard'
import { useLoadLocksStore } from '../../stores/loadLocks'
import { useTrackingStore } from '../../stores/tracking'
import MasterDrawer from './MasterDrawer.vue'

// Task 6: the Night Shift section's AgentSwitch reads/writes through
// useNightShiftStore, which calls `api` — mocked so its onMounted policy
// fetch and any switch flip never reach a real server.
vi.mock('../../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  API_BASE_URL: 'http://localhost:3001/api',
}))
const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)

// T2 "Map as Navigation", Task 5: the reverse of Task 4's map -> board jump.
// MasterDrawer is the natural home for it (see the component's own doc) —
// it's the one panel rendered across both the board and radar views, so a
// single button here reads the current view and offers whichever direction
// you're not currently in.

const NOW = Date.UTC(2026, 7, 28, 19, 32)
const H = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()

const loadWithStops: BoardLoad = {
  id: 'l1',
  reference: 'L-1',
  status: 'assigned',
  requiredEquip: 'DryVan',
  hazmatClass: null,
  revenueCents: 100_000,
  stopCount: 2,
  origin: 'Kansas City, MO',
  destination: 'Chicago, IL',
  stops: [
    { sequence: 1, type: 'pickup', address: 'Kansas City, MO', lat: 39.1, lng: -94.58, dwellMin: 60, windowStart: null, windowEnd: null },
    { sequence: 2, type: 'delivery', address: 'Chicago, IL', lat: 41.88, lng: -87.63, dwellMin: 30, windowStart: null, windowEnd: null },
  ],
  assignment: { id: 'a1', driverId: 'd1', status: 'assigned', plannedStart: iso(NOW + H), plannedEnd: iso(NOW + 3 * H), marginCents: 1 },
}

function mountDrawer(load: BoardLoad | null) {
  return mount(MasterDrawer, { props: { load, nowMs: NOW, tz: 'America/Chicago' } })
}

describe('MasterDrawer', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedGet.mockReset()
    mockedPost.mockReset()
    mockedGet.mockResolvedValue({ data: { policies: [{ id: 'pol-standard', name: 'Standard' }], loadsByPolicy: {} } })
    const lb = useLoadboardStore()
    lb.lanes = [{ id: 'd1', name: 'Jake Morrow', status: 'active' }]
    lb.loads = [loadWithStops]
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Lifecycle actions came over from the retired Slice-1 board (2026-09-19):
  // what shows follows the record; every button is an existing store action.
  describe('lifecycle actions', () => {
    it('an assigned leg offers Start trip + Unassign, nothing else', () => {
      const w = mountDrawer(loadWithStops)
      expect(w.find('[data-testid="action-start"]').exists()).toBe(true)
      expect(w.find('[data-testid="action-unassign"]').exists()).toBe(true)
      expect(w.find('[data-testid="action-deliver"]').exists()).toBe(false)
      expect(w.find('[data-testid="action-cancel"]').exists()).toBe(false)
      expect(w.find('[data-testid="action-reopen"]').exists()).toBe(false)
    })

    it('a rolling leg offers Delivered; an open load offers Cancel; a canceled one offers Reopen', () => {
      const rolling = { ...loadWithStops, assignment: { ...loadWithStops.assignment!, status: 'in_progress' } }
      expect(mountDrawer(rolling).find('[data-testid="action-deliver"]').exists()).toBe(true)
      const open = { ...loadWithStops, status: 'open', assignment: null }
      expect(mountDrawer(open).find('[data-testid="action-cancel"]').exists()).toBe(true)
      const canceled = { ...loadWithStops, status: 'canceled', assignment: null }
      expect(mountDrawer(canceled).find('[data-testid="action-reopen"]').exists()).toBe(true)
    })

    it('Start trip posts the status change through the store; a refused one surfaces the server message, never a silent click', async () => {
      const w = mountDrawer(loadWithStops)
      mockedPost.mockResolvedValueOnce({ data: {} })
      mockedGet.mockResolvedValue({ data: { lanes: [], loads: [], tractors: [], trailers: [] } })
      await w.find('[data-testid="action-start"]').trigger('click')
      await flushPromises()
      expect(mockedPost).toHaveBeenCalledWith('/dispatcher/assignments/a1/status', { status: 'in_progress' })
      expect(w.find('[data-testid="action-error"]').exists()).toBe(false)

      mockedPost.mockRejectedValueOnce(new AxiosError('422', '422', undefined, undefined, { status: 422, statusText: '', headers: {}, config: {} as never, data: { error: 'HOS: no drive time left' } }))
      await w.find('[data-testid="action-start"]').trigger('click')
      await flushPromises()
      expect(w.find('[data-testid="action-error"]').text()).toContain('HOS: no drive time left')
    })

    it('every action is disabled while another dispatcher holds the load', () => {
      useAuthStore().dispatcher = { id: 'me', email: 'me@fleet.test', name: 'Me' } as never
      useLoadLocksStore().byLoad = { l1: { loadId: 'l1', orgId: 'o', dispatcherId: 'maria', by: 'Maria', since: 1, expiresAt: Date.now() + 60_000 } }
      const w = mountDrawer(loadWithStops)
      expect(w.find('[data-testid="action-start"]').attributes('disabled')).toBeDefined()
      expect(w.find('[data-testid="action-unassign"]').attributes('disabled')).toBeDefined()
    })
  })

  it('renders neither button in the idle state (no load selected)', () => {
    const w = mountDrawer(null)
    expect(w.find('[data-testid="drawer-show-on-map"]').exists()).toBe(false)
    expect(w.find('[data-testid="drawer-show-on-board"]').exists()).toBe(false)
  })

  describe('on the board view', () => {
    it('offers "Show on map", not "Show on board"', () => {
      const ck = useCockpitStore()
      ck.setView('board')
      const w = mountDrawer(loadWithStops)
      expect(w.find('[data-testid="drawer-show-on-map"]').exists()).toBe(true)
      expect(w.find('[data-testid="drawer-show-on-board"]').exists()).toBe(false)
    })

    it('"Show on map" switches the cockpit to the radar/map view and selects that exact load', async () => {
      const ck = useCockpitStore()
      ck.setView('board')
      const w = mountDrawer(loadWithStops)
      await w.get('[data-testid="drawer-show-on-map"]').trigger('click')
      expect(ck.view).toBe('radar')
      expect(ck.selectedLoadId).toBe('l1')
      expect(ck.mapFocusLoadId).toBe('l1')
    })

    // T2 Task 3/5's shared invariant: a load with nothing honest to centre
    // on (no geocoded stops AND no known driver position) must never offer
    // a jump that lands on a default/invented coordinate — the button is
    // disabled (inert), not merely hidden, so a dispatcher can see it exists
    // and understand why it's unavailable.
    it('disables "Show on map" for a load with no geocoded stops and no known driver position', async () => {
      const lb = useLoadboardStore()
      const bare: BoardLoad = { ...loadWithStops, stops: undefined, assignment: null }
      lb.loads = [bare]
      const ck = useCockpitStore()
      ck.setView('board')
      const w = mountDrawer(bare)
      const btn = w.get('[data-testid="drawer-show-on-map"]')
      expect(btn.attributes('disabled')).toBeDefined()
      await btn.trigger('click')
      // A disabled button's click is inert — jsdom itself refuses to fire it,
      // same as a real browser — so the view never changes.
      expect(ck.view).toBe('board')
      expect(ck.mapFocusLoadId).toBeNull()
    })

    it('enables "Show on map" off the assigned driver\'s known position when the load itself has no geocoded stops', () => {
      const lb = useLoadboardStore()
      lb.lanes = [{ id: 'd1', name: 'Jake Morrow', status: 'active', lastLat: 38.95, lastLng: -92.33 }]
      const bare: BoardLoad = { ...loadWithStops, stops: undefined }
      lb.loads = [bare]
      const ck = useCockpitStore()
      ck.setView('board')
      const w = mountDrawer(bare)
      expect(w.get('[data-testid="drawer-show-on-map"]').attributes('disabled')).toBeUndefined()
    })

    it('enables "Show on map" off a fresh GPS ping when neither the load nor the lane\'s last fix is known', () => {
      const lb = useLoadboardStore()
      lb.lanes = [{ id: 'd1', name: 'Jake Morrow', status: 'active' }]
      const bare: BoardLoad = { ...loadWithStops, stops: undefined }
      lb.loads = [bare]
      useTrackingStore().locations = [{ driverId: 'd1', driverName: 'Jake Morrow', latitude: 40.5, longitude: -91, speed: 58, createdAt: iso(NOW - 60_000) }]
      const ck = useCockpitStore()
      ck.setView('board')
      const w = mountDrawer(bare)
      expect(w.get('[data-testid="drawer-show-on-map"]').attributes('disabled')).toBeUndefined()
    })
  })

  describe('on the radar/map view', () => {
    it('offers "Show on board", not "Show on map"', () => {
      const ck = useCockpitStore()
      ck.setView('radar')
      const w = mountDrawer(loadWithStops)
      expect(w.find('[data-testid="drawer-show-on-board"]').exists()).toBe(true)
      expect(w.find('[data-testid="drawer-show-on-map"]').exists()).toBe(false)
    })

    it('"Show on board" switches to the board view, selects the load, and scrolls its brick into view', async () => {
      const ck = useCockpitStore()
      ck.setView('radar')
      const brick = document.createElement('div')
      brick.setAttribute('data-load', 'l1')
      document.body.appendChild(brick)
      const scrollIntoView = vi.fn()
      brick.scrollIntoView = scrollIntoView
      const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
        cb(0)
        return 0
      })

      const w = mountDrawer(loadWithStops)
      await w.get('[data-testid="drawer-show-on-board"]').trigger('click')

      expect(ck.view).toBe('board')
      expect(ck.selectedLoadId).toBe('l1')
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', inline: 'center', block: 'center' })

      rafSpy.mockRestore()
      document.body.removeChild(brick)
    })
  })

  // The round trip this task exists to prove: board -> map -> board lands
  // back on the exact same load, with the board scrolled to it. The button
  // itself flips label/action as `ck.view` changes underneath the same
  // mounted drawer — nothing about the drawer needs to be remounted for the
  // reverse jump to work.
  it('round trip: board -> map -> board returns to the same load, scrolled into view on the way back', async () => {
    const ck = useCockpitStore()
    ck.setView('board')
    const w = mountDrawer(loadWithStops)

    await w.get('[data-testid="drawer-show-on-map"]').trigger('click')
    expect(ck.view).toBe('radar')
    expect(ck.selectedLoadId).toBe('l1')

    await nextTick()
    expect(w.find('[data-testid="drawer-show-on-board"]').exists()).toBe(true)

    const brick = document.createElement('div')
    brick.setAttribute('data-load', 'l1')
    document.body.appendChild(brick)
    const scrollIntoView = vi.fn()
    brick.scrollIntoView = scrollIntoView
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })

    await w.get('[data-testid="drawer-show-on-board"]').trigger('click')

    expect(ck.view).toBe('board')
    expect(ck.selectedLoadId).toBe('l1')
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', inline: 'center', block: 'center' })

    rafSpy.mockRestore()
    document.body.removeChild(brick)
  })

  // Night Shift on the Board, Task 6: the inspect panel's own pill + switch
  // (spec §8's "Trip panel: pill, last three ladder lines, drawer button" —
  // this task builds the pill and the switch; the drawer button is another
  // implementer's).
  describe('Night shift section', () => {
    it('shows nothing in the idle state', () => {
      expect(mountDrawer(null).find('[data-testid="drawer-night-shift"]').exists()).toBe(false)
    })

    it('shows the pill and "not watching" when the load has never been switched on', async () => {
      const w = mountDrawer({ ...loadWithStops, agentEnabled: false, agentPolicyId: null, agentPill: 'off' })
      await flushPromises()
      const section = w.get('[data-testid="drawer-night-shift"]')
      expect(section.get('[data-agent-pill]').text()).toBe('—')
      expect(section.text()).toContain('Not watching this load')
      expect(section.get('[data-agent-switch]').attributes('aria-checked')).toBe('false')
    })

    it('shows "watching" and the switch on when the load is under a policy', async () => {
      const w = mountDrawer({ ...loadWithStops, agentEnabled: true, agentPolicyId: 'pol-standard', agentPill: 'watching', agentLine: 'EN ROUTE — 40 mi out' })
      await flushPromises()
      const section = w.get('[data-testid="drawer-night-shift"]')
      expect(section.get('[data-agent-pill]').text()).toBe('Watching')
      expect(section.get('[data-agent-pill]').attributes('title')).toBe('EN ROUTE — 40 mi out')
      expect(section.text()).toContain('Watching this load')
      expect(section.get('[data-agent-switch]').attributes('aria-checked')).toBe('true')
    })

    it('clicking the pill emits open-agent with the load id', async () => {
      const w = mountDrawer({ ...loadWithStops, agentEnabled: false, agentPolicyId: null, agentPill: 'off' })
      await flushPromises()
      await w.get('[data-agent-pill]').trigger('click')
      expect(w.emitted('open-agent')).toEqual([['l1']])
    })

    it('a load someone else holds disables the switch but still shows the pill', async () => {
      useAuthStore().dispatcher = { id: 'me', email: 'me@fleet.test', name: 'Me' } as never
      const locks = useLoadLocksStore()
      locks.byLoad = { l1: { loadId: 'l1', orgId: 'o', dispatcherId: 'maria', by: 'Maria', since: 1, expiresAt: Date.now() + 60_000 } }
      const w = mountDrawer({ ...loadWithStops, agentEnabled: true, agentPolicyId: 'pol-standard', agentPill: 'watching' })
      await flushPromises()
      expect(w.find('[data-agent-pill]').exists()).toBe(true)
      expect(w.get('[data-agent-switch]').attributes('disabled')).toBeDefined()
      expect(w.get('[data-testid="drawer-night-shift"]').text()).toContain('Maria is editing this load')
    })

    it('turning the switch on POSTs through nightShift.setSwitch with the row version', async () => {
      mockedPost.mockResolvedValueOnce({ data: { load: {}, version: 5 } })
      const w = mountDrawer({ ...loadWithStops, agentEnabled: false, agentPolicyId: null, agentPill: 'off', version: 4 })
      await flushPromises()
      await w.get('[data-agent-switch]').trigger('click')
      await w.get('[data-agent-policy-picker] [data-confirm]').trigger('click')
      await flushPromises()
      expect(mockedPost).toHaveBeenCalledWith('/dispatcher/loads/l1/agent', { enabled: true, policyId: 'pol-standard', baseVersion: 4 })
    })

    it('on a 409 STALE_VERSION it re-reads exactly this load through the loadboard store', async () => {
      mockedPost.mockRejectedValueOnce({ isAxiosError: true, response: { status: 409, data: { error: 'STALE_VERSION', current: 9 } } })
      mockedGet.mockResolvedValueOnce({ data: { policies: [{ id: 'pol-standard', name: 'Standard' }], loadsByPolicy: {} } })
      const lb = useLoadboardStore()
      const patchSpy = vi.spyOn(lb, 'patchLoads').mockResolvedValue()
      const w = mountDrawer({ ...loadWithStops, agentEnabled: false, agentPolicyId: null, agentPill: 'off', version: 4 })
      await flushPromises()
      await w.get('[data-agent-switch]').trigger('click')
      await w.get('[data-agent-policy-picker] [data-confirm]').trigger('click')
      await flushPromises()
      expect(patchSpy).toHaveBeenCalledWith(['l1'])
    })
  })
})
