import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  api,
  fetchDriverAvailability,
  fetchDriverHistory,
  fetchDriverMetrics,
  fetchDriverPreference,
  patchDriverAvailability,
  patchDriverPreference,
} from '../lib/api'
import { subscribe, type Frame } from '../lib/realtime'
import { useDriverSupplyStore } from './driverSupply'
import type { DriverAvailabilityView, DriverProfile } from '../types/supply'

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  API_BASE_URL: 'http://localhost:3001/api',
  fetchDriverAvailability: vi.fn(),
  fetchDriverHistory: vi.fn(),
  fetchDriverMetrics: vi.fn(),
  fetchDriverPreference: vi.fn(),
  patchDriverAvailability: vi.fn(),
  patchDriverPreference: vi.fn(),
}))

vi.mock('../lib/realtime', () => ({ subscribe: vi.fn() }))

const mockedGet = vi.mocked(api.get)
const mockedFetchHistory = vi.mocked(fetchDriverHistory)
const mockedFetchMetrics = vi.mocked(fetchDriverMetrics)
const mockedFetchPreference = vi.mocked(fetchDriverPreference)
const mockedPatchAvailability = vi.mocked(patchDriverAvailability)
const mockedPatchPreference = vi.mocked(patchDriverPreference)
const mockedSubscribe = vi.mocked(subscribe)
const mockedFetchAvailability = vi.mocked(fetchDriverAvailability)

function profile(overrides: Partial<DriverProfile> = {}): DriverProfile {
  return {
    id: 'd1', name: 'Alice', firstName: 'Alice', lastName: 'A', phone: '555-0100',
    cdlClass: 'A', hazmatEndorsed: false, endorsements: [], equipmentTypes: ['DryVan'],
    languages: ['en'], preferredLanguage: 'en', homeBaseCity: 'Dallas', homeBaseState: 'TX',
    yearsExperience: 5, hos: null,
    ...overrides,
  }
}

function availability(overrides: Partial<DriverAvailabilityView> = {}): DriverAvailabilityView {
  return {
    driverId: 'd1', acceptingLoads: true, locationSharingEnabled: true, locationSharingUpdatedAt: null,
    shareToken: 'tok-1', status: 'AVAILABLE', availableAt: Date.now(),
    available: { lat: null, lng: null, city: null, state: null },
    current: { lat: 32.7, lng: -96.8, at: Date.parse('2026-09-24T00:00:00.000Z'), near: null },
    currentAssignment: null, source: 'manual',
    ...overrides,
  }
}

