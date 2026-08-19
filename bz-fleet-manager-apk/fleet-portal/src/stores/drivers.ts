import { defineStore } from 'pinia'
import { api } from '../lib/api'
import { extractApiErrorMessage } from '../lib/errors'
import type { Driver, DriverCreatePayload, DriverUpdatePayload } from '../types/fleet'

interface DriversState {
  items: Driver[]
  loading: boolean
  error: string | null
}

export const useDriversStore = defineStore('drivers', {
  state: (): DriversState => ({
    items: [],
    loading: false,
    error: null,
  }),

  actions: {
    async list(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        const { data } = await api.get<Driver[]>('/dispatcher/drivers')
        this.items = data
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to load drivers right now.')
      } finally {
        this.loading = false
      }
    },

    async create(payload: DriverCreatePayload): Promise<void> {
      this.loading = true
      this.error = null
      try {
        await api.post('/dispatcher/drivers', payload)
        await this.list()
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to create the driver right now.')
        this.loading = false
        throw error
      }
    },

    async update(id: string, payload: DriverUpdatePayload): Promise<void> {
      this.loading = true
      this.error = null
      try {
        await api.put(`/dispatcher/drivers/${id}`, payload)
        await this.list()
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to update the driver right now.')
        this.loading = false
        throw error
      }
    },
  },
})
