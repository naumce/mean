import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type Carrier } from '../../lib/api'
import { useCarriersStore } from '../../stores/carriers'
import { useCockpitStore } from '../../stores/cockpit'
import { useFleetStore } from '../../stores/fleet'
import { useLoadboardStore } from '../../stores/loadboard'
import CockpitHeader from './CockpitHeader.vue'
import CockpitToolbar from './CockpitToolbar.vue'
import YardChips from './YardChips.vue'

const carrierFor = (id: string, name: string): Carrier => ({
  id, name, mcNumber: null, dotNumber: null, status: 'active',
  mpg: null, dieselCentsPerGal: null, driverPayCentsPerMi: null, fixedCentsPerMi: null,
})

vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() }, API_BASE_URL: 'http://localhost:3001/api' }))
const NOW = Date.UTC(2026, 7, 28, 19, 32)

describe('CockpitHeader', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api.get).mockResolvedValue({ data: { lanes: [], loads: [], tractors: [], trailers: [] } })
    useCockpitStore().init('America/Chicago', NOW)
  })

  it('shows the range, the spotted count only while searching, and drives the store', async () => {
    const ck = useCockpitStore()
    const w = mount(CockpitHeader, { props: { nowMs: NOW, spotted: 2 } })
    expect(w.find('[data-testid="range-label"]').text()).toBe('FRI 28 – SUN 30')
    expect(w.find('[data-testid="spot-clear"]').exists()).toBe(false)
    await w.find('#spotInput').setValue('chicago')
    expect(ck.search).toBe('chicago')
    expect(w.find('[data-testid="spot-clear"]').text()).toContain('2')
    await w.find('[data-days="1"]').trigger('click')
    expect(ck.days).toBe(1)
    await w.find('[data-group="trailer"]').trigger('click')
    expect(ck.groupBy).toBe('trailer')
    await w.find('[data-group="carrier"]').trigger('click')
    expect(ck.groupBy).toBe('carrier')
    // No radar tab any more — the radar is entered from the drawer; the
    // header only offers the way back.
    expect(w.find('[data-view="board"]').exists()).toBe(false)
    ck.setView('radar')
    await w.vm.$nextTick()
    await w.find('[data-view="board"]').trigger('click')
    expect(ck.view).toBe('board')
    await w.find('[data-testid="bell"]').trigger('click')
    expect(w.emitted('toggleActivity')).toHaveLength(1)
  })

  it('shows the activity badge count and the theme toggle', () => {
    const ck = useCockpitStore()
    ck.pushActivity('feed', 'x', 'y')
    const w = mount(CockpitHeader, { props: { nowMs: NOW, spotted: 0 } })
    expect(w.find('[data-testid="bell-badge"]').text()).toBe('1')
    expect(w.find('[data-testid="theme-toggle"]').exists()).toBe(true)
  })
})

