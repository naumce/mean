import { defineStore } from 'pinia'
import { api } from '../lib/api'
import { extractApiErrorMessage } from '../lib/errors'
import { subscribe } from '../lib/realtime'
import type { DriverLocation } from '../types/dispatcher'

const DEFAULT_POLL_INTERVAL_MS = 8000

interface TrackingState {
  locations: DriverLocation[]
  loading: boolean
  error: string | null
  pollTimerId: number | null
}

let unsubscribers: Array<() => void> = []

export const useTrackingStore = defineStore('tracking', {
  state: (): TrackingState => ({
    locations: [],
    loading: false,
    error: null,
    pollTimerId: null,
  }),

  actions: {
    async listLocations(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        const { data } = await api.get<DriverLocation[]>('/dispatcher/locations')
        this.locations = data
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to load driver locations right now.')
      } finally {
        this.loading = false
      }
    },

    /** Live map: `driver_location` frames upsert markers instantly; the polling
     *  in `startPolling` stays on as the fallback net, unchanged. */
    connectRealtime(): void {
      if (unsubscribers.length) return
      unsubscribers = [
        subscribe('driver_location', (frame) => {
          const driverId = typeof frame.driverId === 'string' ? frame.driverId : null
          const latitude = typeof frame.latitude === 'number' ? frame.latitude : null
          const longitude = typeof frame.longitude === 'number' ? frame.longitude : null
          if (!driverId || latitude === null || longitude === null) return
          const next: DriverLocation = {
            driverId,
            driverName: typeof frame.driverName === 'string' ? frame.driverName : undefined,
            latitude,
            longitude,
            createdAt: typeof frame.at === 'string' ? frame.at : new Date().toISOString(),
          }
          const known = this.locations.some((l) => l.driverId === driverId)
          this.locations = known
            ? this.locations.map((l) => (l.driverId === driverId ? next : l))
            : [...this.locations, next]
        }),
      ]
    },

    disconnectRealtime(): void {
      for (const off of unsubscribers) off()
      unsubscribers = []
    },

    // Polling stays as the reliability net under the WS push: it seeds the
    // initial marker set and heals any missed frames. Kept thin (just the
    // timer bookkeeping) so it's testable with fake timers.
    startPolling(intervalMs = DEFAULT_POLL_INTERVAL_MS): void {
      this.stopPolling()
      this.listLocations()
      this.pollTimerId = window.setInterval(() => {
        this.listLocations()
      }, intervalMs)
    },

    stopPolling(): void {
      if (this.pollTimerId !== null) {
        window.clearInterval(this.pollTimerId)
        this.pollTimerId = null
      }
    },
  },
})
