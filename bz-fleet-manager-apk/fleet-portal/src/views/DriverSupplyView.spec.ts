import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive, nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '../stores/auth'
import { useDriverSupplyStore } from '../stores/driverSupply'
import { useSimStore } from '../stores/sim'
import DriverSupplyView from './DriverSupplyView.vue'
import type { SupplyDriver } from '../types/supply'

vi.mock('../stores/driverSupply', () => ({ useDriverSupplyStore: vi.fn() }))
const mockedUseDriverSupplyStore = vi.mocked(useDriverSupplyStore)

// SimControls.vue (mounted at
// the top of this view) calls the real sim store's probe() on mount, which
// would otherwise issue a genuine, unmocked axios request every time this
// file's specs mount the view. Module-mocked, same as driverSupply above —
// `available: false` by default so SimControls itself also renders nothing.
vi.mock('../stores/sim', () => ({ useSimStore: vi.fn() }))
const mockedUseSimStore = vi.mocked(useSimStore)

// reactive(), not a plain object: the "a sim tick reloads driver supply"
// test below mutates `lastTickAt` AFTER mount and needs DriverSupplyView's
// own `watch(() => sim.lastTickAt, ...)` to actually observe that change.
function createSimStoreStub(overrides: Record<string, unknown> = {}) {
  return reactive({
    available: false,
    state: null,
    busy: false,
    error: null,
    lastTickAt: null as number | null,
    probe: vi.fn(),
    tick: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
    setDriverMode: vi.fn(),
    ...overrides,
  })
}

const onLoadDriver: SupplyDriver = {
  id: 'd1', name: 'Alice', firstName: 'Alice', lastName: 'A', phone: '555-0100',
  cdlClass: 'A', hazmatEndorsed: false, endorsements: [], equipmentTypes: ['DryVan'],
  languages: ['en'], preferredLanguage: 'en', homeBaseCity: 'Dallas', homeBaseState: 'TX', yearsExperience: 5,
  hos: null,
  driverId: 'd1', acceptingLoads: false, locationSharingEnabled: true, locationSharingUpdatedAt: null,
  shareToken: 'tok-1', status: 'ON_LOAD', availableAt: Date.now() + 3_600_000,
  available: { lat: null, lng: null, city: 'Omaha', state: 'NE' },
  current: { lat: 41.65, lng: -83.53, at: Date.now() - 60_000, near: { city: 'Toledo', state: 'OH', distanceMi: 12 } },
  currentAssignment: { loadId: 'L1', loadRef: 'REF-1', deliveryEtaMs: Date.now() + 7_200_000, deliveryCity: 'Chicago' },
  source: 'manual',
}

const availableDriver: SupplyDriver = {
  id: 'd2', name: 'Bob', firstName: 'Bob', lastName: 'B', phone: null,
  cdlClass: 'A', hazmatEndorsed: false, endorsements: [], equipmentTypes: [],
  languages: [], preferredLanguage: 'en', homeBaseCity: null, homeBaseState: null, yearsExperience: null,
  hos: null,
  driverId: 'd2', acceptingLoads: true, locationSharingEnabled: false, locationSharingUpdatedAt: null,
  shareToken: null, status: 'AVAILABLE', availableAt: Date.now() - 1000,
  available: { lat: null, lng: null, city: null, state: null },
  current: null, currentAssignment: null, source: 'none',
}

function createDriverSupplyStoreStub(overrides: Record<string, unknown> = {}) {
  return {
    drivers: [onLoadDriver, availableDriver],
    availability: { d1: onLoadDriver, d2: availableDriver },
    filters: { statuses: [], equipment: null, language: null, state: null, acceptingOnly: false },
    selectedDriverId: null,
    drawer: { metrics: null, history: [], preference: null, loading: false, error: null },
    loading: false,
    error: null,
    rows: [onLoadDriver, availableDriver],
    mapLocations: [{ driverId: 'd1', driverName: 'Alice', latitude: 41.65, longitude: -83.53, createdAt: new Date().toISOString() }],
    filterOptions: { equipment: ['DryVan'], languages: ['en'], states: ['TX'] },
    load: vi.fn(),
    startPolling: vi.fn(),
    stopPolling: vi.fn(),
    connectRealtime: vi.fn(),
    disconnectRealtime: vi.fn(),
    setFilters: vi.fn(),
    select: vi.fn(),
    closeDrawer: vi.fn(),
    updateAvailability: vi.fn(),
    updatePreference: vi.fn(),
    ...overrides,
  }
}

