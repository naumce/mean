import { defineStore } from 'pinia'
import { api } from '../lib/api'
import { extractApiErrorMessage } from '../lib/errors'
import type { Trip, TripCreatePayload, TripListFilters } from '../types/dispatcher'

interface TripsState {
  items: Trip[]
  current: Trip | null
  loading: boolean
  error: string | null
}

export const useTripsStore = defineStore('trips', {
  state: (): TripsState => ({
    items: [],
    current: null,
    loading: false,
    error: null,
  }),

  actions: {
    async list(filters?: TripListFilters): Promise<void> {
      this.loading = true
      this.error = null
      try {
        const { data } = filters
          ? await api.get<Trip[]>('/dispatcher/trips', { params: filters })
          : await api.get<Trip[]>('/dispatcher/trips')
        this.items = data
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to load trips right now.')
      } finally {
        this.loading = false
      }
    },

    async get(id: string): Promise<void> {
      this.loading = true
      this.error = null
      try {
        const { data } = await api.get<Trip>(`/dispatcher/trips/${id}`)
        this.current = data
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to load the trip right now.')
      } finally {
        this.loading = false
      }
    },

    async create(payload: TripCreatePayload): Promise<void> {
      this.loading = true
      this.error = null
      try {
        await api.post('/dispatcher/trips', payload)
        await this.list()
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to create the trip right now.')
        this.loading = false
        throw error
      }
    },

    async assign(id: string, driverId: string): Promise<void> {
      this.loading = true
      this.error = null
      try {
        await api.post(`/dispatcher/trips/${id}/assign`, { driverId })
        await this.list()
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to assign the driver right now.')
        this.loading = false
        throw error
      }
    },
  },
})
