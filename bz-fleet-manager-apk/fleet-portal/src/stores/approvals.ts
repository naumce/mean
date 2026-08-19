import { defineStore } from 'pinia'
import { api } from '../lib/api'
import { extractApiErrorMessage } from '../lib/errors'
import type { SignsProof, Trip } from '../types/dispatcher'

interface ApprovalsState {
  pendingTrips: Trip[]
  pendingProofs: SignsProof[]
  loading: boolean
  error: string | null
}

export const useApprovalsStore = defineStore('approvals', {
  state: (): ApprovalsState => ({
    pendingTrips: [],
    pendingProofs: [],
    loading: false,
    error: null,
  }),

  actions: {
    async listTrips(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        const { data } = await api.get<Trip[]>('/dispatcher/approvals/trips')
        this.pendingTrips = data
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to load pending trip approvals right now.')
      } finally {
        this.loading = false
      }
    },

    async approveTrip(id: string): Promise<void> {
      this.loading = true
      this.error = null
      try {
        await api.post(`/dispatcher/trips/${id}/approve`)
        await this.listTrips()
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to approve the trip right now.')
        this.loading = false
        throw error
      }
    },

    async rejectTrip(id: string, reason: string): Promise<void> {
      this.loading = true
      this.error = null
      try {
        await api.post(`/dispatcher/trips/${id}/reject`, { reason })
        await this.listTrips()
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to reject the trip right now.')
        this.loading = false
        throw error
      }
    },

    async listSignsProof(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        const { data } = await api.get<SignsProof[]>('/dispatcher/approvals/signs-proof')
        this.pendingProofs = data
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to load pending signs-proof approvals right now.')
      } finally {
        this.loading = false
      }
    },

    async approveProof(id: string): Promise<void> {
      this.loading = true
      this.error = null
      try {
        await api.post(`/dispatcher/signs-proof/${id}/approve`)
        await this.listSignsProof()
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to approve the signs-proof right now.')
        this.loading = false
        throw error
      }
    },

    async rejectProof(id: string, reason: string): Promise<void> {
      this.loading = true
      this.error = null
      try {
        await api.post(`/dispatcher/signs-proof/${id}/reject`, { reason })
        await this.listSignsProof()
      } catch (error) {
        this.error = extractApiErrorMessage(error, 'Unable to reject the signs-proof right now.')
        this.loading = false
        throw error
      }
    },
  },
})