describe('useDriverSupplyStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedGet.mockReset()
    mockedFetchAvailability.mockReset()
    mockedFetchHistory.mockReset()
    mockedFetchMetrics.mockReset()
    mockedFetchPreference.mockReset()
    mockedPatchAvailability.mockReset()
    mockedPatchPreference.mockReset()
    mockedSubscribe.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts empty, not loading, no error', () => {
    const store = useDriverSupplyStore()
    expect(store.drivers).toEqual([])
    expect(store.rows).toEqual([])
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
  })

  describe('load', () => {
    it('fetches drivers + availability in parallel and merges them into rows', async () => {
      const alice = profile({ id: 'd1', name: 'Alice' })
      const bob = profile({ id: 'd2', name: 'Bob', equipmentTypes: ['Reefer'], languages: [], preferredLanguage: 'es', homeBaseState: 'CA' })
      mockedGet.mockResolvedValueOnce({ data: [alice, bob] })
      mockedFetchAvailability.mockResolvedValueOnce([
        availability({ driverId: 'd1', status: 'AVAILABLE' }),
        availability({ driverId: 'd2', status: 'ON_LOAD', locationSharingEnabled: false, current: null }),
      ])

      const store = useDriverSupplyStore()
      await store.load()

      expect(mockedGet).toHaveBeenCalledWith('/dispatcher/drivers')
      expect(store.drivers).toHaveLength(2)
      expect(store.rows.map((r) => r.driverId)).toEqual(['d1', 'd2']) // AVAILABLE sorts before ON_LOAD
      expect(store.error).toBeNull()
    })

    it('sets an error on failure', async () => {
      mockedGet.mockRejectedValueOnce({ isAxiosError: true, response: { status: 500, data: {} } })
      mockedFetchAvailability.mockResolvedValueOnce([])
      const store = useDriverSupplyStore()
      await store.load()
      expect(store.error).toBeTruthy()
    })

    it('a driver profile with no matching availability row gets safe UNAVAILABLE defaults', async () => {
      mockedGet.mockResolvedValueOnce({ data: [profile({ id: 'd9' })] })
      mockedFetchAvailability.mockResolvedValueOnce([])
      const store = useDriverSupplyStore()
      await store.load()
      expect(store.rows[0].status).toBe('UNAVAILABLE')
      expect(store.rows[0].current).toBeNull()
    })
  })

  describe('filters', () => {
    async function loadTwoDrivers() {
      const alice = profile({ id: 'd1', name: 'Alice', equipmentTypes: ['DryVan'], languages: ['en'] })
      const bob = profile({ id: 'd2', name: 'Bob', equipmentTypes: ['Reefer'], languages: ['es'], homeBaseState: 'CA' })
      mockedGet.mockResolvedValueOnce({ data: [alice, bob] })
      mockedFetchAvailability.mockResolvedValueOnce([
        availability({ driverId: 'd1', status: 'AVAILABLE', acceptingLoads: true }),
        availability({ driverId: 'd2', status: 'ON_LOAD', acceptingLoads: false }),
      ])
      const store = useDriverSupplyStore()
      await store.load()
      return store
    }

    it('narrows by status', async () => {
      const store = await loadTwoDrivers()
      store.setFilters({ statuses: ['ON_LOAD'] })
      expect(store.rows.map((r) => r.driverId)).toEqual(['d2'])
    })

    it('narrows by equipment', async () => {
      const store = await loadTwoDrivers()
      store.setFilters({ equipment: 'Reefer' })
      expect(store.rows.map((r) => r.driverId)).toEqual(['d2'])
    })

    it('narrows to accepting-loads-only', async () => {
      const store = await loadTwoDrivers()
      store.setFilters({ acceptingOnly: true })
      expect(store.rows.map((r) => r.driverId)).toEqual(['d1'])
    })
  })

  describe('mapLocations', () => {
    it('excludes a driver with locationSharingEnabled: false, even with a current ping', async () => {
      mockedGet.mockResolvedValueOnce({
        data: [profile({ id: 'd1', name: 'Alice' }), profile({ id: 'd2', name: 'Bob' })],
      })
      mockedFetchAvailability.mockResolvedValueOnce([
        availability({ driverId: 'd1', locationSharingEnabled: true }),
        availability({ driverId: 'd2', locationSharingEnabled: false, current: { lat: 1, lng: 2, at: Date.now(), near: null } }),
      ])
      const store = useDriverSupplyStore()
      await store.load()
      expect(store.mapLocations.map((l) => l.driverId)).toEqual(['d1'])
    })

    it('excludes a sharing-enabled driver with no current ping', async () => {
      mockedGet.mockResolvedValueOnce({ data: [profile({ id: 'd1' })] })
      mockedFetchAvailability.mockResolvedValueOnce([availability({ driverId: 'd1', locationSharingEnabled: true, current: null })])
      const store = useDriverSupplyStore()
      await store.load()
      expect(store.mapLocations).toEqual([])
    })
  })

  describe('connectRealtime', () => {
    // `unsubscribers` is a module-scope array (same pattern as
    // stores/tracking.ts), so it persists across tests in this file unless
    // each test that connects also disconnects.
    afterEach(() => {
      useDriverSupplyStore().disconnectRealtime()
    })

    it('patches availability[id].current on a driver_location frame for a known driver', async () => {
      mockedGet.mockResolvedValueOnce({ data: [profile({ id: 'd1' })] })
      mockedFetchAvailability.mockResolvedValueOnce([availability({ driverId: 'd1' })])
      const store = useDriverSupplyStore()
      await store.load()

      let handler: ((frame: Frame) => void) | undefined
      mockedSubscribe.mockImplementation((_type, h) => {
        handler = h
        return vi.fn()
      })
      store.connectRealtime()
      expect(mockedSubscribe).toHaveBeenCalledWith('driver_location', expect.any(Function))

      handler?.({ type: 'driver_location', driverId: 'd1', latitude: 40.1, longitude: -75.2, at: '2026-09-24T12:00:00.000Z' })

      expect(store.availability.d1.current).toEqual({ lat: 40.1, lng: -75.2, at: Date.parse('2026-09-24T12:00:00.000Z'), near: null })
    })

    it('ignores a frame for a driver not in this org and a malformed frame', async () => {
      mockedGet.mockResolvedValueOnce({ data: [profile({ id: 'd1' })] })
      mockedFetchAvailability.mockResolvedValueOnce([availability({ driverId: 'd1' })])
      const store = useDriverSupplyStore()
      await store.load()
      const before = store.availability.d1

      let handler: ((frame: Frame) => void) | undefined
      mockedSubscribe.mockImplementation((_type, h) => {
        handler = h
        return vi.fn()
      })
      store.connectRealtime()
      handler?.({ type: 'driver_location', driverId: 'stranger', latitude: 1, longitude: 2 })
      handler?.({ type: 'driver_location', driverId: 'd1' })

      expect(store.availability.d1).toBe(before)
    })

    it('does not open a second subscription on a repeat call', async () => {
      mockedSubscribe.mockReturnValue(vi.fn())
      const store = useDriverSupplyStore()
      store.connectRealtime()
      store.connectRealtime()
      expect(mockedSubscribe).toHaveBeenCalledTimes(1)
    })
  })

  describe('select / closeDrawer', () => {
    it('loads metrics, history, and preference for the selected driver', async () => {
      mockedFetchMetrics.mockResolvedValueOnce({
        driverId: 'd1', asOf: '2026-09-24T00:00:00.000Z', completedLoads: 10, onTimeLoads: 9, lateLoads: 1,
        onTimeRate: 0.9, averageDelayMinutes: 12, averageDetentionMinutes: null, averageResponseMinutes: 5,
        responseRate: 1, noResponseIncidents: 0, breakdownIncidents: 0, accidentIncidents: 0,
        loadsLast30Days: 3, nightLoads: 1, laneExperience: [], evidence: { assignments: 10, agentTrips: 2, agentEvents: 5 },
      })
      mockedFetchHistory.mockResolvedValueOnce([])
      mockedFetchPreference.mockResolvedValueOnce({
        maxTripMiles: null, preferredRegions: [], preferredLanes: [], avoidRegions: [], avoidLanes: [],
        homeTimeTarget: null, willingToDriveNight: true, willingToRelocateMiles: null, preferredEquipment: [],
      })

      const store = useDriverSupplyStore()
      await store.select('d1')

      expect(store.selectedDriverId).toBe('d1')
      expect(mockedFetchHistory).toHaveBeenCalledWith('d1', 10)
      expect(store.drawer.metrics?.completedLoads).toBe(10)
      expect(store.drawer.loading).toBe(false)

      store.closeDrawer()
      expect(store.selectedDriverId).toBeNull()
      expect(store.drawer.metrics).toBeNull()
    })

    it('sets drawer.error on failure', async () => {
      mockedFetchMetrics.mockRejectedValueOnce({ isAxiosError: true, response: { status: 500, data: {} } })
      mockedFetchHistory.mockResolvedValueOnce([])
      mockedFetchPreference.mockResolvedValueOnce({
        maxTripMiles: null, preferredRegions: [], preferredLanes: [], avoidRegions: [], avoidLanes: [],
        homeTimeTarget: null, willingToDriveNight: true, willingToRelocateMiles: null, preferredEquipment: [],
      })
      const store = useDriverSupplyStore()
      await store.select('d1')
      expect(store.drawer.error).toBeTruthy()
      expect(store.drawer.loading).toBe(false)
    })
  })

  describe('updateAvailability', () => {
    it('sends the PATCH body and replaces that driver\'s availability', async () => {
      mockedGet.mockResolvedValueOnce({ data: [profile({ id: 'd1' })] })
      mockedFetchAvailability.mockResolvedValueOnce([availability({ driverId: 'd1', status: 'AVAILABLE' })])
      const store = useDriverSupplyStore()
      await store.load()

      mockedPatchAvailability.mockResolvedValueOnce(availability({ driverId: 'd1', status: 'OFF_DUTY' }))
      const ok = await store.updateAvailability('d1', { availabilityStatus: 'OFF_DUTY' })

      expect(ok).toBe(true)
      expect(mockedPatchAvailability).toHaveBeenCalledWith('d1', { availabilityStatus: 'OFF_DUTY' })
      expect(store.availability.d1.status).toBe('OFF_DUTY')
    })

    it('returns false and sets error on failure', async () => {
      mockedPatchAvailability.mockRejectedValueOnce({ isAxiosError: true, response: { status: 500, data: {} } })
      const store = useDriverSupplyStore()
      const ok = await store.updateAvailability('d1', { acceptingLoads: true })
      expect(ok).toBe(false)
      expect(store.error).toBeTruthy()
    })
  })

  describe('updatePreference', () => {
    it('sends the PATCH body and replaces the drawer preference', async () => {
      const store = useDriverSupplyStore()
      mockedPatchPreference.mockResolvedValueOnce({
        maxTripMiles: 500, preferredRegions: [], preferredLanes: [], avoidRegions: [], avoidLanes: [],
        homeTimeTarget: null, willingToDriveNight: true, willingToRelocateMiles: null, preferredEquipment: [],
      })
      const ok = await store.updatePreference('d1', { maxTripMiles: 500 })
      expect(ok).toBe(true)
      expect(mockedPatchPreference).toHaveBeenCalledWith('d1', { maxTripMiles: 500 })
      expect(store.drawer.preference?.maxTripMiles).toBe(500)
    })
  })

  describe('polling', () => {
    it('startPolling refreshes availability immediately then on the interval; stopPolling halts it', async () => {
      vi.useFakeTimers()
      mockedFetchAvailability.mockResolvedValue([availability({ driverId: 'd1' })])

      const store = useDriverSupplyStore()
      store.startPolling(30_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(mockedFetchAvailability).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(30_000)
      expect(mockedFetchAvailability).toHaveBeenCalledTimes(2)

      store.stopPolling()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(mockedFetchAvailability).toHaveBeenCalledTimes(2)
    })
  })
})
