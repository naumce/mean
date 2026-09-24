import { defineStore } from 'pinia'
import {
  api,
  fetchDriverAvailability,
  fetchDriverHistory,
  fetchDriverMetrics,
  fetchDriverPreference,
  patchDriverAvailability,
  patchDriverPreference,
} from '../lib/api'
import { extractApiErrorMessage } from '../lib/errors'
import { subscribe } from '../lib/realtime'
import { STATUS_ORDER, driverLanguages } from '../lib/supplyFormat'
import type { DriverLocation } from '../types/dispatcher'
import type {
  CurrentPing,
  DriverAvailabilityView,
  DriverHistoryRow,
  DriverMetrics,
  DriverPreference,
  DriverProfile,
  DriverSupplyFilters,
  PatchAvailabilityBody,
  PatchPreferenceBody,
  SupplyDriver,
} from '../types/supply'

const DEFAULT_POLL_INTERVAL_MS = 30_000
const HISTORY_LIMIT = 10

interface DrawerState {
  metrics: DriverMetrics | null
  history: DriverHistoryRow[]
  preference: DriverPreference | null
  loading: boolean
  error: string | null
}

interface DriverSupplyState {
  drivers: SupplyDriver[]
  availability: Record<string, DriverAvailabilityView>
  filters: DriverSupplyFilters
  selectedDriverId: string | null
  drawer: DrawerState
  loading: boolean
  error: string | null
  pollTimerId: number | null
}

function emptyDrawer(): DrawerState {
  return { metrics: null, history: [], preference: null, loading: false, error: null }
}

/** A driver with no DriverAvailability row at all yet — same defaults
 *  fleet-backend's own toView() falls back to, so a freshly created driver
 *  renders identically here and in the API before their first PATCH. */
function defaultAvailability(driverId: string): DriverAvailabilityView {
  return {
    driverId,
    acceptingLoads: false,
    locationSharingEnabled: false,
    locationSharingUpdatedAt: null,
    shareToken: null,
    status: 'UNAVAILABLE',
    availableAt: Date.now(),
    available: { lat: null, lng: null, city: null, state: null },
    current: null,
    currentAssignment: null,
    source: 'none',
  }
}

/** Every row this store renders is a profile joined with that driver's
 *  availability, re-derived on every read (never stored pre-merged) so a
 *  realtime patch or a poll tick — both of which only ever replace
 *  `state.availability` — is instantly reflected without also having to
 *  walk and patch `state.drivers`. */
function mergedDrivers(state: DriverSupplyState): SupplyDriver[] {
  return state.drivers.map((d) => ({ ...d, ...(state.availability[d.driverId] ?? {}) }))
}

// Style A (module-scope handle array, lib/tracking.ts's own convention):
// Driver Supply is read-mostly like Tracking (availability pushed from
// drivers' phones/dispatcher edits) and the 30s poll below is already the
// reliability net, so a reconnect never needs the stricter "resync from a
// snapshot" handling stores/loadLocks.ts's Style B exists for.
let unsubscribers: Array<() => void> = []

