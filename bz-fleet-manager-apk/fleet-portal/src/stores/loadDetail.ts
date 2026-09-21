import { defineStore } from 'pinia'
import { api } from '../lib/api'
import { extractApiErrorMessage } from '../lib/errors'

// Load detail/edit (Control Tower screen 3). Fetches one load in full and
// saves edits; the server refuses edits unless the load is open.

export interface DetailAppointment {
  windowStart: string | null
  windowEnd: string
  type: string
}

export interface DetailStop {
  sequence: number
  type: 'pickup' | 'delivery' | 'intermediate'
  address: string
  lat: number | null
  lng: number | null
  dwellMin: number | null
  appointment: DetailAppointment | null
}

export interface LoadDetail {
  id: string
  externalId: string | null
  status: string
  requiredEquip: string
  hazmatClass: string | null
  commodity: string | null
  brokerName: string | null
  weightLbs: number | null
  revenueCents: number
  fscCents: number
  stops: DetailStop[]
  assignment: { id: string; driver: { id: string; name: string } } | null
  rate: { marginCents: number; ratePerLoadedMiCents: number; deadheadMi: number } | null
}

export interface LoadPatch {
  requiredEquip?: string
  revenueCents?: number
  fscCents?: number
  hazmatClass?: string | null
  commodity?: string | null
  brokerName?: string | null
  weightLbs?: number | null
  stops?: Array<{
    sequence: number
    type: 'pickup' | 'delivery' | 'intermediate'
    address: string
    lat?: number | null
    lng?: number | null
    dwellMin?: number | null
    windowStart?: string | null
    windowEnd?: string | null
  }>
}

interface LoadDetailState {
  detail: LoadDetail | null
  loading: boolean
  saving: boolean
  error: string | null
}

export const useLoadDetailStore = defineStore('loadDetail', {
  state: (): LoadDetailState => ({
    detail: null,
    loading: false,
    saving: false,
    error: null,
  }),

  actions: {
    async open(loadId: string): Promise<void> {
      this.loading = true
      this.error = null
      try {
        const { data } = await api.get<LoadDetail>(`/dispatcher/loads/${loadId}`)
        this.detail = data
      } catch (error) {
        this.error = extractApiErrorMessage(error)
      } finally {
        this.loading = false
      }
    },

    close(): void {
      this.detail = null
      this.error = null
    },

    async save(patch: LoadPatch): Promise<boolean> {
      if (!this.detail) return false
      this.saving = true
      this.error = null
      try {
        const { data } = await api.patch<LoadDetail>(`/dispatcher/loads/${this.detail.id}`, patch)
        this.detail = { ...this.detail, ...data }
        return true
      } catch (error) {
        this.error = extractApiErrorMessage(error)
        return false
      } finally {
        this.saving = false
      }
    },
  },
})
