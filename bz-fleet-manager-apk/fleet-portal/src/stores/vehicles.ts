import { defineStore } from 'pinia'
import { api } from '../lib/api'
import { extractApiErrorMessage } from '../lib/errors'
import type { Vehicle, VehicleCreatePayload, VehicleUpdatePayload } from '../types/fleet'

interface VehiclesState {
  items: Vehicle[]
  loading: boolean
  error: string | null
}

export const useVehiclesStore = defineStore('vehicles', {
  state: (): VehiclesState => ({
    items: [],
    loading: false,
    error: null,
  }),

  actions: {
    async list(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        const { data } = await api.get<Vehicle[]>('/dispatcher/vehicles')
        this.items = data
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to load vehicles right now.')
      } finally {
        this.loading = false
      }
    },

    async create(payload: VehicleCreatePayload): Promise<void> {
      this.loading = true
      this.error = null
      try {
        await api.post('/dispatcher/vehicles', payload)
        await this.list()
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to create the vehicle right now.')
        this.loading = false
        throw error
      }
    },

    async update(id: string, payload: VehicleUpdatePayload): Promise<void> {
      this.loading = true
      this.error = null
      try {
        await api.put(`/dispatcher/vehicles/${id}`, payload)
        await this.list()
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to update the vehicle right now.')
        this.loading = false
        throw error
      }
    },

    async assign(id: string, driverId: string): Promise<void> {
      this.loading = true
      this.error = null
      try {
        await api.post(`/dispatcher/vehicles/${id}/assign`, { driverId })
        await this.list()
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to assign the driver right now.')
        this.loading = false
        throw error
      }
    },
  },
})