export const useDriverSupplyStore = defineStore('driverSupply', {
  state: (): DriverSupplyState => ({
    drivers: [],
    availability: {},
    filters: { statuses: [], equipment: null, language: null, state: null, acceptingOnly: false },
    selectedDriverId: null,
    drawer: emptyDrawer(),
    loading: false,
    error: null,
    pollTimerId: null,
  }),

  getters: {
    rows(state): SupplyDriver[] {
      const f = state.filters
      const filtered = mergedDrivers(state).filter((d) => {
        if (f.statuses.length > 0 && !f.statuses.includes(d.status)) return false
        if (f.equipment && !d.equipmentTypes.includes(f.equipment)) return false
        if (f.language && !driverLanguages(d).includes(f.language)) return false
        if (f.state && d.homeBaseState !== f.state) return false
        if (f.acceptingOnly && !d.acceptingLoads) return false
        return true
      })
      return [...filtered].sort(
        (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name),
      )
    },

    mapLocations(state): DriverLocation[] {
      const withPing: Array<{ driverId: string; name: string; current: CurrentPing }> = []
      for (const d of mergedDrivers(state)) {
        if (d.locationSharingEnabled && d.current) withPing.push({ driverId: d.driverId, name: d.name, current: d.current })
      }
      return withPing.map((d) => ({
        driverId: d.driverId,
        driverName: d.name,
        latitude: d.current.lat,
        longitude: d.current.lng,
        createdAt: new Date(d.current.at).toISOString(),
      }))
    },

    filterOptions(state): { equipment: string[]; languages: string[]; states: string[] } {
      const equipment = new Set<string>()
      const languages = new Set<string>()
      const states = new Set<string>()
      for (const d of state.drivers) {
        for (const e of d.equipmentTypes) equipment.add(e)
        for (const l of driverLanguages(d)) languages.add(l)
        if (d.homeBaseState) states.add(d.homeBaseState)
      }
      return { equipment: [...equipment].sort(), languages: [...languages].sort(), states: [...states].sort() }
    },
  },

  actions: {
    /** Drivers list (Task 1 profile) + availability (Task 2), in parallel —
     *  the profile list rarely changes, so only availability is re-polled
     *  afterwards (see pollAvailability/startPolling below). */
    async load(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        const [{ data: profiles }, availabilityList] = await Promise.all([
          api.get<DriverProfile[]>('/dispatcher/drivers'),
          fetchDriverAvailability(),
        ])
        const byId: Record<string, DriverAvailabilityView> = {}
        for (const a of availabilityList) byId[a.driverId] = a
        this.availability = byId
        this.drivers = profiles.map((p) => ({ ...p, ...(byId[p.id] ?? defaultAvailability(p.id)) }))
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to load driver supply right now.')
      } finally {
        this.loading = false
      }
    },

    async pollAvailability(): Promise<void> {
      try {
        const list = await fetchDriverAvailability()
        const byId: Record<string, DriverAvailabilityView> = {}
        for (const a of list) byId[a.driverId] = a
        this.availability = byId
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to refresh driver availability right now.')
      }
    },

    startPolling(intervalMs = DEFAULT_POLL_INTERVAL_MS): void {
      this.stopPolling()
      void this.pollAvailability()
      this.pollTimerId = window.setInterval(() => {
        void this.pollAvailability()
      }, intervalMs)
    },

    stopPolling(): void {
      if (this.pollTimerId !== null) {
        window.clearInterval(this.pollTimerId)
        this.pollTimerId = null
      }
    },

    /** Live map: `driver_location` frames patch just that driver's ping. The
     *  30s poll above stays on as the reliability net, unchanged. */
    connectRealtime(): void {
      if (unsubscribers.length) return
      unsubscribers = [
        subscribe('driver_location', (frame) => {
          const driverId = typeof frame.driverId === 'string' ? frame.driverId : null
          const latitude = typeof frame.latitude === 'number' ? frame.latitude : null
          const longitude = typeof frame.longitude === 'number' ? frame.longitude : null
          if (!driverId || latitude === null || longitude === null) return
          const existing = this.availability[driverId]
          if (!existing) return // unknown driver — nothing in this org to patch
          const at = typeof frame.at === 'string' ? Date.parse(frame.at) : Date.now()
          this.availability = {
            ...this.availability,
            [driverId]: {
              ...existing,
              // `near` is a server-side gazetteer lookup this frame doesn't
              // carry; keeping the previous value is closer to the truth
              // between ticks than dropping it, and the next 30s poll
              // replaces it with the freshly computed one regardless.
              current: { lat: latitude, lng: longitude, at, near: existing.current?.near ?? null },
            },
          }
        }),
      ]
    },

    disconnectRealtime(): void {
      for (const off of unsubscribers) off()
      unsubscribers = []
    },

    setFilters(partial: Partial<DriverSupplyFilters>): void {
      this.filters = { ...this.filters, ...partial }
    },

    /** Opens the drawer on `driverId` and loads its metrics/history/
     *  preference in parallel. Pair: closeDrawer() below. */
    async select(driverId: string): Promise<void> {
      this.selectedDriverId = driverId
      this.drawer = { ...emptyDrawer(), loading: true }
      try {
        const [metrics, history, preference] = await Promise.all([
          fetchDriverMetrics(driverId),
          fetchDriverHistory(driverId, HISTORY_LIMIT),
          fetchDriverPreference(driverId),
        ])
        this.drawer = { metrics, history, preference, loading: false, error: null }
      } catch (error) {
        this.drawer = {
          ...emptyDrawer(),
          loading: false,
          error: extractApiErrorMessage(error, 'Unable to load this driver right now.'),
        }
      }
    },

    closeDrawer(): void {
      this.selectedDriverId = null
      this.drawer = emptyDrawer()
    },

    async updateAvailability(driverId: string, body: PatchAvailabilityBody): Promise<boolean> {
      try {
        const updated = await patchDriverAvailability(driverId, body)
        this.availability = { ...this.availability, [driverId]: updated }
        return true
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to update availability right now.')
        return false
      }
    },

    async updatePreference(driverId: string, body: PatchPreferenceBody): Promise<boolean> {
      try {
        const updated = await patchDriverPreference(driverId, body)
        this.drawer = { ...this.drawer, preference: updated }
        return true
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to update preferences right now.')
        return false
      }
    },
  },
})
