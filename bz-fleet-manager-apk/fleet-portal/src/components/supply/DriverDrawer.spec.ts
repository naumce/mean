import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DriverDrawer from './DriverDrawer.vue'
import { useDriverSupplyStore } from '../../stores/driverSupply'
import { useSimStore } from '../../stores/sim'
import type { SupplyDriver } from '../../types/supply'

vi.mock('../../stores/driverSupply', () => ({ useDriverSupplyStore: vi.fn() }))
const mockedUseDriverSupplyStore = vi.mocked(useDriverSupplyStore)

const driver: SupplyDriver = {
  id: 'd1', name: 'Alice', firstName: 'Alice', lastName: 'A', phone: '555-0100',
  cdlClass: 'A', hazmatEndorsed: true, endorsements: ['N', 'T'], equipmentTypes: ['DryVan'],
  languages: ['en', 'es'], preferredLanguage: 'en', homeBaseCity: 'Dallas', homeBaseState: 'TX', yearsExperience: 6,
  hos: null,
  driverId: 'd1', acceptingLoads: true, locationSharingEnabled: true, locationSharingUpdatedAt: null,
  shareToken: 'tok-123', status: 'AVAILABLE',
  availableAt: Date.now(), available: { lat: null, lng: null, city: null, state: null },
  current: null, currentAssignment: null, source: 'manual',
}

function createStoreStub(overrides: Record<string, unknown> = {}) {
  return {
    selectedDriverId: 'd1',
    drivers: [driver],
    drawer: {
      metrics: {
        driverId: 'd1', asOf: '2026-09-24T00:00:00.000Z', completedLoads: 42, onTimeLoads: 40, lateLoads: 2,
        onTimeRate: 0.95, averageDelayMinutes: 8, averageDetentionMinutes: null, averageResponseMinutes: null,
        responseRate: 1, noResponseIncidents: 0, breakdownIncidents: 0, accidentIncidents: 0,
        loadsLast30Days: 5, nightLoads: 3,
        laneExperience: [{ laneKey: 'a|b', originCity: 'Dallas', destCity: 'Austin', runs: 4, lastRunAt: null }],
        evidence: { assignments: 42, agentTrips: 10, agentEvents: 30 },
      },
      history: [{
        assignmentId: 'a1', loadId: 'l1', loadRef: 'REF-1', customerName: 'Acme', customerId: 'c1',
        originCity: 'Dallas', destCity: 'Austin', laneKey: 'a|b', plannedStart: '2026-09-01T00:00:00.000Z',
        plannedEnd: '2026-09-01T12:00:00.000Z', completedAt: '2026-09-01T13:00:00.000Z',
        deliveryWindowEnd: '2026-09-01T12:00:00.000Z', late: true, lateMinutes: 60,
      }],
      preference: {
        maxTripMiles: null, preferredRegions: [], preferredLanes: [], avoidRegions: [], avoidLanes: [],
        homeTimeTarget: null, willingToDriveNight: true, willingToRelocateMiles: null, preferredEquipment: [],
      },
      loading: false,
      error: null,
    },
    error: null,
    closeDrawer: vi.fn(),
    updateAvailability: vi.fn().mockResolvedValue(true),
    updatePreference: vi.fn().mockResolvedValue(true),
    ...overrides,
  }
}

