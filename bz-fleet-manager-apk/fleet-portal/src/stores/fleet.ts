import { defineStore } from 'pinia'
import { api } from '../lib/api'
import { extractApiErrorMessage } from '../lib/errors'

// Fleet compliance & maintenance: every unit's clocks, the service-shop
// registry (map-ready), and the maintenance ledger. Logging a record
// refreshes the unit's clock server-side in the same transaction.

export interface FleetTractor {
  id: string
  unit: string
  make: string | null
  status: string
  lastLat: number | null
  lastLng: number | null
  inspectionExpiresAt: string | null
  registrationExpiresAt: string | null
  nextServiceAt: string | null
}

export interface FleetTrailer {
  id: string
  unit: string
  type: string
  status: string
  lastLat: number | null
  lastLng: number | null
  inspectionExpiresAt: string | null
  registrationExpiresAt: string | null
  nextServiceAt: string | null
}

export interface DigestItem {
  label: string
  kind: 'inspection' | 'registration' | 'service' | 'medical'
  at: string
  expired: boolean
}

export interface ComplianceDigest {
  items: DigestItem[]
  expiredCount: number
  dueSoonCount: number
}

export interface FleetDriver {
  id: string
  name: string
  medicalCertExpiresAt: string | null
}

export interface ServiceShop {
  id: string
  name: string
  address: string
  lat: number | null
  lng: number | null
  phone: string | null
}

export interface ServiceRecordRow {
  id: string
  kind: string
  notes: string | null
  performedAt: string
  nextDueAt: string | null
  shopName: string
  unit: string
}

export interface ServiceRecordInput {
  shopId: string
  tractorId?: string
  trailerId?: string
  kind: 'inspection' | 'registration' | 'service' | 'repair'
  notes?: string
  performedAt?: string
  nextDueAt?: string
}

interface FleetState {
  tractors: FleetTractor[]
  trailers: FleetTrailer[]
  drivers: FleetDriver[]
  shops: ServiceShop[]
  records: ServiceRecordRow[]
  digest: ComplianceDigest | null
  loading: boolean
  error: string | null
}

export const useFleetStore = defineStore('fleet', {
  state: (): FleetState => ({
    tractors: [],
    trailers: [],
    drivers: [],
    shops: [],
    records: [],
    digest: null,
    loading: false,
    error: null,
  }),

  actions: {
    async loadFleet(): Promise<void> {
      this.loading = true
      this.error = null
      try {
        const { data } = await api.get<{ tractors: FleetTractor[]; trailers: FleetTrailer[]; drivers: FleetDriver[] }>(
          '/dispatcher/fleet',
        )
        this.tractors = data.tractors
        this.trailers = data.trailers
        this.drivers = data.drivers
      } catch (error) {
        this.error = extractApiErrorMessage(error)
      } finally {
        this.loading = false
      }
    },

    /** Expired + 30-day compliance items for the board's digest card
     *  (auxiliary — a failure must never break the board). */
    async loadDigest(): Promise<void> {
      try {
        const { data } = await api.get<ComplianceDigest>('/dispatcher/fleet/digest')
        this.digest = data
      } catch {
        // auxiliary — never break the host view
      }
    },

    async loadShops(): Promise<void> {
      try {
        const { data } = await api.get<{ shops: ServiceShop[] }>('/dispatcher/fleet/services')
        this.shops = data.shops
      } catch (error) {
        this.error = extractApiErrorMessage(error)
      }
    },

    async loadRecords(): Promise<void> {
      try {
        const { data } = await api.get<{ records: ServiceRecordRow[] }>('/dispatcher/fleet/records')
        this.records = data.records
      } catch (error) {
        this.error = extractApiErrorMessage(error)
      }
    },

    async createShop(shop: { name: string; address: string; phone?: string }): Promise<boolean> {
      this.error = null
      try {
        await api.post('/dispatcher/fleet/services', shop)
        await this.loadShops()
        return true
      } catch (error) {
        this.error = extractApiErrorMessage(error)
        return false
      }
    },

    /** Log a service visit; the server refreshes the unit's compliance clock,
     *  so the fleet tables and the ledger both reload. */
    async logService(record: ServiceRecordInput): Promise<boolean> {
      this.error = null
      try {
        await api.post('/dispatcher/fleet/records', record)
        await Promise.all([this.loadFleet(), this.loadRecords()])
        return true
      } catch (error) {
        this.error = extractApiErrorMessage(error)
        return false
      }
    },
  },
})