describe('DriverSupplyView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedUseDriverSupplyStore.mockReset()
    mockedUseSimStore.mockReset()
    mockedUseSimStore.mockReturnValue(createSimStoreStub() as unknown as ReturnType<typeof useSimStore>)
    const auth = useAuthStore()
    auth.setSession({
      token: 't',
      dispatcher: { id: 'd1', name: 'Dee', email: 'd@x.com', orgId: 'o1' },
      org: { id: 'o1', name: 'Acme', timezone: 'America/Chicago' },
      plan: { tier: 'tower' },
    })
  })

  it('starts polling and connects realtime on mount; tears both down on unmount', () => {
    const store = createDriverSupplyStoreStub()
    mockedUseDriverSupplyStore.mockReturnValue(store as unknown as ReturnType<typeof useDriverSupplyStore>)
    const wrapper = mount(DriverSupplyView)

    expect(store.load).toHaveBeenCalled()
    expect(store.startPolling).toHaveBeenCalled()
    expect(store.connectRealtime).toHaveBeenCalled()

    wrapper.unmount()
    expect(store.stopPolling).toHaveBeenCalled()
    expect(store.disconnectRealtime).toHaveBeenCalled()
  })

  it('reloads driver supply data when a sim tick lands (sim.lastTickAt changes)', async () => {
    const store = createDriverSupplyStoreStub()
    mockedUseDriverSupplyStore.mockReturnValue(store as unknown as ReturnType<typeof useDriverSupplyStore>)
    const simStub = createSimStoreStub()
    mockedUseSimStore.mockReturnValue(simStub as unknown as ReturnType<typeof useSimStore>)

    mount(DriverSupplyView)
    store.load.mockClear() // drop the onMounted() call — isolate the watcher's own call

    simStub.lastTickAt = Date.now()
    await nextTick()

    expect(store.load).toHaveBeenCalledTimes(1)
  })

  it('renders the ten columns for a two-driver fixture: ON_LOAD with a current load, AVAILABLE with no ping', () => {
    const store = createDriverSupplyStoreStub()
    mockedUseDriverSupplyStore.mockReturnValue(store as unknown as ReturnType<typeof useDriverSupplyStore>)
    const wrapper = mount(DriverSupplyView)

    const rows = wrapper.findAll('[data-testid="driver-row"]')
    expect(rows).toHaveLength(2)

    const aliceRow = rows[0]
    expect(aliceRow.find('[data-col="name"]').text()).toBe('Alice')
    expect(aliceRow.find('[data-col="current-load"]').text()).toBe('REF-1 → Chicago')
    expect(aliceRow.find('[data-col="current"]').text()).toContain('near Toledo, OH')

    const bobRow = rows[1]
    expect(bobRow.find('[data-col="name"]').text()).toBe('Bob')
    expect(bobRow.find('[data-col="current"]').text()).toBe('no ping')
    // availableDriver's availableAt is already in the past with no city/state
    // known — PROJECTED AVAILABILITY's "now" branch + "Unknown location" fallback.
    expect(bobRow.find('[data-col="projected-availability"]').text()).toBe('Unknown location · now')
  })

  it('passes mapLocations through to FleetMap', () => {
    const store = createDriverSupplyStoreStub()
    mockedUseDriverSupplyStore.mockReturnValue(store as unknown as ReturnType<typeof useDriverSupplyStore>)
    const wrapper = mount(DriverSupplyView)
    expect(wrapper.find('[data-testid="fleet-map"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('No driver positions yet')
  })

  it('shows the filtered-empty state distinctly from the no-drivers-at-all state', () => {
    const store = createDriverSupplyStoreStub({ rows: [] })
    mockedUseDriverSupplyStore.mockReturnValue(store as unknown as ReturnType<typeof useDriverSupplyStore>)
    const wrapper = mount(DriverSupplyView)
    expect(wrapper.find('[data-testid="supply-empty"]').text()).toContain('No drivers match these filters')
  })

  it('toggling a status filter button calls setFilters with the updated status list', async () => {
    const store = createDriverSupplyStoreStub()
    mockedUseDriverSupplyStore.mockReturnValue(store as unknown as ReturnType<typeof useDriverSupplyStore>)
    const wrapper = mount(DriverSupplyView)
    await wrapper.find('[data-testid="filter-status-ON_LOAD"]').trigger('click')
    expect(store.setFilters).toHaveBeenCalledWith({ statuses: ['ON_LOAD'] })
  })

  it('choosing an equipment filter calls setFilters with that equipment', async () => {
    const store = createDriverSupplyStoreStub()
    mockedUseDriverSupplyStore.mockReturnValue(store as unknown as ReturnType<typeof useDriverSupplyStore>)
    const wrapper = mount(DriverSupplyView)
    await wrapper.find('[data-testid="filter-equipment"]').setValue('DryVan')
    expect(store.setFilters).toHaveBeenCalledWith({ equipment: 'DryVan' })
  })

  it('checking accepting-loads-only calls setFilters with acceptingOnly: true', async () => {
    const store = createDriverSupplyStoreStub()
    mockedUseDriverSupplyStore.mockReturnValue(store as unknown as ReturnType<typeof useDriverSupplyStore>)
    const wrapper = mount(DriverSupplyView)
    await wrapper.find('[data-testid="filter-accepting-only"]').setValue(true)
    expect(store.setFilters).toHaveBeenCalledWith({ acceptingOnly: true })
  })

  it('gives every filter select an accessible name', () => {
    const store = createDriverSupplyStoreStub()
    mockedUseDriverSupplyStore.mockReturnValue(store as unknown as ReturnType<typeof useDriverSupplyStore>)
    const wrapper = mount(DriverSupplyView)
    expect(wrapper.find('[data-testid="filter-equipment"]').attributes('aria-label')).toBeTruthy()
    expect(wrapper.find('[data-testid="filter-language"]').attributes('aria-label')).toBeTruthy()
    expect(wrapper.find('[data-testid="filter-state"]').attributes('aria-label')).toBeTruthy()
  })

  it('clicking a row calls store.select with that driverId', async () => {
    const store = createDriverSupplyStoreStub()
    mockedUseDriverSupplyStore.mockReturnValue(store as unknown as ReturnType<typeof useDriverSupplyStore>)
    const wrapper = mount(DriverSupplyView)
    await wrapper.findAll('[data-testid="driver-row"]')[0].trigger('click')
    expect(store.select).toHaveBeenCalledWith('d1')
  })

  describe('simulation disclosure', () => {
    const mountWithSim = (simOverrides: Record<string, unknown>) => {
      const store = createDriverSupplyStoreStub()
      mockedUseDriverSupplyStore.mockReturnValue(store as unknown as ReturnType<typeof useDriverSupplyStore>)
      mockedUseSimStore.mockReturnValue(createSimStoreStub(simOverrides) as unknown as ReturnType<typeof useSimStore>)
      return mount(DriverSupplyView, { global: { stubs: { SimControls: { template: '<div data-testid="sim-controls-stub" />' } } } })
    }

    it('is collapsed by default and opens on click', async () => {
      const wrapper = mountWithSim({ available: true, state: { running: false } })
      const button = wrapper.find('[data-testid="sim-disclosure"]')
      expect(button.text()).toContain('Simulation controls')
      expect(wrapper.find('[data-testid="sim-body"]').attributes('style')).toContain('display: none')
      await button.trigger('click')
      expect(wrapper.find('[data-testid="sim-body"]').attributes('style') ?? '').not.toContain('display: none')
    })

    it('is expanded automatically while the sim is running', () => {
      const wrapper = mountWithSim({ available: true, state: { running: true } })
      expect(wrapper.find('[data-testid="sim-body"]').attributes('style') ?? '').not.toContain('display: none')
    })

    it('is absent when the server has no simulation', () => {
      const wrapper = mountWithSim({ available: false })
      expect(wrapper.find('[data-testid="sim-disclosure"]').exists()).toBe(false)
    })
  })
})