describe('DriverDrawer', () => {
  beforeEach(() => {
    // DriverDrawer now also reads the (real, unmocked) sim store directly —
    // Task 10's Simulation section — so a Pinia instance must be active even
    // though useDriverSupplyStore itself stays module-mocked below.
    setActivePinia(createPinia())
    mockedUseDriverSupplyStore.mockReset()
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is hidden when no driver is selected', () => {
    const store = createStoreStub({ selectedDriverId: null })
    mockedUseDriverSupplyStore.mockReturnValue(store as unknown as ReturnType<typeof useDriverSupplyStore>)
    const wrapper = mount(DriverDrawer)
    expect(wrapper.find('[data-testid="driver-drawer"]').exists()).toBe(false)
  })

  it('renders the header and metrics from the fixture, nulls as "—"', () => {
    const store = createStoreStub()
    mockedUseDriverSupplyStore.mockReturnValue(store as unknown as ReturnType<typeof useDriverSupplyStore>)
    const wrapper = mount(DriverDrawer)

    expect(wrapper.find('[data-testid="drawer-name"]').text()).toBe('Alice')
    expect(wrapper.find('[data-testid="metric-completed"]').text()).toBe('42')
    expect(wrapper.find('[data-testid="metric-on-time-rate"]').text()).toBe('95%')
    expect(wrapper.find('[data-testid="metric-avg-detention"]').text()).toBe('—')
    expect(wrapper.find('[data-testid="metric-avg-response"]').text()).toBe('—')
    expect(wrapper.find('[data-testid="history-late-chip"]').exists()).toBe(true)
  })

  it('clicking close calls closeDrawer', async () => {
    const store = createStoreStub()
    mockedUseDriverSupplyStore.mockReturnValue(store as unknown as ReturnType<typeof useDriverSupplyStore>)
    const wrapper = mount(DriverDrawer)
    await wrapper.find('[data-testid="drawer-close"]').trigger('click')
    expect(store.closeDrawer).toHaveBeenCalled()
  })

  it('Save on availability controls sends the PATCH body', async () => {
    const store = createStoreStub()
    mockedUseDriverSupplyStore.mockReturnValue(store as unknown as ReturnType<typeof useDriverSupplyStore>)
    const wrapper = mount(DriverDrawer)

    await wrapper.find('[data-testid="availability-status"]').setValue('OFF_DUTY')
    await wrapper.find('[data-testid="availability-save"]').trigger('click')
    await Promise.resolve()

    expect(store.updateAvailability).toHaveBeenCalledWith('d1', expect.objectContaining({ availabilityStatus: 'OFF_DUTY', acceptingLoads: true }))
  })

  it('Save on preferences sends the PATCH body', async () => {
    const store = createStoreStub()
    mockedUseDriverSupplyStore.mockReturnValue(store as unknown as ReturnType<typeof useDriverSupplyStore>)
    const wrapper = mount(DriverDrawer)

    await wrapper.find('[data-testid="pref-max-trip-miles"]').setValue('600')
    await wrapper.find('[data-testid="preferences-save"]').trigger('click')
    await Promise.resolve()

    expect(store.updatePreference).toHaveBeenCalledWith('d1', expect.objectContaining({ maxTripMiles: 600 }))
  })

  it('Copy writes the driver link to the clipboard', async () => {
    const store = createStoreStub()
    mockedUseDriverSupplyStore.mockReturnValue(store as unknown as ReturnType<typeof useDriverSupplyStore>)
    const wrapper = mount(DriverDrawer)

    await wrapper.find('[data-testid="driver-link-copy"]').trigger('click')
    await Promise.resolve()

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`${window.location.origin}/driver/tok-123`)
  })

  it('shows the hint instead of a link when shareToken is null', () => {
    const noToken = { ...driver, shareToken: null }
    const store = createStoreStub({ drivers: [noToken] })
    mockedUseDriverSupplyStore.mockReturnValue(store as unknown as ReturnType<typeof useDriverSupplyStore>)
    const wrapper = mount(DriverDrawer)

    expect(wrapper.find('[data-testid="driver-link-hint"]').text()).toContain('No availability record yet')
    expect(wrapper.find('[data-testid="driver-link-input"]').exists()).toBe(false)
  })

  it('shows the Simulation section only once the sim store is available, reading the current mode', async () => {
    const store = createStoreStub()
    mockedUseDriverSupplyStore.mockReturnValue(store as unknown as ReturnType<typeof useDriverSupplyStore>)
    const wrapper = mount(DriverDrawer)
    expect(wrapper.find('[data-testid="sim-drawer-section"]').exists()).toBe(false)

    useSimStore().$patch({
      available: true,
      state: { running: false, speed: 1, simMinutesAdvanced: 0, simNowMs: Date.now(), lastTickAt: null, drivers: [{ driverId: 'd1', mode: 'offroute', modeUntil: null, offsetLat: 0.1, offsetLng: 0, updatedAt: new Date().toISOString() }] },
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="sim-drawer-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="sim-current-mode"]').text()).toBe('Current mode: offroute')
  })
})
