import { defineStore } from 'pinia'
import { api } from '../lib/api'
import { extractApiErrorMessage } from '../lib/errors'
import type { DriverLocation } from '../types/dispatcher'

const DEFAULT_POLL_INTERVAL_MS = 8000

interface TrackingState {
  locations: DriverLocation[]
  loading: boolean
  error: string | null
  pollTimerId: number | null
}

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

    // Realtime here is polling, not the WebSocket — a dispatcher Bearer token
    // can't open the driver-only WS channel, so we refresh on an interval
    // instead. Kept thin (just the timer bookkeeping) so it's testable with
    // fake timers without mocking the whole browser timer API surface.
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