describe('CockpitToolbar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useLoadboardStore().loads = [
      { id: 'l1', reference: 'L-1', status: 'open', requiredEquip: 'Reefer', hazmatClass: null, revenueCents: 1, stopCount: 2, origin: 'A', destination: 'B', assignment: null },
      { id: 'l2', reference: 'L-2', status: 'open', requiredEquip: 'DryVan', hazmatClass: '8', revenueCents: 1, stopCount: 2, origin: 'A', destination: 'B', assignment: null },
    ]
  })

  it('chips and equipment select write to the store; jump-now emits', async () => {
    const ck = useCockpitStore()
    const w = mount(CockpitToolbar)
    await w.find('[data-filter="haz"]').trigger('click')
    expect(ck.filter).toBe('haz')
    await w.find('[data-testid="equip-select"]').setValue('Reefer')
    expect(ck.equip).toBe('Reefer')
    await w.find('[data-testid="now-btn"]').trigger('click')
    expect(w.emitted('jumpNow')).toHaveLength(1)
    expect(w.find('[data-testid="equip-select"]').text()).toContain('Reefer')
  })

  // Cockpit review 2026-09-19: the KPI strip is gone; the only thing it said
  // that a lane cannot is "expired clocks off-board", now a toolbar chip.
  it('shows the expired-clocks chip only when the digest counts something expired', async () => {
    const fleet = useFleetStore()
    const w = mount(CockpitToolbar)
    expect(w.find('[data-testid="insp-chip"]').exists()).toBe(false)
    fleet.digest = { items: [], expiredCount: 3, dueSoonCount: 1 }
    await w.vm.$nextTick()
    expect(w.find('[data-testid="insp-chip"]').text()).toContain('3 expired')
    await w.find('[data-testid="insp-chip"]').trigger('click')
    expect(w.emitted('openFleet')).toHaveLength(1)
  })

  // T1 Carrier Layer, Task 8
  describe('carrier filter', () => {
    beforeEach(() => {
      vi.mocked(api.get).mockResolvedValue({ data: { lanes: [], loads: [], tractors: [], trailers: [] } })
    })

    it('is hidden for a single-carrier (or carrier-less) org', () => {
      const w = mount(CockpitToolbar)
      expect(w.find('[data-testid="carrier-select"]').exists()).toBe(false)
      useCarriersStore().list = [carrierFor('c1', 'Carrier A')]
      expect(mount(CockpitToolbar).find('[data-testid="carrier-select"]').exists()).toBe(false)
    })

    // Selecting fires BOTH lb.load() and lb.loadYard() (see below), so calls
    // are filtered by URL rather than read positionally off the mock.
    function paramsOfLastCallTo(url: string): Record<string, unknown> {
      const call = vi.mocked(api.get).mock.calls.filter((c) => c[0] === url).at(-1)
      return (call?.[1] as { params?: Record<string, unknown> } | undefined)?.params ?? {}
    }

    it('selecting a carrier requests the loadboard with that carrierId; clearing omits the param entirely', async () => {
      const carriers = useCarriersStore()
      carriers.list = [carrierFor('c1', 'Carrier A'), carrierFor('c2', 'Carrier B')]
      const w = mount(CockpitToolbar)

      await w.find('[data-testid="carrier-select"]').setValue('c1')
      expect(carriers.selectedCarrierId).toBe('c1')
      expect(paramsOfLastCallTo('/dispatcher/loadboard')).toMatchObject({ carrierId: 'c1' })

      await w.find('[data-testid="carrier-select"]').setValue('')
      expect(carriers.selectedCarrierId).toBeNull()
      // Absent, not null or '': a present-but-empty key is exactly the shape
      // that would tempt a server-side "carrierId === '' means unfiltered"
      // special case instead of the filter simply not being sent.
      expect(paramsOfLastCallTo('/dispatcher/loadboard')).not.toHaveProperty('carrierId')
    })

    // T1 Carrier Layer, Task 8 follow-up: the loadboard's own tractors/
    // trailers aren't what a dispatcher drags — the Yard panel is a
    // SEPARATE endpoint (dispatcherYard.ts) with its own fetch, so the
    // selection has to reach it too, on the same convention (absent, not
    // null/'').
    it('selecting a carrier also requests the yard with that carrierId; clearing omits it there too', async () => {
      const carriers = useCarriersStore()
      carriers.list = [carrierFor('c1', 'Carrier A'), carrierFor('c2', 'Carrier B')]
      const w = mount(CockpitToolbar)

      await w.find('[data-testid="carrier-select"]').setValue('c1')
      expect(paramsOfLastCallTo('/dispatcher/yard')).toMatchObject({ carrierId: 'c1' })

      await w.find('[data-testid="carrier-select"]').setValue('')
      expect(paramsOfLastCallTo('/dispatcher/yard')).not.toHaveProperty('carrierId')
    })

    // The assertion that pins the actual failure this whole fix exists to
    // prevent: not "the endpoint was called with the right params" but "the
    // chips a dispatcher can actually drag onto a lane are the right ones."
    // CockpitToolbar and YardChips are mounted separately but share the
    // same active Pinia, exactly as they do as siblings under CockpitView.
    it('end to end: a carrier selected in the toolbar narrows the tractors/trailers YardChips actually renders', async () => {
      const carriers = useCarriersStore()
      carriers.list = [carrierFor('c1', 'Carrier A'), carrierFor('c2', 'Carrier B')]
      const allTractors = [
        { id: 't-a', unit: 'A-100', make: null, status: 'active' },
        { id: 't-b', unit: 'B-200', make: null, status: 'active' },
      ]
      const allTrailers = [
        { id: 'r-a', unit: 'TA-1', type: 'DryVan', length: null, status: 'active' },
        { id: 'r-b', unit: 'TB-1', type: 'DryVan', length: null, status: 'active' },
      ]
      // A test double for the server's fail-closed carrier filter — good
      // enough to prove the WIRING reaches the rendered chips; the filter's
      // own correctness is proven server-side in dispatcher-yard.test.ts.
      vi.mocked(api.get).mockImplementation(async (url, config) => {
        if (url === '/dispatcher/loadboard') return { data: { lanes: [], loads: [], tractors: [], trailers: [] } }
        if (url === '/dispatcher/yard') {
          const carrierId = (config as { params?: Record<string, unknown> } | undefined)?.params?.carrierId as
            | string
            | undefined
          return {
            data: {
              tractors: carrierId ? allTractors.filter((t) => t.id === 't-a') : allTractors,
              trailers: carrierId ? allTrailers.filter((t) => t.id === 'r-a') : allTrailers,
              drivers: [],
            },
          }
        }
        return { data: {} }
      })
      const lb = useLoadboardStore()
      await lb.loadYard() // the initial, unfiltered load CockpitView's onMounted performs

      const toolbar = mount(CockpitToolbar)
      const yard = mount(YardChips)
      expect(yard.findAll('[data-res="tractor"]')).toHaveLength(2)
      expect(yard.findAll('[data-res="trailer"]')).toHaveLength(2)

      await toolbar.find('[data-testid="carrier-select"]').setValue('c1')
      await flushPromises()
      await yard.vm.$nextTick()

      const tractorChips = yard.findAll('[data-res="tractor"]')
      const trailerChips = yard.findAll('[data-res="trailer"]')
      expect(tractorChips).toHaveLength(1)
      expect(tractorChips[0].attributes('data-rid')).toBe('t-a')
      expect(trailerChips).toHaveLength(1)
      expect(trailerChips[0].attributes('data-rid')).toBe('r-a')
    })
  })
})
